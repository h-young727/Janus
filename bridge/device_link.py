import sys
import serial
from simulator import SimulatedDevice

def open_device(port: str, baud: int = 115200):
    if port == "sim":
        return SimulatedDevice()
    return serial.Serial(port, baud, timeout=1)

def read_lines(device):
    while True:
        raw = device.readline()
        if not raw:
            continue
        yield raw.decode("utf-8", errors="replace").rstrip("\r\n")

def write_line(device, line: str):
    device.write((line + "\n").encode("utf-8"))

if __name__ == "__main__":
    with open_device(sys.argv[1]) as device:
        for line in read_lines(device):
            print(line)
