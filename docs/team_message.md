# Remaining Work

The firmware, bridge, and simulator are done and have been tested on real hardware. The device schema can be found at `schemas/nucleo_tilt_motor.json`. User story numbers (US1 to US14) refer to the product backlog in `docs/requirements.tex`.

Design for a generic device/schema, and test with the simulator. Fields or commands such as `tilt_deg` or `set_motor` should not be hard-coded, but read from the schema.

## Remaining responsibilities by team member

**Japjot (backend)**
- Database for users, devices and their schemas, device access, telemetry, alert rules, and alerts.
- Register a device from its schema, rejecting schemas that don't follow the format of `schemas/nucleo_tilt_motor.json` (US8). Remove a device (US9).
- Validate incoming telemetry against the device's schema and store it. Drop readings from unregistered devices (US12).
- Device list endpoint with an online/offline state for each device (US2).
- Past telemetry endpoint by device, fields, and time range, downsampled for long ranges (US4).
- Check commands against the schema (the command exists and its args are within `min` and `max`) before forwarding them to the bridge (US6).
- Daily cleanup of telemetry older than 14 days (data retention requirement).
- Send each `/ws/live` client only the devices it has access to, once auth exists (with Samuel).

**Daniel (dashboard/frontend)**
- Login page (US1) and device list with online/offline indicators (US2).
- Live device page built from the schema: one value or chart per telemetry field, labeled with `label` and `unit` (US3).
- Past telemetry view: pick fields and a time range, then chart them (US4).
- Alerts view (US5).
- Command panel built from the schema, with inputs limited by `min` and `max`, showing the ack result matched by `id`. Hidden for viewers (US6).
- Admin pages: create users, register and remove devices, manage access, and configure alert rules (US7 to US11).
- Run the usability test with five new users (usability requirement).

**Samuel (roles and alerts)**
- Login with hashed passwords and a token that both the HTTP endpoints and `/ws/live` check (US1).
- Create user accounts (US7).
- Per-device roles (viewer, operator, administrator) and the permission checks for each endpoint (US10). Commands require operator. Registering devices, creating users, managing access, and setting rules require administrator.
- Alert rules: a threshold (`>`, `<`, `>=`, `<=`) on one numeric field that exists in the schema, with create, edit, disable, and delete (US11).
- Check every new reading against its device's rules, record an alert when one is broken, and push it live to `/ws/live` as a `{"type": "alert", ...}` message (US13, US5). Fire once when a value crosses the threshold, not on every reading while it stays over.

**Hunter (firmware, bridge, and integration)**
- Simulator option that pushes the tilt past a threshold on demand, so alerts can be tested without the board.
- Shared token for the bridge, so the backend can reject unknown bridges.
- Capacity test: 10 simulated devices at 10 Hz with 20 dashboards open (capacity and performance requirements).
- Hardware integration and the 5-minute demo run (reliability requirement).

## Codebase details to note

To run the whole stack without the board:

```
pip install -r requirements.txt
uvicorn backend.main:app --reload
python bridge/bridge.py --port sim
```

To add more simulated devices: `python bridge/bridge.py --port sim --device-id sim_2`. Send commands from http://localhost:8000/docs.

- `schemas/nucleo_tilt_motor.json` defines the schema format everything is built from.
- `bridge/protocol.py`: `envelope` and `status` define every message the bridge sends to the backend (`telemetry`, `ack`, `status`), and `parse_command` defines what it accepts.
- `backend/main.py` has the four current endpoints: `/ws/bridge`, `/ws/live`, `GET /api/devices`, and `POST /api/devices/{device_id}/commands`.

**Japjot**
- `backend/main.py`, all of it. You'll be extending it: `bridge_socket` is where telemetry arrives (storage and validation go here), `send_command` is where commands leave (schema checks go here), and `broadcast` is what will need per-user filtering.
- `bridge/protocol.py`, `envelope` and `status`, for the exact shape of what you'll store.
- `bridge/bridge.py`, `handle_command`, to see what the bridge does with a command, including the ack it sends back on its own when the device is disconnected.

**Daniel**
- `backend/main.py`: `live_socket` (the stream you'll connect to) and `send_command` (it returns the `id` you match acks against).
- `bridge/simulator.py`: `telemetry` (what the values look like as they change, for designing charts) and `handle` (the acks and errors your command panel needs to display).

**Samuel**
- `backend/main.py`, all of it, since auth wraps every endpoint and `/ws/live`.
- `bridge/protocol.py`, `envelope`, for the telemetry shape that alert rules are checked against.
- `bridge/simulator.py`, `telemetry`: tilt swings between about -15 and +15 degrees every 8 seconds, so a rule such as `tilt_deg > 10` will fire regularly while you test.

**Hunter**
- `bridge/simulator.py` for the alert trigger, and `bridge/backend_link.py` and `backend/main.py`'s `bridge_socket` for the bridge token.
