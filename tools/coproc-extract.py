#!/usr/bin/env python3
"""
Extract and deobfuscate embedded S19 firmware from lutron-coproc-firmware-update-app binaries.

Obfuscation: polyalphabetic substitution cipher on printable ASCII (0x20-0x7E).
  decoded = ((encoded - key + 0x3F) % 95) + 0x20
  key starts at 0x49, increments by 1 per printable char, wraps mod 95.
  Non-printable chars (\r, \n) pass through and don't advance the key.

The key resets to 0x49 at the start of each embedded string literal.
Multiple S19 images are stored contiguously in .data — each starts with
the obfuscated S0 header signature "=z}/}~" (decodes to "S02B00").
"""

import hashlib
from pathlib import Path

SIGNATURE = b"=z}/}~"


def deobfuscate(data: bytes) -> str:
    key = 0x49
    out = bytearray()
    for b in data:
        if 0x20 <= b <= 0x7E:
            d = ((b - key + 0x3F) % 95) + 0x20
            key = (key + 1) % 95
            out.append(d)
        else:
            out.append(b)
    return out.decode('ascii', errors='replace')


def find_signature_offsets(data: bytes) -> list[int]:
    offsets = []
    pos = 0
    while True:
        idx = data.find(SIGNATURE, pos)
        if idx == -1:
            break
        offsets.append(idx)
        pos = idx + 1
    return offsets


def extract_blobs(data: bytes) -> list[tuple[int, str]]:
    """Find and deobfuscate all S19 blobs. Each signature = key reset point."""
    offsets = find_signature_offsets(data)
    if not offsets:
        return []

    # Find end of contiguous data block
    end_of_data = data.find(b'\x00', offsets[-1])
    if end_of_data == -1:
        end_of_data = len(data)

    boundaries = offsets + [end_of_data]
    blobs = []
    for i in range(len(offsets)):
        chunk = data[offsets[i]:boundaries[i + 1]]
        decoded = deobfuscate(chunk)
        blobs.append((offsets[i], decoded))
    return blobs


def parse_s19_info(s19_text: str) -> dict:
    info = {
        "s0_comment": "",
        "record_types": set(),
        "addr_min": 0xFFFFFFFF,
        "addr_max": 0,
        "data_bytes": 0,
        "line_count": 0,
    }
    for line in s19_text.strip().split('\n'):
        line = line.strip()
        if not line or line[0] != 'S':
            continue
        info["line_count"] += 1
        rtype = line[1]
        info["record_types"].add(rtype)

        if rtype == '0':
            try:
                info["s0_comment"] = bytes.fromhex(line[8:-2]).decode('ascii', errors='replace')
            except:
                pass
        elif rtype in ('1', '2', '3'):
            try:
                if rtype == '1':
                    addr = int(line[4:8], 16)
                    data_start = 8
                elif rtype == '2':
                    addr = int(line[4:10], 16)
                    data_start = 10
                else:
                    addr = int(line[4:12], 16)
                    data_start = 12
                data_hex = line[data_start:-2]
                data_len = len(data_hex) // 2
                info["data_bytes"] += data_len
                info["addr_min"] = min(info["addr_min"], addr)
                info["addr_max"] = max(info["addr_max"], addr + data_len)
            except:
                pass

    if info["addr_min"] == 0xFFFFFFFF:
        info["addr_min"] = 0
    return info


def guess_mcu(info: dict) -> str:
    lo, hi, size = info["addr_min"], info["addr_max"], info["data_bytes"]
    if lo >= 0x08000000:
        return f"EFR32 (0x{lo:08X}-0x{hi:08X}, {size // 1024}K)"
    elif lo >= 0x3000 and hi <= 0x40000:
        return f"HCS08 (0x{lo:04X}-0x{hi:04X}, {size // 1024}K)"
    elif lo >= 0x3000 and hi <= 0x80000:
        return f"HCS08-large (0x{lo:04X}-0x{hi:04X}, {size // 1024}K)"
    elif lo >= 0x4000 and hi <= 0x100000:
        return f"Kinetis/nRF (0x{lo:04X}-0x{hi:04X}, {size // 1024}K)"
    return f"Unknown (0x{lo:X}-0x{hi:X}, {size} bytes)"


def process_binary(binary_path: str, output_dir: Path, prefix: str, global_seen: dict) -> int:
    with open(binary_path, 'rb') as f:
        data = f.read()

    blobs = extract_blobs(data)
    if not blobs:
        return 0

    extracted = 0
    for offset, s19 in blobs:
        info = parse_s19_info(s19)
        if info["data_bytes"] == 0:
            continue

        h = hashlib.sha256(s19.encode()).hexdigest()[:16]
        mcu = guess_mcu(info)

        print(f"  [{extracted + 1}] {mcu}")
        print(f"      S0: {info['s0_comment'][:80]}")
        print(f"      {info['line_count']} lines, {info['data_bytes']} bytes, types={sorted(info['record_types'])}")
        print(f"      SHA256: {h}, offset=0x{offset:X}")

        if h in global_seen:
            print(f"      -> Duplicate of {global_seen[h]}")
        else:
            lo = info["addr_min"]
            if lo >= 0x08000000:
                arch = "efr32"
            elif lo >= 0x4000 and info["addr_max"] > 0x40000:
                arch = "kinetis"
            else:
                arch = "hcs08"
            name = f"{prefix}_{arch}_{info['addr_min']:X}-{info['addr_max']:X}.s19"
            out_path = output_dir / name
            with open(out_path, 'w') as f:
                f.write(s19)
            print(f"      -> Saved: {name}")
            global_seen[h] = name
            extracted += 1
        print()

    return extracted


def main():
    binaries = [
        ("phoenix", "data/firmware/phoenix-device/binaries/lutron-coproc-firmware-update-app"),
        ("caseta-ra2sel", "data/firmware/caseta-ra2select/v08.25.17f000/rootfs/usr/sbin/lutron-coproc-firmware-update-app"),
        ("caseta-ra2sel-old", "data/firmware/caseta-ra2select/rootfs/tmp/extracted/usr/sbin/lutron-coproc-firmware-update-app"),
        ("vive", "data/firmware/vive/v01.30.04-decrypted/rootfs-full/usr/sbin/lutron-coproc-firmware-update-app"),
        ("vive-hub", "data/vive-hub/lutron-coproc-firmware-update-app"),
        ("vive-proto", "data/firmware/vive-prototype/rootfs-extracted/rootfs/usr/sbin/lutron-coproc-firmware-update-app"),
        ("vive-proto-007", "data/firmware/vive-prototype/rootfs-00.07.03/usr/sbin/lutron-coproc-firmware-update-app"),
        ("caseta-sb", "data/firmware/caseta-smartbridge/rootfs/usr/sbin/lutron-coproc-firmware-update-app"),
        ("caseta-sb-0205", "data/firmware/caseta-smartbridge/rootfs-02.05.00a000/usr/sbin/lutron-coproc-firmware-update-app"),
        ("caseta-sb-0210", "data/firmware/caseta-smartbridge/rootfs-02.10.03a000/usr/sbin/lutron-coproc-firmware-update-app"),
        ("rr-sel-rep2", "data/rr-sel-rep2/usr/sbin/lutron-coproc-firmware-update-app"),
    ]

    repo_root = Path(__file__).resolve().parent.parent
    output_dir = repo_root / "data" / "firmware" / "phoenix-device" / "coprocessor"
    output_dir.mkdir(parents=True, exist_ok=True)

    global_seen = {}
    total = 0

    for prefix, rel_path in binaries:
        full_path = repo_root / rel_path
        if not full_path.exists():
            continue

        size_mb = full_path.stat().st_size / (1024 * 1024)
        print(f"{'=' * 70}")
        print(f"{prefix} ({size_mb:.1f} MB): {rel_path}")

        n = process_binary(str(full_path), output_dir, prefix, global_seen)
        if n == 0 and not find_signature_offsets(open(full_path, 'rb').read()):
            print("  No embedded firmware (uses external .s19 or different obfuscation)\n")
        total += n

    # Show existing cleartext S19 files
    print(f"{'=' * 70}")
    print("Existing cleartext S19 files:")
    for name, path in [
        ("vive-hub", "data/vive-hub/coproc-firmware.s19"),
        ("rr-sel-rep2", "data/rr-sel-rep2/coproc-firmware.s19"),
    ]:
        full = repo_root / path
        if full.exists():
            info = parse_s19_info(open(full).read())
            print(f"  {name}: {guess_mcu(info)} — S0: {info['s0_comment'][:60]}")

    print(f"\n{'=' * 70}")
    print(f"Extracted {total} unique firmware images to {output_dir.relative_to(repo_root)}/")


if __name__ == "__main__":
    main()
