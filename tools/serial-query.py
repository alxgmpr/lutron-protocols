#!/usr/bin/env python3
"""Quick serial command runner."""
import serial, time, sys

PORT = "/dev/tty.usbserial-4240"
ser = serial.Serial(PORT, 115200, timeout=2)
ser.reset_input_buffer()
ser.write(b"\r\n")
time.sleep(0.5)
ser.reset_input_buffer()

def cmd(c, wait=3):
    ser.reset_input_buffer()
    ser.write((c + "\r\n").encode())
    data = b""
    deadline = time.time() + wait
    last = time.time()
    while time.time() < deadline:
        chunk = ser.read(max(ser.in_waiting, 1))
        if chunk:
            data += chunk
            last = time.time()
        elif data and time.time() - last > 1.5:
            break
        time.sleep(0.01)
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    return "\n".join(l for l in lines if l.strip() not in (c.strip(), "#"))

for c in sys.argv[1:]:
    print(f"=== {c} ===")
    print(cmd(c, wait=5))
    print()

ser.close()
