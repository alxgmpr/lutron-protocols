#!/usr/bin/env python3
"""
Phoenix eMMC Sector Dump Tool

Sends a patched SPL via XMODEM that silently initializes hardware,
then enters an interactive eMMC sector dump mode over UART.

Usage:
  python3 tools/phoenix-emmc-dump.py [port] [--dump START COUNT OUTPUT]
  python3 tools/phoenix-emmc-dump.py --interactive
"""

import sys
import os
import time
import struct

VENV = "/tmp/xmodem-venv/lib"
for d in os.listdir(VENV):
    sp = os.path.join(VENV, d, "site-packages")
    if os.path.isdir(sp) and sp not in sys.path:
        sys.path.insert(0, sp)

import serial
import xmodem

SPL_PATH = "/tmp/phoenix-boot/emmc-dump-spl.bin"
BAUD = 115200


def wait_for_cccc(ser, timeout=60):
    print("Waiting for CCCC pattern...", flush=True)
    buf = b""
    start = time.time()
    while time.time() - start < timeout:
        data = ser.read(ser.in_waiting or 1)
        if data:
            buf += data
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            if b"CCC" in buf[-10:]:
                print("\nGot CCCC!", flush=True)
                time.sleep(0.5)
                ser.reset_input_buffer()
                return True
    print(f"\nTimeout after {timeout}s", flush=True)
    return False


def send_xmodem(ser, filepath):
    filesize = os.path.getsize(filepath)
    print(f"Sending {os.path.basename(filepath)} ({filesize} bytes) via XMODEM...", flush=True)
    def getc(size, timeout=1):
        ser.timeout = timeout
        return ser.read(size) or None
    def putc(data, timeout=1):
        ser.write_timeout = timeout
        return ser.write(data)
    modem = xmodem.XMODEM(getc, putc)
    with open(filepath, "rb") as f:
        result = modem.send(f, retry=10)
    if result:
        print(f"  Sent OK", flush=True)
    else:
        print(f"  FAILED", flush=True)
    return result


def wait_for_ready(ser, timeout=30):
    """Wait for READY from the eMMC dump shellcode."""
    print("Waiting for SPL init + READY signal...", flush=True)
    buf = b""
    start = time.time()
    while time.time() - start < timeout:
        data = ser.read(ser.in_waiting or 1)
        if data:
            buf += data
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            if b"READY" in buf:
                print("\n*** eMMC dump ready! ***", flush=True)
                time.sleep(0.2)
                ser.reset_input_buffer()
                return True
            if b"NO MMC" in buf:
                print("\n*** MMC not found! ***", flush=True)
                return False
    print(f"\nTimeout ({timeout}s). SPL may have hung during init.", flush=True)
    # Show any partial output
    if buf:
        print(f"Received: {buf!r}", flush=True)
    return False


def read_sectors(ser, start, count):
    """Send read command and receive sector data."""
    cmd = f"R {start:08X} {count:04X}\r\n"
    ser.write(cmd.encode())

    sectors = {}
    current_sector = None
    current_data = bytearray()

    ser.timeout = 5
    buf = b""

    while True:
        line_data = ser.readline()
        if not line_data:
            print(f"  Timeout waiting for data", flush=True)
            break

        line = line_data.decode('ascii', errors='replace').strip()

        if line.startswith("S:"):
            current_sector = int(line[2:], 16)
            current_data = bytearray()
        elif line == "DONE":
            break
        elif line and current_sector is not None:
            # Hex data line
            try:
                current_data += bytes.fromhex(line)
            except ValueError:
                print(f"  Bad hex line: {line!r}", flush=True)
                continue

            if len(current_data) >= 512:
                sectors[current_sector] = bytes(current_data[:512])
                current_sector = None
                current_data = bytearray()

    return sectors


def dump_sectors(ser, start, count, outfile):
    """Dump a range of sectors to a file."""
    print(f"Reading {count} sectors starting at {start:#x}...")
    total = 0
    batch = 16  # Read 16 sectors at a time

    with open(outfile, "wb") as f:
        while total < count:
            n = min(batch, count - total)
            sectors = read_sectors(ser, start + total, n)
            for i in range(n):
                sec = start + total + i
                if sec in sectors:
                    f.write(sectors[sec])
                else:
                    print(f"  Missing sector {sec:#x}, writing zeros", flush=True)
                    f.write(b"\x00" * 512)
            total += n
            pct = total * 100 // count
            print(f"  {total}/{count} sectors ({pct}%)", flush=True)

    print(f"Done. Written to {outfile}")


def interactive_mode(ser):
    """Interactive sector read mode."""
    print("\n=== Interactive eMMC dump mode ===")
    print("Commands:")
    print("  r START COUNT  — read COUNT sectors from START (hex)")
    print("  gpt            — read GPT header (sectors 0-33)")
    print("  q              — quit (jump to U-Boot)")
    print()

    while True:
        try:
            cmd = input("emmc> ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if not cmd:
            continue

        parts = cmd.split()

        if parts[0] == "r" and len(parts) >= 3:
            start = int(parts[1], 16)
            count = int(parts[2], 16) if len(parts) > 2 else 1
            sectors = read_sectors(ser, start, count)
            for sec_num in sorted(sectors.keys()):
                data = sectors[sec_num]
                print(f"\n--- Sector {sec_num:#010x} ---")
                for i in range(0, 512, 16):
                    hex_str = data[i:i+16].hex()
                    ascii_str = ''.join(chr(b) if 32 <= b < 127 else '.' for b in data[i:i+16])
                    print(f"  {i:03x}: {hex_str}  {ascii_str}")

        elif parts[0] == "gpt":
            print("Reading GPT (sectors 0-33)...")
            dump_sectors(ser, 0, 34, "/tmp/phoenix-gpt.bin")
            # Parse GPT
            with open("/tmp/phoenix-gpt.bin", "rb") as f:
                gpt_data = f.read()
            if gpt_data[512:520] == b"EFI PART":
                print("\nGPT Header found:")
                num_entries = struct.unpack_from('<I', gpt_data, 512+80)[0]
                entry_size = struct.unpack_from('<I', gpt_data, 512+84)[0]
                print(f"  {num_entries} partition entries, {entry_size} bytes each")
                for i in range(min(num_entries, 20)):
                    off = 1024 + i * entry_size
                    type_guid = gpt_data[off:off+16]
                    if type_guid == b'\x00' * 16:
                        continue
                    first_lba = struct.unpack_from('<Q', gpt_data, off+32)[0]
                    last_lba = struct.unpack_from('<Q', gpt_data, off+40)[0]
                    name = gpt_data[off+56:off+entry_size].decode('utf-16-le', errors='replace').rstrip('\x00')
                    size_mb = (last_lba - first_lba + 1) * 512 / 1024 / 1024
                    print(f"  p{i+1}: {name:20s} LBA {first_lba:>10d}-{last_lba:>10d} ({size_mb:.0f} MB)")
            else:
                print("No GPT header found (might use MBR)")

        elif parts[0] == "q":
            print("Sending quit...")
            ser.write(b"Q\r\n")
            break

        else:
            print(f"Unknown command: {cmd}")


def main():
    port = "/dev/tty.usbserial-4240"
    args = sys.argv[1:]

    for i, a in enumerate(args):
        if not a.startswith("-") and "/" in a:
            port = a

    if not os.path.exists(SPL_PATH):
        print(f"SPL not found at {SPL_PATH}")
        print("Build it first with the build script")
        sys.exit(1)

    print(f"Opening {port} @ {BAUD}")
    ser = serial.Serial(port, BAUD, timeout=1)
    ser.reset_input_buffer()

    print("Power-cycle Phoenix with SYSBOOT2 (TP701) grounded")
    print()

    if not wait_for_cccc(ser):
        ser.close()
        sys.exit(1)

    if not send_xmodem(ser, SPL_PATH):
        ser.close()
        sys.exit(1)

    if not wait_for_ready(ser):
        print("\nDropping to raw interactive console (Ctrl+C to exit)")
        import select, tty, termios
        old = termios.tcgetattr(sys.stdin)
        try:
            tty.setraw(sys.stdin)
            ser.timeout = 0.1
            while True:
                data = ser.read(256)
                if data:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                if select.select([sys.stdin], [], [], 0)[0]:
                    ch = sys.stdin.buffer.read(1)
                    if ch == b"\x03":
                        break
                    ser.write(ch)
        except KeyboardInterrupt:
            pass
        finally:
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)
        ser.close()
        sys.exit(1)

    interactive_mode(ser)
    ser.close()


if __name__ == "__main__":
    main()
