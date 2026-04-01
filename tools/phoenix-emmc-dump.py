#!/usr/bin/env python3
"""
Phoenix eMMC Dump — runs on Raspberry Pi.

Boots the emmc-read ARM stub via XMODEM, then reads eMMC sectors
over UART and saves them to a binary file.

Usage:
  python3 emmc-dump.py boot                  # Boot and show output
  python3 emmc-dump.py read START COUNT      # Read sectors (hex), save to file
  python3 emmc-dump.py gpt                   # Auto-read and parse GPT
  python3 emmc-dump.py interactive           # Boot then manual commands
"""

import sys
import os
import time
import struct
import subprocess

import serial
import xmodem

BIN_PATH = os.path.expanduser("~/emmc-read.bin")
SERIAL_PORT = "/dev/ttyAMA0"
BAUD = 115200
GPIO_POWER = 17

def gpio_set(pin, value):
    """Use pinctrl (Pi 5 compatible, doesn't hold line open)."""
    level = "dh" if value else "dl"
    subprocess.run(["pinctrl", "set", str(pin), "op", level],
                   check=True, capture_output=True)

def power_cycle(off_time=0.5):
    gpio_set(GPIO_POWER, 1)  # Active-LOW: HIGH = OFF
    time.sleep(off_time)
    gpio_set(GPIO_POWER, 0)  # Active-LOW: LOW = ON

def wait_for_cccc(ser, timeout=15):
    buf = b""
    start = time.time()
    while time.time() - start < timeout:
        data = ser.read(ser.in_waiting or 1)
        if data:
            buf += data
            if b"CCC" in buf[-10:]:
                time.sleep(0.3)
                ser.reset_input_buffer()
                return True
    return False

def send_xmodem(ser, filepath):
    def getc(size, timeout=1):
        ser.timeout = timeout
        return ser.read(size) or None
    def putc(data, timeout=1):
        ser.write_timeout = timeout
        return ser.write(data)
    modem = xmodem.XMODEM(getc, putc)
    with open(filepath, "rb") as f:
        return modem.send(f, retry=10)

def wait_for_ready(ser, timeout=30):
    """Wait for READY or > prompt from ARM code, printing everything we see."""
    buf = b""
    start = time.time()
    ser.timeout = 0.5
    while time.time() - start < timeout:
        data = ser.read(ser.in_waiting or 1)
        if data:
            text = data.decode('ascii', errors='replace')
            print(text, end='', flush=True)
            buf += data
            if b"READY" in buf or b"> " in buf:
                return True
            if b"ERROR: No eMMC" in buf:
                return False
    return False

def boot_stub(ser, bin_path):
    """Full boot sequence: power cycle, XMODEM, wait for READY."""
    size = os.path.getsize(bin_path)
    print(f"Binary: {bin_path} ({size} bytes)")
    print(f"Serial: {SERIAL_PORT} @ {BAUD}")

    print("Power cycling...")
    power_cycle(0.5)
    time.sleep(0.2)

    ser.reset_input_buffer()

    print("Waiting for CCCC...", end="", flush=True)
    if not wait_for_cccc(ser, timeout=15):
        print(" TIMEOUT! Retrying...")
        power_cycle(1.0)
        time.sleep(0.2)
        ser.reset_input_buffer()
        if not wait_for_cccc(ser, timeout=15):
            print("No CCCC. Check wiring/SYSBOOT2.")
            return False
    print(" OK")

    print(f"Sending {size} bytes via XMODEM...", end="", flush=True)
    if not send_xmodem(ser, bin_path):
        print(" XMODEM FAILED!")
        return False
    print(" OK")

    print("Waiting for ARM code...", flush=True)
    if not wait_for_ready(ser, timeout=30):
        print("\nDid not get READY. Check output above.")
        return False

    print("\neMMC reader is ready!")
    return True

def send_cmd(ser, cmd):
    """Send a command string and return all response lines until > prompt."""
    ser.reset_input_buffer()
    ser.write((cmd + "\r").encode())
    time.sleep(0.05)

    lines = []
    buf = b""
    start = time.time()
    ser.timeout = 5
    while time.time() - start < 30:
        data = ser.read(ser.in_waiting or 1)
        if data:
            buf += data
            # Check for next prompt
            if b"> " in buf[-(len(buf)):]:
                # Split into lines
                text = buf.decode('ascii', errors='replace')
                lines = text.strip().split('\n')
                return lines
    # Timeout — return what we have
    text = buf.decode('ascii', errors='replace')
    return text.strip().split('\n')

def parse_sector_dump(lines):
    """Parse hex dump lines back into 512 bytes."""
    data = bytearray()
    in_sector = False
    for line in lines:
        line = line.strip()
        if line.startswith('S '):
            in_sector = True
            continue
        if line == 'E':
            in_sector = False
            continue
        if in_sector and line:
            # Parse hex bytes: "XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX"
            parts = line.split()
            for h in parts:
                if len(h) == 2:
                    try:
                        data.append(int(h, 16))
                    except ValueError:
                        pass
    return bytes(data[:512])

def read_sectors(ser, start, count):
    """Read a range of sectors, return concatenated bytes."""
    result = bytearray()
    for i in range(count):
        sector = start + i
        cmd = f"R {sector:08X}"
        lines = send_cmd(ser, cmd)
        data = parse_sector_dump(lines)
        if len(data) != 512:
            print(f"  Sector {sector:#x}: got {len(data)} bytes (expected 512)")
            if len(data) == 0:
                # Print raw response for debug
                for l in lines[:5]:
                    print(f"    {l}")
                result += b'\x00' * 512
                continue
            data = data.ljust(512, b'\x00')
        result += data
        if (i + 1) % 10 == 0 or i == count - 1:
            print(f"  {i+1}/{count} sectors read", flush=True)
    return bytes(result)

def parse_gpt(data):
    """Parse GPT header and partition entries from raw sector data."""
    # Sector 0 = protective MBR
    # Sector 1 = GPT header
    if len(data) < 1024:
        print("Not enough data for GPT header")
        return

    gpt = data[512:1024]
    sig = gpt[0:8]
    if sig != b'EFI PART':
        print(f"No GPT signature (got {sig!r})")
        # Check MBR
        mbr = data[0:512]
        if mbr[510:512] == b'\x55\xAA':
            print("Valid MBR signature found (0x55AA)")
            # Print partition table
            for i in range(4):
                entry = mbr[446 + i*16 : 446 + (i+1)*16]
                ptype = entry[4]
                if ptype != 0:
                    lba_start = struct.unpack_from('<I', entry, 8)[0]
                    lba_count = struct.unpack_from('<I', entry, 12)[0]
                    print(f"  Partition {i}: type=0x{ptype:02X} start={lba_start} count={lba_count} ({lba_count*512/1024/1024:.1f}MB)")
        else:
            print(f"No MBR signature either (got {mbr[510:512].hex()})")
            print(f"First 16 bytes: {data[:16].hex()}")
        return

    print("GPT Header found!")
    revision = struct.unpack_from('<I', gpt, 8)[0]
    header_size = struct.unpack_from('<I', gpt, 12)[0]
    my_lba = struct.unpack_from('<Q', gpt, 24)[0]
    alt_lba = struct.unpack_from('<Q', gpt, 32)[0]
    first_usable = struct.unpack_from('<Q', gpt, 40)[0]
    last_usable = struct.unpack_from('<Q', gpt, 48)[0]
    part_entry_lba = struct.unpack_from('<Q', gpt, 72)[0]
    num_parts = struct.unpack_from('<I', gpt, 80)[0]
    part_entry_size = struct.unpack_from('<I', gpt, 84)[0]

    print(f"  Revision: {revision:#x}")
    print(f"  First usable LBA: {first_usable}")
    print(f"  Last usable LBA: {last_usable}")
    print(f"  Partition entries at LBA {part_entry_lba}, count={num_parts}, size={part_entry_size}")

    # Parse partition entries (starts at sector 2 typically)
    pe_offset = part_entry_lba * 512
    if pe_offset + num_parts * part_entry_size > len(data):
        need = part_entry_lba + (num_parts * part_entry_size + 511) // 512
        print(f"  Need sectors 0-{need} for full partition table")
        num_parts = min(num_parts, (len(data) - pe_offset) // part_entry_size)

    for i in range(num_parts):
        offset = pe_offset + i * part_entry_size
        entry = data[offset:offset + part_entry_size]
        type_guid = entry[0:16]
        if type_guid == b'\x00' * 16:
            continue
        unique_guid = entry[16:32]
        first_lba = struct.unpack_from('<Q', entry, 32)[0]
        last_lba = struct.unpack_from('<Q', entry, 40)[0]
        attrs = struct.unpack_from('<Q', entry, 48)[0]
        name = entry[56:128].decode('utf-16-le', errors='replace').rstrip('\x00')
        size_mb = (last_lba - first_lba + 1) * 512 / 1024 / 1024
        print(f"  Partition {i}: '{name}' LBA {first_lba}-{last_lba} ({size_mb:.1f}MB)")

def cmd_boot(args):
    bin_path = args[0] if args else BIN_PATH
    ser = serial.Serial(SERIAL_PORT, BAUD, timeout=1)
    try:
        if not boot_stub(ser, bin_path):
            return
        print("\nBooted successfully. Capturing output for 10s...")
        start = time.time()
        while time.time() - start < 10:
            data = ser.read(ser.in_waiting or 1)
            if data:
                print(data.decode('ascii', errors='replace'), end='', flush=True)
    finally:
        ser.close()

def cmd_read(args):
    if len(args) < 2:
        print("Usage: emmc-dump.py read <start_hex> <count>")
        return
    start_sector = int(args[0], 16)
    count = int(args[1])
    bin_path = args[2] if len(args) > 2 else BIN_PATH
    outfile = f"emmc-{start_sector:08x}-{count}.bin"

    ser = serial.Serial(SERIAL_PORT, BAUD, timeout=1)
    try:
        if not boot_stub(ser, bin_path):
            return
        time.sleep(0.5)
        ser.reset_input_buffer()

        print(f"\nReading {count} sectors from {start_sector:#x}...")
        data = read_sectors(ser, start_sector, count)
        with open(outfile, 'wb') as f:
            f.write(data)
        print(f"Saved {len(data)} bytes to {outfile}")
    finally:
        ser.close()

def cmd_gpt(args):
    bin_path = args[0] if args else BIN_PATH
    ser = serial.Serial(SERIAL_PORT, BAUD, timeout=1)
    try:
        if not boot_stub(ser, bin_path):
            return
        time.sleep(0.5)
        ser.reset_input_buffer()

        # Read first 34 sectors (GPT header + partition entries)
        print("\nReading GPT (sectors 0-33)...")
        data = read_sectors(ser, 0, 34)
        with open("emmc-gpt.bin", 'wb') as f:
            f.write(data)
        print(f"Saved {len(data)} bytes to emmc-gpt.bin")

        parse_gpt(data)
    finally:
        ser.close()

def cmd_interactive(args):
    bin_path = args[0] if args else BIN_PATH
    ser = serial.Serial(SERIAL_PORT, BAUD, timeout=1)
    try:
        if not boot_stub(ser, bin_path):
            return

        print("\nInteractive mode. Type commands (R <hex>, D <start> <count>, I, q to quit)")
        time.sleep(0.5)
        ser.reset_input_buffer()

        while True:
            try:
                cmd = input("emmc> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if cmd.lower() in ('q', 'quit', 'exit'):
                break
            if not cmd:
                continue

            lines = send_cmd(ser, cmd)
            for line in lines:
                print(line)

            # If it was a read command, try to parse and show hex
            if cmd.upper().startswith('R '):
                data = parse_sector_dump(lines)
                if data:
                    print(f"  ({len(data)} bytes parsed)")
    finally:
        ser.close()

def main():
    if len(sys.argv) < 2:
        print("Usage: emmc-dump.py <boot|read|gpt|interactive> [args...]")
        print("  boot                    - Boot stub, show output")
        print("  read <start_hex> <cnt>  - Read sector range, save to file")
        print("  gpt                     - Read and parse GPT partition table")
        print("  interactive             - Boot then manual commands")
        sys.exit(1)

    mode = sys.argv[1]
    args = sys.argv[2:]

    if mode == 'boot':
        cmd_boot(args)
    elif mode == 'read':
        cmd_read(args)
    elif mode == 'gpt':
        cmd_gpt(args)
    elif mode in ('interactive', 'i'):
        cmd_interactive(args)
    else:
        print(f"Unknown mode: {mode}")
        sys.exit(1)

if __name__ == "__main__":
    main()
