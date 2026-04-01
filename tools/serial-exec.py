#!/usr/bin/env python3
"""Execute commands on RR-SEL-REP2 over serial and capture output.

Usage:
    serial-exec.py "command"                    # Single command, print output
    serial-exec.py --script commands.txt        # Run commands from file
    serial-exec.py --extract /remote/path local # Transfer binary file via base64
    serial-exec.py --recon                      # Full system reconnaissance
"""
import sys
import time
import os
import base64
import serial

PORT = os.environ.get("SERIAL_PORT", "/dev/tty.usbserial-4240")
BAUD = 115200
OUTDIR = "/Volumes/Secondary/lutron-tools/data/rr-sel-rep2"

def open_serial():
    ser = serial.Serial(PORT, BAUD, timeout=1)
    ser.reset_input_buffer()
    return ser

def send_cmd(ser, cmd, wait=3, quiet=False):
    """Send a command and return the output lines."""
    ser.reset_input_buffer()
    ser.write(f"{cmd}\r\n".encode())
    time.sleep(0.1)

    output = b""
    deadline = time.time() + wait
    while time.time() < deadline:
        chunk = ser.read(ser.in_waiting or 1)
        if chunk:
            output += chunk
            # Reset deadline on new data (up to max wait)
            if time.time() + 1 < deadline + wait:
                pass  # Don't extend beyond original wait
        time.sleep(0.05)

    lines = output.decode("utf-8", errors="replace").splitlines()
    # Strip echo of our command and prompt lines
    result = []
    for line in lines:
        stripped = line.strip()
        if stripped == cmd.strip():
            continue
        result.append(line)

    if not quiet:
        for line in result:
            print(line)
    return result

def wake_up(ser):
    """Send empty commands to wake up and detect prompt."""
    ser.write(b"\r\n")
    time.sleep(0.5)
    ser.reset_input_buffer()
    ser.write(b"\r\n")
    time.sleep(0.5)
    data = ser.read(ser.in_waiting or 1)
    prompt = data.decode("utf-8", errors="replace").strip()
    print(f"[serial-exec] Prompt detected: '{prompt}'")
    return prompt

def extract_file(ser, remote_path, local_path):
    """Transfer a file from the device using base64 encoding."""
    print(f"[extract] {remote_path} -> {local_path}")

    # Get file size first
    size_lines = send_cmd(ser, f"wc -c < {remote_path}", wait=2, quiet=True)
    size_str = "".join(size_lines).strip()
    # Try to find the numeric size
    for part in size_str.split():
        if part.isdigit():
            print(f"[extract] File size: {part} bytes")
            break

    # Check if base64 is available
    b64_check = send_cmd(ser, "which base64 || which openssl", wait=2, quiet=True)
    has_base64 = any("base64" in l or "openssl" in l for l in b64_check)

    if not has_base64:
        # Try xxd or od fallback
        print("[extract] No base64, trying xxd hex dump...")
        return extract_file_hex(ser, remote_path, local_path)

    # Use base64 in chunks to avoid serial buffer overflow
    # Split the file and encode each chunk
    chunk_size = 768  # bytes per chunk (produces ~1024 base64 chars)
    offset = 0
    all_data = b""

    # First try simple base64
    print("[extract] Encoding with base64...")
    lines = send_cmd(ser, f"base64 {remote_path}", wait=30, quiet=True)
    b64_text = ""
    for line in lines:
        s = line.strip()
        # base64 lines are alphanumeric + /+=
        if s and all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\r\n" for c in s):
            b64_text += s

    if b64_text:
        try:
            all_data = base64.b64decode(b64_text)
            print(f"[extract] Decoded {len(all_data)} bytes")
        except Exception as e:
            print(f"[extract] base64 decode failed: {e}")
            return extract_file_chunked(ser, remote_path, local_path)
    else:
        return extract_file_chunked(ser, remote_path, local_path)

    os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
    with open(local_path, "wb") as f:
        f.write(all_data)
    print(f"[extract] Wrote {len(all_data)} bytes to {local_path}")
    return len(all_data)

def extract_file_chunked(ser, remote_path, local_path):
    """Extract large files in chunks using dd + base64."""
    print("[extract] Using chunked transfer...")
    chunk_size = 512
    offset = 0
    all_data = b""

    while True:
        cmd = f"dd if={remote_path} bs=1 skip={offset} count={chunk_size} 2>/dev/null | base64"
        lines = send_cmd(ser, cmd, wait=10, quiet=True)
        b64_text = ""
        for line in lines:
            s = line.strip()
            if s and all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\r\n" for c in s):
                b64_text += s

        if not b64_text:
            break

        try:
            chunk = base64.b64decode(b64_text)
        except:
            print(f"[extract] Decode error at offset {offset}")
            break

        if len(chunk) == 0:
            break

        all_data += chunk
        offset += len(chunk)
        print(f"[extract] {offset} bytes...", end="\r")

        if len(chunk) < chunk_size:
            break

    print()
    os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
    with open(local_path, "wb") as f:
        f.write(all_data)
    print(f"[extract] Wrote {len(all_data)} bytes to {local_path}")
    return len(all_data)

def extract_file_hex(ser, remote_path, local_path):
    """Extract file using xxd hex dump."""
    print("[extract] Using xxd hex transfer...")
    lines = send_cmd(ser, f"xxd -p {remote_path}", wait=60, quiet=True)
    hex_text = ""
    for line in lines:
        s = line.strip()
        if s and all(c in "0123456789abcdef\r\n" for c in s):
            hex_text += s

    if hex_text:
        data = bytes.fromhex(hex_text)
        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
        with open(local_path, "wb") as f:
            f.write(data)
        print(f"[extract] Wrote {len(data)} bytes to {local_path}")
        return len(data)
    else:
        print("[extract] No hex data captured")
        return 0

def recon(ser):
    """Full system reconnaissance."""
    outfile = os.path.join(OUTDIR, "recon.txt")
    commands = [
        ("uname -a", 2),
        ("cat /etc/os-release 2>/dev/null || cat /etc/issue", 2),
        ("cat /etc/version 2>/dev/null", 2),
        ("hostname", 2),
        ("uptime", 2),
        ("cat /proc/cpuinfo", 3),
        ("free 2>/dev/null || cat /proc/meminfo", 3),
        ("cat /proc/mtd", 2),
        ("cat /proc/cmdline", 2),
        ("mount", 2),
        ("df -h", 3),
        ("cat /proc/partitions", 2),
        ("ifconfig 2>/dev/null || ip addr", 3),
        ("ps aux 2>/dev/null || ps w", 5),
        ("ls -la /dev/mtd*", 3),
        ("ls -laR /usr/local/lutron/", 8),
        ("cat /usr/local/lutron/conf/lutron.conf", 5),
        ("cat /usr/local/lutron/version 2>/dev/null", 2),
        ("ls -la /etc/init.d/", 3),
        ("cat /etc/monitrc 2>/dev/null || cat /usr/local/lutron/conf/monitrc 2>/dev/null", 5),
        ("ls -laR /usr/local/lutron/ssl/ 2>/dev/null", 3),
        ("cat /proc/version", 2),
        # STM32 communication
        ("ls -la /dev/ttyO* /dev/ttyS* /dev/ttyAMA* 2>/dev/null", 2),
        ("ls -la /usr/local/lutron/bin/lutron-coproc*", 2),
        # Database info
        ("ls -la /usr/local/lutron/db/*.sqlite", 2),
        ("sqlite3 /usr/local/lutron/db/lutron-db.sqlite '.tables' 2>/dev/null", 3),
    ]

    with open(outfile, "w") as f:
        for cmd, wait in commands:
            header = f"\n{'='*60}\n=== CMD: {cmd}\n{'='*60}"
            print(header)
            f.write(header + "\n")
            lines = send_cmd(ser, cmd, wait=wait, quiet=False)
            for line in lines:
                f.write(line + "\n")
            f.write("\n")

    print(f"\n[recon] Output saved to {outfile}")

if __name__ == "__main__":
    ser = open_serial()
    wake_up(ser)

    if len(sys.argv) < 2:
        print("Usage: serial-exec.py <command> | --recon | --extract <remote> <local>")
        sys.exit(1)

    if sys.argv[1] == "--recon":
        recon(ser)
    elif sys.argv[1] == "--extract":
        if len(sys.argv) < 4:
            print("Usage: serial-exec.py --extract <remote_path> <local_path>")
            sys.exit(1)
        extract_file(ser, sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "--script":
        with open(sys.argv[2]) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    send_cmd(ser, line, wait=3)
    else:
        cmd = " ".join(sys.argv[1:])
        send_cmd(ser, cmd, wait=5)

    ser.close()
