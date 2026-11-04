import json
import math
import random
import sys
import time

class SimulatedDevice:
    def __init__(self, rate_hz: float = 10.0):
        self.period = 1 / rate_hz
        self.start = time.monotonic()
        self.next_at = self.start
        self.motor_duty = 0.0
        self.pending = [b"Janus simulated device\r\n", b"IMU found at 0x68\r\n"]
        self.buffer = b""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def readline(self) -> bytes:
        if self.pending:
            return self.pending.pop(0)
        delay = self.next_at - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        self.next_at += self.period
        return self.telemetry()

    def write(self, data: bytes) -> int:
        self.buffer += data
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            self.handle(line.decode("utf-8", errors="replace").strip())
        return len(data)

    def handle(self, line: str):
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            return
        if not isinstance(msg, dict) or msg.get("type") != "command":
            return
        name = msg.get("name")
        args = msg.get("args") or {}
        ack = {"type": "ack", "id": msg.get("id"), "ok": True}
        if name == "set_motor":
            duty = args.get("duty")
            if isinstance(duty, (int, float)) and 0 <= duty <= 100:
                self.motor_duty = float(duty)
            else:
                ack = {"type": "ack", "id": msg.get("id"), "ok": False, "error": "duty must be between 0 and 100"}
        elif name == "stop_motor":
            self.motor_duty = 0.0
        else:
            ack = {"type": "ack", "id": msg.get("id"), "ok": False, "error": f"unknown command: {name}"}
        self.pending.append((json.dumps(ack) + "\r\n").encode())

    def telemetry(self) -> bytes:
        elapsed = time.monotonic() - self.start
        phase = 2 * math.pi * elapsed / 8
        tilt = 15 * math.sin(phase) + random.gauss(0, 0.3)
        tilt_rate = 15 * (2 * math.pi / 8) * math.cos(phase)
        rad = math.radians(tilt)
        data = {
            "tilt_deg": round(tilt, 2),
            "ax": round(math.sin(rad) + random.gauss(0, 0.005), 3),
            "ay": round(random.gauss(0, 0.005), 3),
            "az": round(math.cos(rad) + random.gauss(0, 0.005), 3),
            "gx": round(random.gauss(0, 0.2), 2),
            "gy": round(tilt_rate + random.gauss(0, 0.5), 2),
            "gz": round(random.gauss(0, 0.2), 2),
            "motor_duty": self.motor_duty,
        }
        msg = {"type": "telemetry", "t": int(elapsed * 1000), "data": data}
        return (json.dumps(msg) + "\r\n").encode()

if __name__ == "__main__":
    rate = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
    with SimulatedDevice(rate) as device:
        device.write(b'{"type": "command", "id": "c-1", "name": "set_motor", "args": {"duty": 40}}\n')
        while True:
            print(device.readline().decode().rstrip("\r\n"))
