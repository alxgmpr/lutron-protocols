#!/usr/bin/env python3
"""Thorough probe of the Caseta coproc UART — tries HDLC DISC, SABM, raw bytes."""
import os, termios, struct, time, fcntl

UART = "/dev/ttyS1"

def open_uart():
    fd = os.open(UART, os.O_RDWR | os.O_NOCTTY)
    old = termios.tcgetattr(fd)
    new = list(old)
    new[0] = 0        # iflag - raw
    new[1] = 0        # oflag - raw
    new[2] = 0x8B0    # cflag: CS8 | CREAD | CLOCAL (matches updater exactly)
    new[3] = 0        # lflag - raw
    new[4] = termios.B115200
    new[5] = termios.B115200
    new[6][termios.VMIN] = 0
    new[6][termios.VTIME] = 5  # 0.5s timeout (matches updater)
    termios.tcsetattr(fd, termios.TCSAFLUSH, new)
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd

def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0x8408
            else:
                crc >>= 1
    return crc ^ 0xFFFF

def make_frame(addr, ctrl, info=b""):
    payload = bytes([addr, ctrl]) + info
    crc = crc16(payload)
    raw = payload + struct.pack("<H", crc)
    escaped = bytearray()
    for b in raw:
        if b == 0x7E:
            escaped += b"\x7d\x5e"
        elif b == 0x7D:
            escaped += b"\x7d\x5d"
        else:
            escaped.append(b)
    return b"\x7e" + bytes(escaped) + b"\x7e"

def read_all(fd, timeout=1.0):
    data = bytearray()
    end = time.time() + timeout
    while time.time() < end:
        chunk = os.read(fd, 1024)
        if chunk:
            data += chunk
        else:
            time.sleep(0.01)
    return bytes(data)

def try_send(fd, label, data, timeout=1.0):
    termios.tcflush(fd, termios.TCIOFLUSH)
    os.write(fd, data)
    resp = read_all(fd, timeout)
    if resp:
        print(f"  {label}: TX={data.hex()} -> RX={resp.hex()} ({len(resp)} bytes)")
    else:
        print(f"  {label}: TX={data.hex()} -> no response")
    return resp

fd = open_uart()

# Check if UART is locked by another process
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("UART lock: exclusive lock obtained OK")
    fcntl.flock(fd, fcntl.LOCK_UN)
except IOError:
    print("UART lock: LOCKED by another process!")

# First drain any pending data
drain = read_all(fd, 0.2)
if drain:
    print(f"Drained {len(drain)} bytes: {drain.hex()}")

print("\n=== HDLC frames (addr=0xFF) ===")
# SABM: control = 0x3F (P/F=1, mode set)
try_send(fd, "SABM  0x3F", make_frame(0xFF, 0x3F))
# DISC: control = 0x53
try_send(fd, "DISC  0x53", make_frame(0xFF, 0x53))
# SABM again after DISC
try_send(fd, "SABM  0x3F", make_frame(0xFF, 0x3F))
# UA: control = 0x73
try_send(fd, "UA    0x73", make_frame(0xFF, 0x73))

print("\n=== HDLC frames (addr=0x03) ===")
try_send(fd, "SABM  0x3F", make_frame(0x03, 0x3F))
try_send(fd, "DISC  0x53", make_frame(0x03, 0x53))

print("\n=== HDLC frames (addr=0x01) ===")
try_send(fd, "SABM  0x3F", make_frame(0x01, 0x3F))

print("\n=== Raw probes ===")
# Bare 0x7E flags (HDLC idle)
try_send(fd, "idle flags", b"\x7e\x7e\x7e\x7e\x7e")
# 0xA5 (bootloader probe from updater)
try_send(fd, "BL probe", b"\xa5")
# 0x7F (STM32 ROM BL)
try_send(fd, "ROM BL", b"\x7f")

print("\n=== Rapid SABM burst (5x) ===")
for i in range(5):
    termios.tcflush(fd, termios.TCIOFLUSH)
    os.write(fd, make_frame(0xFF, 0x3F))
    time.sleep(0.1)
resp = read_all(fd, 2.0)
if resp:
    print(f"  Burst response: {resp.hex()}")
else:
    print(f"  Burst: no response")

os.close(fd)
print("\nDone")
