import asyncio
import json
import math
import os
import secrets
import sqlite3
import uuid
from contextlib import asynccontextmanager, closing, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.auth import decode_access_token, get_current_username
from backend.permissions import get_device_role, initialize_permissions, require_device_role
from backend.users import DB_PATH, bootstrap_admin, get_user, initialize_users, migrate_auth_database
from backend.alerts.rules import initialize_alert_rules
from backend.alerts.engine import evaluate_telemetry
from backend.auth_routes import router as auth_router
from backend.permission_routes import router as permission_router
from backend.alerts.routes import router as alert_router

RETENTION_SECONDS = 14 * 24 * 60 * 60
BRIDGE_TOKEN = os.environ.get("JANUS_BRIDGE_TOKEN")
if not BRIDGE_TOKEN:
    raise RuntimeError("JANUS_BRIDGE_TOKEN must be set before starting the server")
bridges = {}
online = set()
dashboards = {}


def expire_readings():
    cutoff = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() - RETENTION_SECONDS, timezone.utc)
    with closing(sqlite3.connect(DB_PATH)) as db, db:
        db.execute("DELETE FROM telemetry WHERE julianday(received_at) < julianday(?)", (cutoff.isoformat(),))


async def cleanup_daily():
    while True:
        await asyncio.sleep(24 * 60 * 60)
        await asyncio.to_thread(expire_readings)


@asynccontextmanager
async def lifespan(app):
    initialize_users()
    initialize_permissions()
    initialize_alert_rules()
    migrate_auth_database()
    bootstrap_admin()
    with closing(sqlite3.connect(DB_PATH)) as db, db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                schema_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS telemetry (
                id INTEGER PRIMARY KEY,
                device_id TEXT NOT NULL,
                received_at TEXT NOT NULL,
                data_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS telemetry_device_time ON telemetry(device_id, received_at);
        """)
    expire_readings()
    cleanup = asyncio.create_task(cleanup_daily())
    try:
        yield
    finally:
        cleanup.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup


app = FastAPI(title="Janus", lifespan=lifespan)
app.include_router(auth_router)
app.include_router(permission_router)
app.include_router(alert_router)

root = Path(__file__).resolve().parents[1]
app.mount("/frontend", StaticFiles(directory=root / "frontend"), name="frontend")
app.mount("/schemas", StaticFiles(directory=root / "schemas"), name="schemas")


@app.get("/", include_in_schema=False)
async def dashboard():
    return FileResponse(root / "frontend" / "index.html")


class NumericField(BaseModel):
    type: Literal["number"]
    label: str
    unit: str
    min: float = Field(strict=True, allow_inf_nan=False)
    max: float = Field(strict=True, allow_inf_nan=False)


class DeviceCommand(BaseModel):
    label: str
    args: dict[str, NumericField]


class DeviceSchema(BaseModel):
    device_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str
    rate_hz: float = Field(gt=0, strict=True, allow_inf_nan=False)
    telemetry: dict[str, NumericField] = Field(min_length=1)
    commands: dict[str, DeviceCommand]


class Command(BaseModel):
    name: str
    args: dict = Field(default_factory=dict)


def require_admin(username: str = Depends(get_current_username)):
    user = get_user(username)
    if user is None:
        raise HTTPException(401, "User not found")
    if not user["is_admin"]:
        raise HTTPException(403, "Administrator permission required")


def device_schema(device_id):
    with closing(sqlite3.connect(DB_PATH)) as db:
        row = db.execute("SELECT schema_json FROM devices WHERE device_id = ?", (device_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Device not found")
    return json.loads(row[0])


@app.get("/api/devices/{device_id}/schema")
def read_schema(device_id: str, username: str = Depends(get_current_username)):
    require_device_role(username, device_id, "viewer")
    return device_schema(device_id)


@app.post("/api/devices", status_code=201, dependencies=[Depends(require_admin)])
async def register_device(schema: DeviceSchema):
    fields = list(schema.telemetry.values())
    for command in schema.commands.values():
        fields.extend(command.args.values())
    if any(field.min > field.max for field in fields):
        raise HTTPException(status_code=422, detail="Field min must be at or below max")

    with closing(sqlite3.connect(DB_PATH)) as db, db:
        result = db.execute(
            "INSERT INTO devices VALUES (?, ?) ON CONFLICT(device_id) DO NOTHING",
            (schema.device_id, schema.model_dump_json()),
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=409, detail="Device is already registered")
    return {"id": schema.device_id}


@app.delete("/api/devices/{device_id}", dependencies=[Depends(require_admin)])
async def remove_device(device_id: str):
    with closing(sqlite3.connect(DB_PATH)) as db, db:
        if not db.execute("DELETE FROM devices WHERE device_id = ?", (device_id,)).rowcount:
            raise HTTPException(404, "Device not found")
        db.execute("DELETE FROM telemetry WHERE device_id = ?", (device_id,))
        db.execute("DELETE FROM device_permissions WHERE device_id = ?", (device_id,))
        db.execute("DELETE FROM alert_rules WHERE device_id = ?", (device_id,))
        db.execute("DELETE FROM alert_history WHERE device_id = ?", (device_id,))
    bridge = bridges.pop(device_id, None)
    online.discard(device_id)
    if bridge is not None:
        with suppress(WebSocketDisconnect, RuntimeError, OSError):
            await bridge.close(code=1008)
    return {"ok": True}


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@app.get("/api/devices/{device_id}/telemetry")
def history(
    device_id: str, start: float, end: float, fields: list[str] = Query(),
    username: str = Depends(get_current_username),
):
    require_device_role(username, device_id, "viewer")
    schema = device_schema(device_id)
    if not fields or set(fields) - schema["telemetry"].keys():
        raise HTTPException(422, "Choose fields from the device schema")
    if not (math.isfinite(start) and math.isfinite(end) and 0 < end - start <= RETENTION_SECONDS):
        raise HTTPException(422, "Choose a valid time range of up to 14 days")

    step = max((end - start) / 600, 0.1)
    with closing(sqlite3.connect(DB_PATH)) as db:
        rows = db.execute("""
            WITH readings AS (
                SELECT ROUND((julianday(received_at) - 2440587.5) * 86400, 3) AS timestamp, data_json
                FROM telemetry WHERE device_id = ? AND received_at BETWEEN ? AND ?
            )
            SELECT MIN(timestamp) AS timestamp, data_json FROM readings
            WHERE timestamp BETWEEN ? AND ?
            GROUP BY CAST((timestamp - ?) / ? AS INTEGER)
            ORDER BY timestamp
        """, (device_id, iso(start), iso(end), start, end, start, step)).fetchall()

    samples = []
    for timestamp, encoded in rows:
        data = json.loads(encoded)
        samples.append({"timestamp": timestamp, "data": {field: data.get(field) for field in fields}})
    return {"samples": samples}


def values_match(data, fields):
    if not isinstance(data, dict) or data.keys() != fields.keys():
        return False
    return all(
        type(value) in (int, float) and fields[name]["min"] <= value <= fields[name]["max"]
        for name, value in data.items()
    )


def save_reading(db, msg, fields):
    data = msg.get("data")
    timestamp = msg.get("received_at")
    if not isinstance(timestamp, str) or not values_match(data, fields):
        return False
    db.execute(
        "INSERT INTO telemetry (device_id, received_at, data_json) VALUES (?, ?, ?)",
        (msg["device_id"], timestamp, json.dumps(data)),
    )
    return True


async def broadcast(msg: dict):
    for ws, token in list(dashboards.items()):
        try:
            username = decode_access_token(token)
        except HTTPException:
            dashboards.pop(ws, None)
            with suppress(WebSocketDisconnect, RuntimeError, OSError):
                await ws.close(code=1008)
            continue
        try:
            require_device_role(username, msg["device_id"], "viewer")
        except HTTPException:
            continue
        try:
            await ws.send_json(msg)
        except (WebSocketDisconnect, RuntimeError, OSError):
            dashboards.pop(ws, None)


@app.websocket("/ws/bridge")
async def bridge_socket(ws: WebSocket):
    if not secrets.compare_digest(ws.query_params.get("token", ""), BRIDGE_TOKEN):
        await ws.close(code=1008)
        return
    await ws.accept()
    device_id = None
    try:
        while True:
            try:
                msg = await ws.receive_json()
            except (ValueError, KeyError):
                continue
            if not isinstance(msg, dict) or not isinstance(msg.get("device_id"), str):
                continue
            incoming_id = msg["device_id"]
            if device_id is not None and (device_id != incoming_id or bridges.get(device_id) is not ws):
                continue

            kind = msg.get("type")
            with closing(sqlite3.connect(DB_PATH)) as db, db:
                row = db.execute(
                    "SELECT schema_json FROM devices WHERE device_id = ?", (incoming_id,)
                ).fetchone()
                if row is None:
                    continue
                if kind == "telemetry":
                    if not save_reading(db, msg, json.loads(row[0])["telemetry"]):
                        continue
                    online.add(incoming_id)
                elif kind == "status" and isinstance(msg.get("connected"), bool):
                    if msg["connected"]:
                        online.add(incoming_id)
                    else:
                        online.discard(incoming_id)
                elif kind != "ack" or device_id is None:
                    continue
            device_id = incoming_id
            bridges[device_id] = ws
            await broadcast(msg)
            if kind == "telemetry":
                alerts = evaluate_telemetry(device_id, msg["data"])
                for alert in alerts:
                    await broadcast(alert)
    except WebSocketDisconnect:
        pass
    finally:
        if device_id is not None and bridges.get(device_id) is ws:
            del bridges[device_id]
            online.discard(device_id)
            await broadcast({"type": "status", "device_id": device_id, "connected": False})


@app.websocket("/ws/live")
async def live_socket(ws: WebSocket):
    token = ws.query_params.get("token", "")
    try:
        username = decode_access_token(token)
        if get_user(username) is None:
            raise HTTPException(401, "User not found")
    except HTTPException:
        await ws.close(code=1008)
        return
    await ws.accept()
    dashboards[ws] = token
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        dashboards.pop(ws, None)


@app.get("/api/devices")
async def list_devices(username: str = Depends(get_current_username)):
    user = get_user(username)
    if user is None:
        raise HTTPException(401, "User not found")
    with closing(sqlite3.connect(DB_PATH)) as db:
        rows = db.execute("SELECT device_id, schema_json FROM devices ORDER BY device_id").fetchall()
    details = {}
    for device_id, schema in rows:
        role = "admin" if user["is_admin"] else get_device_role(username, device_id)
        if role:
            details[device_id] = {
                "name": json.loads(schema)["name"],
                "connected": device_id in online,
                "role": role,
            }
    return {"devices": [device_id for device_id in details if details[device_id]["connected"]],
            "device_details": details}


@app.post("/api/devices/{device_id}/commands")
async def send_command(
    device_id: str,
    command: Command,
    username: str = Depends(get_current_username),
):

    require_device_role(username, device_id, "operator")
    command_schema = device_schema(device_id)["commands"].get(command.name)
    if command_schema is None or not values_match(command.args, command_schema["args"]):
        raise HTTPException(422, "Command or arguments do not match the device schema")

    ws = bridges.get(device_id)
    if ws is None or device_id not in online:
        raise HTTPException(status_code=404, detail=f"device {device_id} is not connected")
    msg = {"type": "command", "id": f"c-{uuid.uuid4().hex[:8]}", "name": command.name, "args": command.args}
    await ws.send_json(msg)
    return {"id": msg["id"]}
