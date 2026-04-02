#!/usr/bin/env python3
"""Connect CLAP, send HDLC DISC, then probe bootloader.
The coproc enters bootloader mode after receiving HDLC disconnect."""
import os, termios, time, select

UART = '/dev/ttyS1'
T = bytes.fromhex(
    '00070e091c1b1215383f363124232a2d70777e796c6b6265484f464154535a5d'
    'e0e7eee9fcfbf2f5d8dfd6d1c4c3cacd90979e998c8b8285a8afa6a1b4b3babd'
    'c7c0c9cedbdcd5d2fff8f1f6e3e4edeab7b0b9beabaca5a28f88818693949d9a'
    '2720292e3b3c35321f18111603040d0a5750595e4b4c45426f68616673747d7a'
    '898e878095929b9cb1b6bfb8adaaa3a4f9fef7f0e5e2ebecc1c6cfc8dddad3d4'
    '696e676075727b7c51565f584d4a4344191e171005020b0c21262f283d3a3334'
    '4e49404752555c5b7671787f6a6d64633e39303722252c2b0601080f1a1d1413'
    'aea9a0a7b2b5bcbb9691989f8a8d8483ded9d0d7c2c5cccbe6e1e8effafdf4f3'
)

def c8(d):
    c = 0
    for b in d:
        c = T[c ^ b]
    return c

def esc(r):
    o = bytearray()
    for b in r:
        if b == 0x7E:
            o += b'\x7d\x5e'
        elif b == 0x7D:
            o += b'\x7d\x5d'
        else:
            o.append(b)
    return bytes(o)

def cf(d):
    return b'\x7e' + esc(d + bytes([c8(d)])) + b'\x7e'

def bf(d):
    return b'\x7e\x00' + bytes([len(d)]) + esc(d + bytes([c8(d)])) + b'\x7e'

def rd(fd, t=1.0):
    d = bytearray()
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            d += os.read(fd, 1024)
    return bytes(d)

fd = os.open(UART, os.O_RDWR | os.O_NOCTTY)
a = termios.tcgetattr(fd)
a[0] = 0; a[1] = 0; a[2] = 0x8B0; a[3] = 0
a[4] = termios.B115200; a[5] = termios.B115200
a[6][termios.VMIN] = 0; a[6][termios.VTIME] = 1
termios.tcsetattr(fd, termios.TCSAFLUSH, a)
termios.tcflush(fd, termios.TCIOFLUSH)

# Step 1: CLAP handshake
print('=== CLAP handshake ===')
os.write(fd, cf(bytes([0x02, 0xFC])))
r = rd(fd, 0.5)
print('init: %s' % r.hex() if r else 'no response')
if not r:
    print('FAILED')
    os.close(fd)
    raise SystemExit(1)

os.write(fd, cf(bytes([0x02, 0xFD])))
rd(fd, 0.5)
os.write(fd, cf(bytes([0x02, 0x08, 0x00, 0x00])))
time.sleep(0.5)
info = rd(fd, 1.0)
print('device info received: %d bytes' % len(info))

# ACK
os.write(fd, cf(bytes([0x01, 0x89])))
time.sleep(0.1)

# Step 2: Send HDLC DISC (disconnect) - same as shutDownLink
print('\n=== Sending HDLC DISC ===')
# DISC control byte: 0x53 (U-frame, DISC, P=1)
# Also try 0x43 (DISC without P)
disc = cf(bytes([0x02, 0x53]))
os.write(fd, disc)
print('Sent DISC: %s' % disc.hex())
time.sleep(0.2)
r = rd(fd, 1.0)
print('DISC response: %s' % r.hex() if r else 'no response')

# Step 3: Wait and probe for bootloader
print('\n=== Probing bootloader ===')
probe_bl = bf(bytes([0x02]))
t0 = time.time()
for i in range(200):
    os.write(fd, b'\xa5')
    time.sleep(0.01)
    os.write(fd, probe_bl)
    r, _, _ = select.select([fd], [], [], 0.02)
    if r:
        d = os.read(fd, 1024)
        dt = time.time() - t0
        is_clap = b'\x7e\x01\xfc' in d
        print('%.3fs: %s %s' % (dt, d[:20].hex(), '(CLAP)' if is_clap else '(BL?)'))
        if not is_clap:
            print('*** BOOTLOADER? Sending unhook ***')
            unhook = bytes([0x03, 0x55, 0x1E, 0x01])
            os.write(fd, bf(unhook))
            os.write(fd, cf(unhook))
            time.sleep(1)
            r2, _, _ = select.select([fd], [], [], 1)
            if r2:
                print('Response: %s' % os.read(fd, 1024).hex())
            break
        if is_clap and dt > 2:
            print('Still in CLAP mode after 2s')
            break

os.close(fd)
print('\nWaiting 5s...')
time.sleep(5)
os.system('/usr/sbin/lutron-coproc-firmware-update-app -q /dev/ttyS1')
