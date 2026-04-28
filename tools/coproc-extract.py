#!/usr/bin/env python3
"""
Extract and deobfuscate embedded S19 firmware from lutron-coproc-firmware-update-app binaries.

Three obfuscation variants observed (all share the same cipher core):

PHOENIX (bridge with CCA + CCX coprocs, 6MB binary):
  decoded = ((encoded - key + 0x3F) % 95) + 0x20
  key starts at 0x49, increments per printable char, wraps mod 95.
  Key RESETS at each embedded string literal (each S0..S7 record block).
  Multiple S19 blobs concatenated; each starts with obfuscated "=z}/}~" (= "S02B00").

CASETA-SMARTBRIDGE (older L-BDG2/SBP2, 0.3MB binary, 03.03.x firmware):
  Same algorithm, but key starts at 0x29 and runs CONTINUOUSLY across the entire
  S19 (no reset on CRLF or per record). Single embedded blob, no S0 header — starts
  directly with S3 records (32-bit address, STM32 Cortex-M target at 0x08000000).
  Located shortly after a 256-byte substitution-table data block in .rodata.

RA2 SELECT REP2 / Caseta Pro (1.5MB binary, 08.x firmware):
  Same cipher, continuous (no per-record reset), but multiple blobs concatenated
  with key0 changes between blobs (no embedded signature like Phoenix). Observed
  key0 values: 0x25 (HCS08 + first EFR32) and 0x7E (second EFR32). The blobs
  start at offsets the SmartBridge's narrow (0x6000, 0x20000) search misses —
  walker scans the full binary trying multiple key0 candidates.
"""

import hashlib
from pathlib import Path

SIGNATURE = b"=z}/}~"


def deobfuscate(data: bytes, key0: int = 0x49) -> str:
    key = key0
    out = bytearray()
    for b in data:
        if 0x20 <= b <= 0x7E:
            d = ((b - key + 0x3F) % 95) + 0x20
            key = (key + 1) % 95
            out.append(d)
        else:
            out.append(b)
    return out.decode('ascii', errors='replace')


VALID_BLOB_PREFIXES = (
    "S31508", "S20800", "S00500", "S00600", "S214", "S31408",
    "S107", "S207", "S22300", "S2080000", "S31300", "S205",
    "S006", "S00F", "S00E",
)


def _walk_srecords(decoded: str) -> str | None:
    """Take a deobfuscated stream and return the contiguous S-record run as text."""
    valid = []
    for line in decoded.split("\r\n"):
        if len(line) >= 4 and line[0] == "S" and line[1] in "0123789":
            try:
                int(line[2:], 16)
                valid.append(line)
                if line[1] in "789":  # end record terminates the blob
                    break
            except ValueError:
                break
        else:
            break  # first non-S-record line ends the blob
    if not valid:
        return None
    return "\r\n".join(valid) + "\r\n"


def _extract_blob_at(data: bytes, start: int, key0: int, max_len: int = 2_000_000) -> str | None:
    """Deobfuscate from start with key0, return contiguous S-record run."""
    return _walk_srecords(deobfuscate(data[start:start + max_len], key0))


def find_continuous_blob_start(data: bytes, key0: int = 0x29, search_range: tuple = (0x6000, 0x20000)) -> int:
    """Caseta-SmartBridge variant: scan for an offset where data decodes to a valid S-record."""
    lo, hi = search_range
    for start in range(max(0, lo), min(len(data), hi)):
        decoded = deobfuscate(data[start:start + 8], key0)
        if decoded.startswith(VALID_BLOB_PREFIXES):
            return start
    return -1


def extract_continuous_blob(data: bytes, key0: int = 0x29) -> str | None:
    """Caseta-SmartBridge variant: extract one continuous S19 stream (no per-record key reset)."""
    start = find_continuous_blob_start(data, key0)
    if start == -1:
        return None
    return _extract_blob_at(data, start, key0, max_len=300_000)


def extract_multi_continuous_blobs(
    data: bytes,
    key0_candidates: tuple[int, ...] = (0x25, 0x29, 0x7E),
    cursor: int = 0x1000,
    min_lines: int = 50,
    min_bytes: int = 1024,
) -> list[tuple[int, int, str]]:
    """
    RA2 Select REP2 variant: walk binary advancing past each found blob, trying
    each key0 candidate at every plausible offset. Returns [(offset, key0, s19_text), ...].
    """
    blobs: list[tuple[int, int, str]] = []
    while cursor < len(data):
        found = None
        for start in range(cursor, len(data)):
            if not (0x20 <= data[start] <= 0x7E):
                continue
            for key0 in key0_candidates:
                decoded = deobfuscate(data[start:start + 12], key0)
                if not decoded.startswith(VALID_BLOB_PREFIXES):
                    continue
                s19 = _extract_blob_at(data, start, key0)
                if s19 is None or s19.count("\r\n") < min_lines:
                    continue
                info = parse_s19_info(s19)
                if info["data_bytes"] < min_bytes:
                    continue
                found = (start, key0, s19)
                break
            if found:
                break
        if not found:
            break
        blobs.append(found)
        # Advance past this blob (encoded length ≈ decoded length, since the
        # cipher is byte-for-byte over printable chars).
        cursor = found[0] + len(found[2]) + 1
    return blobs


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
    is_continuous = False

    # Fall back to Caseta-SmartBridge variant: continuous stream, key0=0x29, no S0 header.
    if not blobs:
        s19 = extract_continuous_blob(data, key0=0x29)
        if s19:
            offset = find_continuous_blob_start(data, key0=0x29)
            blobs = [(offset, s19)]
            is_continuous = True

    # Final fallback: RA2 Select REP2 multi-blob walker (continuous, multiple
    # key0 values, no embedded signature).
    if not blobs:
        multi = extract_multi_continuous_blobs(data)
        if multi:
            blobs = [(off, s19) for (off, _key0, s19) in multi]
            is_continuous = True

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
            if is_continuous and prefix.startswith("caseta-sb"):
                # SmartBridge runs the bridge SoC itself (STM32 @ 0x08000000),
                # single blob, not an external coprocessor.
                arch = "stm32"
            elif lo >= 0x08000000:
                arch = "efr32"
            elif lo >= 0x4000 and info["addr_max"] > 0x40000:
                arch = "kinetis"
            else:
                arch = "hcs08"
            name = f"{prefix}_{arch}_{info['addr_min']:X}-{info['addr_max']:X}.s19"
            target_dir = output_dir
            if is_continuous:
                # Route SmartBridge variants to caseta-device, vive-* to
                # vive-prototype, RA2 Select REP2 to ra2select-device.
                if prefix.startswith("caseta-sb"):
                    target_dir = output_dir.parent.parent / "caseta-device" / "coproc-old"
                elif prefix.startswith("vive-proto"):
                    target_dir = output_dir.parent.parent / "vive-prototype" / "extracted"
                elif prefix.startswith("rr-sel-rep2"):
                    target_dir = output_dir.parent.parent / "ra2select-device" / "coprocessor"
                target_dir.mkdir(parents=True, exist_ok=True)
            out_path = target_dir / name
            with open(out_path, 'w') as f:
                f.write(s19)
            print(f"      -> Saved: {out_path.relative_to(output_dir.parent.parent.parent)}")
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
        ("lite-heron", "data/firmware/lite-heron-decrypted/sbin/lutron-coproc-firmware-update-app"),
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
