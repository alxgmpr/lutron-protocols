#!/usr/bin/env python3
"""Serial sniffer for Lutron RS-485 bus reverse engineering.

Usage:
  python3 serial-sniff.py [port] [baud] [--parity=e|o|n] [--bits=7|8]

Examples:
  python3 serial-sniff.py /dev/tty.usbserial-BG013EPB 19200
  python3 serial-sniff.py /dev/tty.usbserial-BG013EPB 9600 --parity=e
  python3 serial-sniff.py /dev/tty.usbserial-BG013EPB 19200 --bits=7
"""
import serial, sys, time

port = '/dev/tty.usbserial-BG013EPB'
baud = 19200
parity = serial.PARITY_NONE
bytesize = serial.EIGHTBITS

for arg in sys.argv[1:]:
    if arg.startswith('--parity='):
        p = arg.split('=')[1].lower()
        parity = {'e': serial.PARITY_EVEN, 'o': serial.PARITY_ODD, 'n': serial.PARITY_NONE}[p]
    elif arg.startswith('--bits='):
        b = int(arg.split('=')[1])
        bytesize = {7: serial.SEVENBITS, 8: serial.EIGHTBITS}[b]
    elif arg.startswith('/dev') or arg.startswith('COM'):
        port = arg
    elif arg.isdigit():
        baud = int(arg)

parity_name = {serial.PARITY_NONE: 'N', serial.PARITY_EVEN: 'E', serial.PARITY_ODD: 'O'}[parity]
bits_name = {serial.SEVENBITS: 7, serial.EIGHTBITS: 8}[bytesize]
print(f"Listening on {port} @ {baud} {bits_name}{parity_name}1. Press buttons. Ctrl-C to quit.\n")

ser = serial.Serial(port, baud, bytesize=bytesize, parity=parity, stopbits=serial.STOPBITS_ONE, timeout=0.1)

# Buffer messages — gap of >20ms = new message
buf = bytearray()
last_rx = time.time()
msg_num = 0
prev_msg = None

try:
    while True:
        data = ser.read(ser.in_waiting or 1)
        now = time.time()

        if data:
            # If gap since last data, flush previous buffer as a message
            if buf and (now - last_rx) > 0.02:
                msg_num += 1
                hex_str = ' '.join(f'{b:02X}' for b in buf)
                ascii_str = ''.join(chr(b) if 32 <= b < 127 else '.' for b in buf)
                # Strip high bit version
                stripped = bytes(b & 0x7F for b in buf)
                strip_hex = ' '.join(f'{b:02X}' for b in stripped)
                strip_ascii = ''.join(chr(b) if 32 <= b < 127 else '.' for b in stripped)

                changed = "" if buf == prev_msg else " ***NEW***" if prev_msg is not None else ""
                print(f"#{msg_num:4d} [{len(buf):2d}] {hex_str}  |{ascii_str}|{changed}")
                print(f"       7b: {strip_hex}  |{strip_ascii}|")
                prev_msg = bytes(buf)
                buf.clear()

            buf.extend(data)
            last_rx = now
        else:
            # Timeout with no data — flush if buffer has content
            if buf:
                msg_num += 1
                hex_str = ' '.join(f'{b:02X}' for b in buf)
                ascii_str = ''.join(chr(b) if 32 <= b < 127 else '.' for b in buf)
                stripped = bytes(b & 0x7F for b in buf)
                strip_hex = ' '.join(f'{b:02X}' for b in stripped)
                strip_ascii = ''.join(chr(b) if 32 <= b < 127 else '.' for b in stripped)

                changed = "" if buf == prev_msg else " ***NEW***" if prev_msg is not None else ""
                print(f"#{msg_num:4d} [{len(buf):2d}] {hex_str}  |{ascii_str}|{changed}")
                print(f"       7b: {strip_hex}  |{strip_ascii}|")
                prev_msg = bytes(buf)
                buf.clear()

except KeyboardInterrupt:
    print("\nDone.")
finally:
    ser.close()
