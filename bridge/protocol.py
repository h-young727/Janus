import json
import sys

from device_link import read_lines

def parse_line(line: str):
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(msg, dict) or msg.get("type") != "telemetry":
        return None
    if not isinstance(msg.get("data"), dict):
        return None
    return msg

if __name__ == "__main__":
    for line in read_lines(sys.argv[1]):
        msg = parse_line(line)
        if msg is None:
            print("skipped:", line)
        else:
            print("message:", msg)
