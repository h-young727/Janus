import sys
import serial

def read_lines(port: str, baud: int = 115200):
    with serial.Serial(port, baud, timeout=1) as ser:
        while True:
            raw = ser.readline()
            if not raw:
                continue
            yield raw.decode("utf-8", errors="replace").rstrip("\r\n")

if __name__ == "__main__":
    for line in read_lines(sys.argv[1]):
        print(line)
