import json
import sys
from datetime import datetime, timezone
from device_link import open_device, read_lines

def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def parse_line(line: str):
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(msg, dict):
        return None
    if msg.get("type") == "telemetry" and isinstance(msg.get("data"), dict):
        return msg
    if msg.get("type") == "ack" and "id" in msg and isinstance(msg.get("ok"), bool):
        return msg
    return None

def envelope(msg: dict, device_id: str):
    out = {"type": msg["type"], "device_id": device_id, "received_at": now()}
    for key, value in msg.items():
        if key == "type":
            continue
        out["device_t" if key == "t" else key] = value
    return out

def status(device_id: str, connected: bool):
    return {"type": "status", "device_id": device_id, "received_at": now(), "connected": connected}

def parse_command(text: str):
    try:
        msg = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(msg, dict) or msg.get("type") != "command":
        return None
    if not isinstance(msg.get("id"), str) or not isinstance(msg.get("name"), str):
        return None
    if not isinstance(msg.get("args", {}), dict):
        return None
    return json.dumps(msg)

if __name__ == "__main__":
    with open_device(sys.argv[1]) as device:
        for line in read_lines(device):
            msg = parse_line(line)
            if msg is None:
                print("skipped:", line)
            else:
                print("message:", envelope(msg, "test_device"))
