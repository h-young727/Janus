import argparse
import asyncio
import json
import threading
import time
import serial
from backend_link import BackendLink
from device_link import open_device, read_lines, write_line
from protocol import envelope, parse_command, parse_line, status

class Bridge:
    def __init__(self, port: str, device_id: str, backend_url: str):
        self.port = port
        self.device_id = device_id
        self.device = None
        self.loop = None
        self.link = BackendLink(backend_url, self.handle_command)

    def publish(self, msg: dict):
        self.loop.call_soon_threadsafe(self.link.send, msg)

    def device_thread(self):
        while True:
            try:
                with open_device(self.port) as device:
                    self.device = device
                    print(f"device connected: {self.port}")
                    self.publish(status(self.device_id, True))
                    for line in read_lines(device):
                        msg = parse_line(line)
                        if msg is not None:
                            self.publish(envelope(msg, self.device_id))
            except serial.SerialException as exc:
                print(f"device unavailable ({exc}), retrying in 2s")
            if self.device is not None:
                self.device = None
                self.publish(status(self.device_id, False))
            time.sleep(2)

    def handle_command(self, text: str):
        line = parse_command(text)
        if line is None:
            print(f"ignored message from backend: {text}")
            return
        device = self.device
        if device is None:
            ack = {"type": "ack", "id": json.loads(line)["id"], "ok": False, "error": "device not connected"}
            self.link.send(envelope(ack, self.device_id))
            return
        try:
            write_line(device, line)
        except serial.SerialException as exc:
            print(f"could not write to device ({exc})")

    async def run(self):
        self.loop = asyncio.get_running_loop()
        threading.Thread(target=self.device_thread, daemon=True).start()
        await self.link.run()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Relay messages between a Janus device and the backend.")
    parser.add_argument("--port", required=True, help="serial port such as COM3 or sim for simulated device")
    parser.add_argument("--device-id", default="nucleo_tilt_motor")
    parser.add_argument("--backend", default="ws://localhost:8000/ws/bridge")
    args = parser.parse_args()
    try:
        asyncio.run(Bridge(args.port, args.device_id, args.backend).run())
    except KeyboardInterrupt:
        pass
