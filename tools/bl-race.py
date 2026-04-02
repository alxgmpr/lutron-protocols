#!/usr/bin/env python3
"""Race the STM32L100 bootloader during power-on.
Run on Caseta console IMMEDIATELY after power cycle.
Sends bootloader MCU-info probes every 50ms, then unhook with link type 30."""
import os, termios, time, select, sys

UART = "/dev/ttyS1"
TARGET_LT = 0x1E  # 30
TARGET_IT = 0x01

T = bytes.fromhex(
    "00070e091c1b1215383f363124232a2d70777e796c6b6265484f464154535a5d"
    "e0e7eee9fcfbf2f5d8dfd6d1c4c3cacd90979e998c8b8285a8afa6a1b4b3babd"
    "c7c0c9cedbdcd5d2fff8f1f6e3e4edeab7b0b9beabaca5a28f88818693949d9a"
    "2720292e3b3c35321f18111603040d0a5750595e4b4c45426f68616673747d7a"
    "898e878095929b9cb1b6bfb8adaaa3a4f9fef7f0e5e2ebecc1c6cfc8dddad3d4"
    "696e676075727b7c51565f584d4a4344191e171005020b0c21262f283d3a3334"
    "4e49404752555c5b7671787f6a6d64633e39303722252c2b0601080f1a1d1413"
    "aea9a0a7b2b5bcbb9691989f8a8d8483ded9d0d7c2c5cccbe6e1e8effafdf4f3"
)

def c8(d):
    c = 0
    for b in d:
        c = T[c ^ b]
    return c

def esc(r):
    o = bytearray()
    for b in r:
        if b == 0x7E: o += b"\x7d\x5e"
        elif b == 0x7D: o += b"\x7d\x5d"
        else: o.append(b)
    return bytes(o)

def bf(d):
    """Bootloader frame: [7E][00][LEN][data+crc escaped][7E]"""
    return b"\x7e\x00" + bytes([len(d)]) + esc(d + bytes([c8(d)])) + b"\x7e"

def cf(d):
    """CLAP frame: [7E][data+crc escaped][7E]"""
    return b"\x7e" + esc(d + bytes([c8(d)])) + b"\x7e"

fd = os.open(UART, os.O_RDWR | os.O_NOCTTY)
a = termios.tcgetattr(fd)
a[0] = 0; a[1] = 0; a[2] = 0x8B0; a[3] = 0
a[4] = termios.B115200; a[5] = termios.B115200
a[6][termios.VMIN] = 0; a[6][termios.VTIME] = 1
termios.tcsetattr(fd, termios.TCSAFLUSH, a)
termios.tcflush(fd, termios.TCIOFLUSH)

mcu_bl = bf(bytes([0x02]))
mcu_cl = cf(bytes([0x02]))

print("Probing bootloader on %s..." % UART)
t0 = time.time()
got_bl = False

while time.time() - t0 < 60:
    # Send probe in both formats
    os.write(fd, mcu_bl)
    os.write(fd, mcu_cl)
    time.sleep(0.05)

    r, _, _ = select.select([fd], [], [], 0.05)
    if r:
        d = os.read(fd, 1024)
        dt = time.time() - t0
        # CLAP app frames always have 7e 01 fc or similar pattern
        is_clap = b"\x7e\x01\xfc" in d
        print("%.1fs: %s %s" % (dt, d[:20].hex(), "(app)" if is_clap else "(BL?)"))

        if not is_clap and d:
            print("*** BOOTLOADER DETECTED ***")
            # Send unhook: [03][config=0x55][link_type][image_type]
            unhook = bytes([0x03, 0x55, TARGET_LT, TARGET_IT])
            os.write(fd, bf(unhook))
            os.write(fd, cf(unhook))  # try both formats
            print("Sent unhook: %s" % unhook.hex())
            time.sleep(0.5)
            r2, _, _ = select.select([fd], [], [], 1.0)
            if r2:
                resp = os.read(fd, 1024)
                print("Response: %s" % resp.hex())
            got_bl = True
            break

os.close(fd)
if got_bl:
    print("\nWait 5s for app boot, then verify:")
    print("  /usr/sbin/lutron-coproc-firmware-update-app -q /dev/ttyS1")
else:
    print("\nNo bootloader response in 60s. The bootloader window may be <1ms.")
    print("Try: power cycle while this script is already running.")
