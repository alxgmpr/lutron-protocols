#!/usr/bin/env python3
"""Set Caseta coproc link type via bootloader unhook command.
Bootloader frame: [7E] [00] [LEN] [DATA...escaped] [CRC8 of DATA...escaped] [7E]
CLAP frame: [7E] [DATA...escaped] [CRC8 of DATA...escaped] [7E]
"""
import os, termios, struct, time, select, sys

UART = "/dev/ttyS1"
TARGET_LINK_TYPE = int(sys.argv[1], 0) if len(sys.argv) > 1 else 0x1E
TARGET_IMAGE_TYPE = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x01

CRC_TABLE = bytes.fromhex(
    "00070e091c1b1215383f363124232a2d"
    "70777e796c6b6265484f464154535a5d"
    "e0e7eee9fcfbf2f5d8dfd6d1c4c3cacd"
    "90979e998c8b8285a8afa6a1b4b3babd"
    "c7c0c9cedbdcd5d2fff8f1f6e3e4edea"
    "b7b0b9beabaca5a28f88818693949d9a"
    "2720292e3b3c35321f18111603040d0a"
    "5750595e4b4c45426f68616673747d7a"
    "898e878095929b9cb1b6bfb8adaaa3a4"
    "f9fef7f0e5e2ebecc1c6cfc8dddad3d4"
    "696e676075727b7c51565f584d4a4344"
    "191e171005020b0c21262f283d3a3334"
    "4e49404752555c5b7671787f6a6d6463"
    "3e39303722252c2b0601080f1a1d1413"
    "aea9a0a7b2b5bcbb9691989f8a8d8483"
    "ded9d0d7c2c5cccbe6e1e8effafdf4f3"
)

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

def crc8(data):
    crc = 0
    for b in data:
        crc = CRC_TABLE[crc ^ b]
    return crc

def escape(raw):
    out = bytearray()
    for b in raw:
        if b == 0x7E: out += b"\x7d\x5e"
        elif b == 0x7D: out += b"\x7d\x5d"
        else: out.append(b)
    return bytes(out)

def clap_frame(data):
    """CLAP: [7E] data+crc escaped [7E]"""
    c = crc8(data)
    return b"\x7e" + escape(data + bytes([c])) + b"\x7e"

def bl_frame(data):
    """Bootloader: [7E] [00] [LEN] data+crc escaped [7E]
    The 00 and LEN are NOT escaped and NOT included in CRC."""
    c = crc8(data)
    return b"\x7e\x00" + bytes([len(data)]) + escape(data + bytes([c])) + b"\x7e"

def read_raw(fd, timeout=2.0):
    data = bytearray()
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            chunk = os.read(fd, 1024)
            if chunk: data += chunk
    return bytes(data)

def parse_frames(raw):
    """Parse frames, return raw unescaped payloads (with CRC stripped)."""
    frames = []
    buf = bytearray()
    in_frame = False
    for b in raw:
        if b == 0x7E:
            if in_frame and len(buf) > 0:
                unesc = bytearray()
                e = False
                for c in buf:
                    if e: unesc.append(c ^ 0x20); e = False
                    elif c == 0x7D: e = True
                    else: unesc.append(c)
                if len(unesc) >= 2:
                    frames.append(bytes(unesc[:-1]))
            buf = bytearray()
            in_frame = True
        elif in_frame:
            buf.append(b)
    return frames

def xmit_clap(fd, data, timeout=1.0):
    frame = clap_frame(data)
    os.write(fd, frame)
    time.sleep(0.05)
    return parse_frames(read_raw(fd, timeout))

def xmit_bl(fd, data, timeout=1.0):
    frame = bl_frame(data)
    print("  TX BL: %s (raw: %s)" % (data.hex(), frame.hex()))
    os.write(fd, frame)
    time.sleep(0.05)
    raw = read_raw(fd, timeout)
    frames = parse_frames(raw)
    if raw:
        print("  RX raw: %s" % raw.hex())
    for f in frames:
        print("  RX frame: %s" % f.hex())
    return frames

# ======================================================================
print("=== Phase 1: CLAP connect, read current state ===")
fd = open_uart()
r = xmit_clap(fd, bytes([0x02, 0xFC]))
if not r:
    print("No response. Is lutron-core running? Kill it first.")
    os.close(fd); sys.exit(1)

xmit_clap(fd, bytes([0x02, 0xFD]))
xmit_clap(fd, bytes([0x02, 0x08, 0x00, 0x00]))
time.sleep(0.3)
frames = parse_frames(read_raw(fd, 1.0))
current_lt = None
for f in frames:
    if len(f) > 5 and f[0] == 0x01:
        current_lt = f[1]
        print("  Current: LinkType=0x%02X ImageType=%s" % (f[1], "unknown"))

print("\n=== Phase 2: Disconnect, wait for bootloader ===")
os.close(fd)

for wait in range(2, 32, 2):
    time.sleep(2)
    sys.stdout.write("  %ds..." % wait)
    sys.stdout.flush()
    fd = open_uart()
    termios.tcflush(fd, termios.TCIOFLUSH)

    # Try bootloader MCU Info with proper frame format
    r = xmit_bl(fd, bytes([0x02]), 0.5)
    if r:
        print(" BOOTLOADER OK!")
        # Parse MCU info response
        for f in r:
            print("  MCU info payload: %s (%d bytes)" % (f.hex(), len(f)))
        break
    os.close(fd)
    fd = -1
else:
    print("\n  Bootloader not responding")
    sys.exit(1)

# ======================================================================
print("\n=== Phase 3: Unhook with LinkType=0x%02X ImageType=0x%02X ===" % (TARGET_LINK_TYPE, TARGET_IMAGE_TYPE))

# Unhook command: [03] [config_byte] [param1] [param2]
# config_byte = 0x55 (default when not reading from config)
# Try param order: link_type first, then image_type
cmd = bytes([0x03, 0x55, TARGET_LINK_TYPE, TARGET_IMAGE_TYPE])
r = xmit_bl(fd, cmd, 2.0)

os.close(fd)

# ======================================================================
print("\n=== Phase 4: Wait for app boot, verify ===")
time.sleep(5)
fd = open_uart()

for attempt in range(10):
    r = xmit_clap(fd, bytes([0x02, 0xFC]), 0.5)
    if r:
        xmit_clap(fd, bytes([0x02, 0xFD]))
        xmit_clap(fd, bytes([0x02, 0x08, 0x00, 0x00]))
        time.sleep(0.3)
        frames = parse_frames(read_raw(fd, 1.0))
        for f in frames:
            if len(f) > 5 and f[0] == 0x01:
                lt = f[1]
                print("  RESULT: LinkType=0x%02X (%d)" % (lt, lt))
                if lt == TARGET_LINK_TYPE:
                    print("  SUCCESS!")
                elif lt == 0x09:
                    print("  Unchanged (still 9)")
                else:
                    print("  Changed but unexpected value")
        break
    time.sleep(2)
else:
    print("  Could not reconnect")

os.close(fd)
