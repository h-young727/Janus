# Remaining work

Everything on `main` works with the real board: the firmware, bridge, simulator, device registration, stored telemetry, live dashboard, login, roles, and alert rules. US numbers refer to the user stories in `docs/requirements.tex`.

Build everything to work with any device. Read field and command names (like `tilt_deg` or `set_motor`) from the device's schema instead of hard-coding them. Test with the simulator.

## Remaining responsibilities by team member

**Daniel — completed and tested with the simulator**

- Sign-in, authenticated live telemetry, and past readings by field and time range.
- Schema-driven command forms with range checks, matching acknowledgements, and viewer restrictions.
- Live alerts, alert history, and rule creation, editing, disabling, and deletion.
- User creation, device registration and removal, and granting, changing, and revoking device access.
- Single-field and all-field charts with drag reordering and resizing in the all-field view.

**Hunter**
- Capacity test: 10 simulated devices at 10 readings per second with 20 dashboards open, checking that everything shows up within 1 second.
- User manual.

## Running it

In PowerShell, start the backend:

```
pip install -r requirements.txt
$env:JANUS_SECRET_KEY = "any-long-random-string"
$env:JANUS_ADMIN_USER = "admin"
$env:JANUS_ADMIN_PASSWORD = "adminpass1"
$env:JANUS_BRIDGE_TOKEN = "another-long-random-string"
python -m uvicorn backend.main:app --reload
```

Register the device once: at http://localhost:8000/docs, log in with `POST /api/auth/login`, click **Authorize** and paste the token, then send the contents of `schemas/nucleo_tilt_motor.json` to `POST /api/devices`.

In a second terminal, start the simulator with the same bridge token:

```
$env:JANUS_BRIDGE_TOKEN = "another-long-random-string"
python bridge/bridge.py --port sim
```

- Dashboard: http://localhost:8000/
- API: http://localhost:8000/docs. Log in with `POST /api/auth/login`, then click **Authorize** and paste the token.
- For the real board, use `--port COM3` instead of `sim`.

## Where things are

- `schemas/nucleo_tilt_motor.json`: the device schema.
- `bridge/protocol.py`: the messages the bridge sends (`telemetry`, `ack`, `status`).
- `backend/main.py`: devices, stored readings, commands, and the `/ws/bridge` and `/ws/live` connections.
- `backend/auth.py`, `auth_routes.py`, `users.py`, `permissions.py`, `permission_routes.py`: login, accounts, and roles.
- `backend/alerts/`: alert rules and checking readings against them.
- `frontend/`: the dashboard.
