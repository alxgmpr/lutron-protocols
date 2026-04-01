#!/usr/bin/env python3
"""Full device dump from RR-SEL-REP2 over serial.

Strategy:
1. Dump small MTD partitions raw (SPL, U-Boot, env, kernel, DTB) ~14MB
2. Create tarball of key rootfs files on-device, extract over serial
3. Skip raw RFS (mtd11, 242MB) — impractical over serial
"""
import sys
import time
import os
import base64
import hashlib
import serial

PORT = os.environ.get("SERIAL_PORT", "/dev/tty.usbserial-4240")
BAUD = 115200
OUTDIR = "/Volumes/Secondary/lutron-tools/data/rr-sel-rep2"

def open_serial():
    ser = serial.Serial(PORT, BAUD, timeout=2)
    ser.reset_input_buffer()
    ser.write(b"\r\n")
    time.sleep(0.5)
    ser.reset_input_buffer()
    return ser

def read_response(ser, timeout=30):
    """Read until no new data for 2s."""
    data = b""
    deadline = time.time() + timeout
    last = time.time()
    while time.time() < deadline:
        chunk = ser.read(max(ser.in_waiting, 1))
        if chunk:
            data += chunk
            last = time.time()
        elif data and time.time() - last > 2:
            break
        time.sleep(0.01)
    return data

def cmd(ser, c, wait=5):
    ser.reset_input_buffer()
    ser.write((c + "\r\n").encode())
    data = read_response(ser, timeout=wait)
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    return "\n".join(l for l in lines if l.strip() not in (c.strip(), "#"))

def extract_base64_stream(ser, shell_cmd, local_path, expected_size=0, timeout=600):
    """Run a shell command that outputs base64, decode and save."""
    print(f"[dump] -> {local_path}")
    ser.reset_input_buffer()
    ser.write((shell_cmd + "\r\n").encode())

    # Collect all base64 output
    data = b""
    deadline = time.time() + timeout
    last = time.time()
    start = time.time()

    while time.time() < deadline:
        chunk = ser.read(max(ser.in_waiting, 1))
        if chunk:
            data += chunk
            last = time.time()
            # Progress
            decoded_est = len(data) * 3 // 4  # rough base64 ratio
            elapsed = time.time() - start
            rate = len(data) / elapsed if elapsed > 0 else 0
            print(f"\r[dump] received {len(data)} bytes ({decoded_est} decoded est), {rate:.0f} B/s raw", end="", flush=True)
        elif data and time.time() - last > 3:
            break
        time.sleep(0.01)

    print()
    text = data.decode("utf-8", errors="replace")

    # Extract only valid base64 lines
    b64_text = ""
    for line in text.splitlines():
        s = line.strip()
        if not s or len(s) < 4:
            continue
        # Skip command echo and prompt
        if s.startswith("dd ") or s.startswith("cat ") or s.startswith("tar ") or s == "#":
            continue
        if "base64" in s or "/dev/mtd" in s or "gzip" in s:
            continue
        if all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\r\n" for c in s):
            b64_text += s

    try:
        decoded = base64.b64decode(b64_text)
    except Exception as e:
        print(f"[dump] base64 decode error: {e}")
        # Save raw for debugging
        with open(local_path + ".b64.raw", "w") as f:
            f.write(b64_text[:1000])
        return 0

    os.makedirs(os.path.dirname(local_path) or OUTDIR, exist_ok=True)
    with open(local_path, "wb") as f:
        f.write(decoded)

    md5 = hashlib.md5(decoded).hexdigest()
    elapsed = time.time() - start
    print(f"[dump] Wrote {len(decoded)} bytes, md5={md5}, {elapsed:.1f}s")

    if expected_size and len(decoded) != expected_size:
        print(f"[dump] WARNING: expected {expected_size}, got {len(decoded)}")

    return len(decoded)

def extract_file_chunked(ser, remote_path, local_path, file_size=0):
    """Extract using dd+base64 in chunks (reliable for large files)."""
    print(f"[dump] {remote_path} ({file_size} bytes) -> {local_path}")
    chunk_size = 4608  # 4608 raw -> 6144 base64
    offset = 0
    all_data = b""
    start = time.time()

    while True:
        ser.reset_input_buffer()
        c = f"dd if={remote_path} bs=1 skip={offset} count={chunk_size} 2>/dev/null | base64\r\n"
        ser.write(c.encode())

        raw = read_response(ser, timeout=15)
        text = raw.decode("utf-8", errors="replace")

        b64 = ""
        for line in text.splitlines():
            s = line.strip()
            if not s or s.startswith("dd ") or s == "#" or "base64" in s:
                continue
            if all(ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\r\n" for ch in s):
                b64 += s

        if not b64:
            break

        try:
            chunk = base64.b64decode(b64)
        except Exception as e:
            print(f"\n[dump] decode error at offset {offset}: {e}")
            break

        if not chunk:
            break

        all_data += chunk
        offset += len(chunk)
        elapsed = time.time() - start
        rate = offset / elapsed if elapsed > 0 else 0
        if file_size:
            pct = offset * 100 // file_size
            eta = (file_size - offset) / rate if rate > 0 else 0
            print(f"\r[dump] {offset}/{file_size} ({pct}%) {rate:.0f} B/s ETA {eta:.0f}s   ", end="", flush=True)
        else:
            print(f"\r[dump] {offset} bytes, {rate:.0f} B/s", end="", flush=True)

        if len(chunk) < chunk_size:
            break

    print()
    os.makedirs(os.path.dirname(local_path) or OUTDIR, exist_ok=True)
    with open(local_path, "wb") as f:
        f.write(all_data)

    md5 = hashlib.md5(all_data).hexdigest()
    elapsed = time.time() - start
    print(f"[dump] Done: {len(all_data)} bytes, md5={md5}, {elapsed:.1f}s")

    if file_size and len(all_data) != file_size:
        print(f"[dump] WARNING: expected {file_size}, got {len(all_data)}")

    return len(all_data)

def verify_md5(ser, remote_path, local_path):
    """Verify file integrity using md5sum on device."""
    result = cmd(ser, f"md5sum {remote_path}", wait=10)
    remote_md5 = ""
    for part in result.split():
        if len(part) == 32 and all(c in "0123456789abcdef" for c in part):
            remote_md5 = part
            break

    if not remote_md5:
        print(f"[verify] Could not get remote md5 for {remote_path}")
        return False

    with open(local_path, "rb") as f:
        local_md5 = hashlib.md5(f.read()).hexdigest()

    match = remote_md5 == local_md5
    status = "OK" if match else "MISMATCH"
    print(f"[verify] {os.path.basename(local_path)}: {status} (remote={remote_md5}, local={local_md5})")
    return match

def main():
    ser = open_serial()
    os.makedirs(OUTDIR, exist_ok=True)

    mode = sys.argv[1] if len(sys.argv) > 1 else "all"

    if mode in ("all", "mtd"):
        # Phase 1: Dump MTD partitions (boot chain only)
        mtd_partitions = [
            ("mtd0", 0x20000, "spl1.bin"),
            ("mtd1", 0x20000, "spl2.bin"),
            # mtd2/3 are SPL backups — skip unless you want redundancy
            ("mtd4", 0x100000, "uboot.bin"),
            ("mtd5", 0x100000, "uboot-backup.bin"),
            ("mtd6", 0x20000, "uboot-env.bin"),
            ("mtd7", 0x500000, "kernel.bin"),
            # mtd8 is kernel backup — skip
            ("mtd9", 0x80000, "devicetree.dtb"),
            # mtd10 is DTB backup — skip
        ]

        print("=" * 60)
        print("Phase 1: MTD boot partition dumps")
        print("=" * 60)
        total = sum(s for _, s, _ in mtd_partitions)
        print(f"Total: {total} bytes ({total/1024/1024:.1f} MB), ETA ~{total/1770:.0f}s")
        print()

        for dev, size, name in mtd_partitions:
            local = os.path.join(OUTDIR, name)
            extract_file_chunked(ser, f"/dev/{dev}", local, file_size=size)
            print()

    if mode in ("all", "files"):
        # Phase 2: Individual key files
        print("=" * 60)
        print("Phase 2: Key files (databases, configs, binaries)")
        print("=" * 60)

        files = [
            # Databases (critical for RE)
            ("/var/db/lutron-db-default.sqlite", 965632),
            ("/var/db/lutron-db.sqlite", 965632),
            ("/var/db/lutron-platform-db-default.sqlite", 10240),
            ("/var/db/lutron-platform-db.sqlite", 10240),
            ("/var/db/lutron-runtime-db-default.sqlite", 20480),
            ("/var/db/lutron-runtime-db.sqlite", 20480),
            # Config
            ("/etc/lutron.d/lutron.conf", 0),
            # Coproc firmware (contains STM32 S19)
            ("/usr/sbin/lutron-coproc-firmware-update-app", 1525692),
            # Other binaries
            ("/usr/sbin/lutron-core", 5782260),
            ("/usr/sbin/leap-server.gobin", 13759355),
            ("/usr/sbin/lutron-button-engine", 0),
            ("/usr/sbin/lutron-eeprom-engine", 0),
            ("/usr/sbin/lutron-led-ui", 0),
            ("/usr/sbin/lutron-integration", 0),
            ("/usr/sbin/lutron-core-client", 0),
            ("/usr/sbin/lutron-eol", 0),
        ]

        for remote, size in files:
            name = os.path.basename(remote)
            local = os.path.join(OUTDIR, name)
            if os.path.exists(local) and os.path.getsize(local) == size and size > 0:
                print(f"[dump] {name} already exists ({size} bytes), skipping")
                continue
            extract_file_chunked(ser, remote, local, file_size=size)
            if size > 0:
                verify_md5(ser, remote, local)
            print()

    if mode in ("all", "ssl"):
        # Phase 3: SSL certs — tar and transfer
        print("=" * 60)
        print("Phase 3: SSL certificates and keys")
        print("=" * 60)

        # Create tarball on device and transfer
        tar_cmd = "tar czf /tmp/ssl-dump.tar.gz /etc/ssl/ /usr/share/lap-certs/ /root/.Remoteaccesskey/ /var/misc/auth/ 2>/dev/null"
        print(f"[dump] Creating tarball on device...")
        cmd(ser, tar_cmd, wait=10)

        # Get size
        size_out = cmd(ser, "wc -c < /tmp/ssl-dump.tar.gz", wait=3)
        tar_size = 0
        for p in size_out.split():
            if p.strip().isdigit():
                tar_size = int(p.strip())
                break
        print(f"[dump] SSL tarball: {tar_size} bytes")

        extract_file_chunked(ser, "/tmp/ssl-dump.tar.gz",
                            os.path.join(OUTDIR, "ssl-dump.tar.gz"), file_size=tar_size)
        cmd(ser, "rm /tmp/ssl-dump.tar.gz", wait=2)
        print()

    if mode in ("all", "rootfs"):
        # Phase 4: Rootfs inventory and key config files
        print("=" * 60)
        print("Phase 4: Rootfs tar (configs, init scripts, key dirs)")
        print("=" * 60)

        tar_cmd = (
            "tar czf /tmp/rootfs-key.tar.gz "
            "/etc/init.d/ /etc/monitrc /etc/lutron.d/ "
            "/usr/lib/lutron-system-time-hooks "
            "/usr/db/ "
            "/var/db/conversion-scripts/ /var/db/runtime-db-conversion-scripts/ "
            "/var/db/existing-db-converter.sh "
            "/tmp/sddpd.conf "
            "2>/dev/null"
        )
        print("[dump] Creating rootfs tarball on device...")
        cmd(ser, tar_cmd, wait=15)

        size_out = cmd(ser, "wc -c < /tmp/rootfs-key.tar.gz", wait=3)
        tar_size = 0
        for p in size_out.split():
            if p.strip().isdigit():
                tar_size = int(p.strip())
                break
        print(f"[dump] Rootfs tarball: {tar_size} bytes")

        extract_file_chunked(ser, "/tmp/rootfs-key.tar.gz",
                            os.path.join(OUTDIR, "rootfs-key.tar.gz"), file_size=tar_size)
        cmd(ser, "rm /tmp/rootfs-key.tar.gz", wait=2)

    print()
    print("=" * 60)
    print("Dump complete! Files in:", OUTDIR)
    print("=" * 60)
    ser.close()

if __name__ == "__main__":
    main()
