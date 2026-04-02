#!/usr/bin/env python3
"""Talk HDLC to the Caseta coproc. Address=0x01. Handles active polling."""
import os, termios, struct, time, select

UART = "/dev/ttyS1"

def open_uart():
    fd = os.open(UART, os.O_RDWR | os.O_NOCTTY)
    old = termios.tcgetattr(fd)
    new = list(old)
    new[0] = 0; new[1] = 0; new[2] = 0x8B0; new[3] = 0
    new[4] = termios.B115200; new[5] = termios.B115200
    new[6][termios.VMIN] = 0; new[6][termios.VTIME] = 1
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

def make_frame(payload):
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

def parse_frames(data):
    frames = []
    buf = bytearray()
    in_frame = False
    for b in data:
        if b == 0x7E:
            if in_frame and len(buf) > 0:
                # Unescape
                unesc = bytearray()
                esc = False
                for c in buf:
                    if esc:
                        unesc.append(c ^ 0x20)
                        esc = False
                    elif c == 0x7D:
                        esc = True
                    else:
                        unesc.append(c)
                # Verify CRC
                if len(unesc) >= 4:  # addr + ctrl + 2 CRC
                    payload = bytes(unesc[:-2])
                    got_crc = struct.unpack("<H", bytes(unesc[-2:]))[0]
                    exp_crc = crc16(payload)
                    frames.append((payload, got_crc == exp_crc))
            buf = bytearray()
            in_frame = True
        elif in_frame:
            buf.append(b)
    return frames

def read_frames(fd, timeout=2.0):
    data = bytearray()
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            chunk = os.read(fd, 1024)
            if chunk:
                data += chunk
    return parse_frames(bytes(data))

fd = open_uart()

# Step 1: Drain and observe what the coproc is sending
print("=== Listening for coproc frames (2s) ===")
frames = read_frames(fd, 2.0)
for payload, valid in frames:
    if len(payload) >= 2:
        addr, ctrl = payload[0], payload[1]
        info = payload[2:] if len(payload) > 2 else b""
        ctrl_type = "I" if (ctrl & 1) == 0 else ("S" if (ctrl & 2) == 0 else "U")
        print(f"  addr=0x{addr:02X} ctrl=0x{ctrl:02X}({ctrl_type}) info={info.hex()} crc_ok={valid}")

if not frames:
    print("  No frames received. Coproc may not be active.")
    print("  Trying SABM with addr=0x01...")
    # Send SABM (U-frame, control=0x3F with P=1 → 0x3F)
    sabm = make_frame(bytes([0x01, 0x3F]))
    os.write(fd, sabm)
    print(f"  TX SABM: {sabm.hex()}")
    frames = read_frames(fd, 3.0)
    for payload, valid in frames:
        addr, ctrl = payload[0], payload[1]
        print(f"  RX: addr=0x{addr:02X} ctrl=0x{ctrl:02X} crc_ok={valid}")
else:
    print(f"\nCoproc is actively sending ({len(frames)} frames in 2s)")
    # The coproc is polling. We need to respond properly.
    # First, send DISC to reset the HDLC session
    print("\n=== Sending DISC to reset session ===")
    disc = make_frame(bytes([0x01, 0x53]))  # DISC with P=1
    os.write(fd, disc)
    print(f"TX DISC: {disc.hex()}")
    frames = read_frames(fd, 2.0)
    for payload, valid in frames:
        addr, ctrl = payload[0], payload[1]
        print(f"  RX: addr=0x{addr:02X} ctrl=0x{ctrl:02X} crc_ok={valid}")

    # Now send SABM to establish fresh session
    print("\n=== Sending SABM addr=0x01 ===")
    time.sleep(0.5)
    termios.tcflush(fd, termios.TCIOFLUSH)
    sabm = make_frame(bytes([0x01, 0x3F]))
    os.write(fd, sabm)
    print(f"TX SABM: {sabm.hex()}")
    frames = read_frames(fd, 3.0)
    for payload, valid in frames:
        addr, ctrl = payload[0], payload[1]
        info = payload[2:] if len(payload) > 2 else b""
        ctrl_type = "I" if (ctrl & 1) == 0 else ("S" if (ctrl & 2) == 0 else "U")
        print(f"  RX: addr=0x{addr:02X} ctrl=0x{ctrl:02X}({ctrl_type}) info={info.hex()} crc_ok={valid}")

os.close(fd)
print("\nDone")
