#!/usr/bin/env python3
"""Extract files from RR-SEL-REP2 over serial using base64 encoding."""
import sys
import time
import os
import base64
import serial

PORT = os.environ.get("SERIAL_PORT", "/dev/tty.usbserial-4240")
BAUD = 115200
OUTDIR = "/Volumes/Secondary/lutron-tools/data/rr-sel-rep2"

def open_serial():
    ser = serial.Serial(PORT, BAUD, timeout=2)
    ser.reset_input_buffer()
    # Wake up
    ser.write(b"\r\n")
    time.sleep(0.5)
    ser.reset_input_buffer()
    return ser

def read_until_prompt(ser, timeout=30):
    """Read until we see a # prompt after output."""
    data = b""
    deadline = time.time() + timeout
    last_data_time = time.time()
    while time.time() < deadline:
        chunk = ser.read(max(ser.in_waiting, 1))
        if chunk:
            data += chunk
            last_data_time = time.time()
        elif time.time() - last_data_time > 2:
            # No data for 2 seconds after receiving some
            if data:
                break
        time.sleep(0.01)
    return data

def extract_file(ser, remote_path, local_name=None):
    """Extract a file using base64 in chunks."""
    if local_name is None:
        local_name = os.path.basename(remote_path)
    local_path = os.path.join(OUTDIR, local_name)

    # Get file size
    ser.reset_input_buffer()
    ser.write(f"stat -c %s {remote_path} 2>/dev/null || wc -c < {remote_path}\r\n".encode())
    time.sleep(2)
    size_data = ser.read(ser.in_waiting or 256).decode("utf-8", errors="replace")
    file_size = 0
    for part in size_data.split():
        if part.strip().isdigit():
            file_size = int(part.strip())
            break
    print(f"[extract] {remote_path} ({file_size} bytes) -> {local_path}")

    # Use dd + base64 in chunks to avoid buffer issues
    # 768 raw bytes -> 1024 base64 chars per chunk
    # But let's use bigger chunks for speed: 57 bytes -> 76 chars per base64 line
    # dd chunks of 4608 bytes -> ~6144 base64 chars (manageable for serial buffer)
    chunk_size = 4608
    offset = 0
    all_data = b""
    start_time = time.time()

    while True:
        ser.reset_input_buffer()
        cmd = f"dd if={remote_path} bs=1 skip={offset} count={chunk_size} 2>/dev/null | base64\r\n"
        ser.write(cmd.encode())

        # Read response
        raw = read_until_prompt(ser, timeout=15)
        text = raw.decode("utf-8", errors="replace")

        # Extract base64 lines (skip command echo and prompt)
        b64_text = ""
        for line in text.splitlines():
            s = line.strip()
            # Skip command echo, prompts, empty lines
            if not s or s.startswith("dd ") or s == "#" or "base64" in s:
                continue
            # Valid base64 chars only
            if all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\r\n" for c in s):
                b64_text += s

        if not b64_text:
            break

        try:
            chunk = base64.b64decode(b64_text)
        except Exception as e:
            print(f"\n[extract] base64 decode error at offset {offset}: {e}")
            print(f"[extract] Raw b64 ({len(b64_text)} chars): {b64_text[:100]}...")
            break

        if len(chunk) == 0:
            break

        all_data += chunk
        offset += len(chunk)

        elapsed = time.time() - start_time
        rate = offset / elapsed if elapsed > 0 else 0
        if file_size > 0:
            pct = offset * 100 // file_size
            eta = (file_size - offset) / rate if rate > 0 else 0
            print(f"\r[extract] {offset}/{file_size} bytes ({pct}%) {rate:.0f} B/s ETA {eta:.0f}s", end="", flush=True)
        else:
            print(f"\r[extract] {offset} bytes, {rate:.0f} B/s", end="", flush=True)

        if len(chunk) < chunk_size:
            break

    print()
    os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
    with open(local_path, "wb") as f:
        f.write(all_data)

    elapsed = time.time() - start_time
    print(f"[extract] Done: {len(all_data)} bytes in {elapsed:.1f}s ({len(all_data)/elapsed:.0f} B/s)")

    if file_size > 0 and len(all_data) != file_size:
        print(f"[extract] WARNING: Expected {file_size} bytes, got {len(all_data)}")

    return len(all_data)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: serial-extract.py <remote_path> [local_name]")
        print("       serial-extract.py --batch")
        sys.exit(1)

    ser = open_serial()
    os.makedirs(OUTDIR, exist_ok=True)

    if sys.argv[1] == "--batch":
        # Extract priority files
        files = [
            # Small databases first
            ("/var/db/lutron-db-default.sqlite", None),
            ("/var/db/lutron-db.sqlite", None),
            ("/var/db/lutron-platform-db-default.sqlite", None),
            ("/var/db/lutron-platform-db.sqlite", None),
            ("/var/db/lutron-runtime-db-default.sqlite", None),
            ("/var/db/lutron-runtime-db.sqlite", None),
            # Config
            ("/etc/lutron.d/lutron.conf", "lutron.conf"),
            # Coproc firmware updater (contains S19)
            ("/usr/sbin/lutron-coproc-firmware-update-app", None),
        ]
        for remote, local in files:
            try:
                extract_file(ser, remote, local)
            except Exception as e:
                print(f"[extract] ERROR extracting {remote}: {e}")
            print()
    else:
        local = sys.argv[2] if len(sys.argv) > 2 else None
        extract_file(ser, sys.argv[1], local)

    ser.close()
