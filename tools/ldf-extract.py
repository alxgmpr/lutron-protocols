#!/usr/bin/env python3
"""
Strip the 0x80-byte LDF container header from a Lutron `.ldf` file and emit
the raw HCS08 firmware body.

LDF format (per docs/firmware-re/powpak.md):

  0x00-0x3F : ASCII filename, NUL-padded (64 bytes)
  0x40-0x7F : metadata, 16 BE32 fields including file_size, version (0x02),
              header-trailer-length (0x7C), product-class marker (0x000117xx),
              CRC32 of section A, size_a, record_count, size_b, CRC32 of B.
  0x80+     : plaintext compiled HCS08 image (banked, MC9S08QE128 likely).

The body has two sections delimited by `Copyright 2008 Lutron Electronics`
banners. Section A is the bootloader/platform (~58 KB), Section B is the
application (~42-54 KB). DeviceClass lives at body offset 0x8AD.

Usage:
  tools/ldf-extract.py <input.ldf>                  # writes <input>.bin alongside
  tools/ldf-extract.py <input.ldf> -o <out.bin>     # explicit output path
  tools/ldf-extract.py <input.ldf> --info           # parse + dump header, no extract
"""

import argparse
import struct
import sys
from pathlib import Path

HEADER_LEN = 0x80
META_OFFSET = 0x40


def parse_header(blob: bytes) -> dict:
    if len(blob) < HEADER_LEN:
        raise ValueError(f"file too short: {len(blob)} < {HEADER_LEN}")
    filename = blob[:0x40].rstrip(b"\x00").decode("ascii", errors="replace")
    meta = struct.unpack(">16I", blob[META_OFFSET:HEADER_LEN])
    return {
        "filename": filename,
        "file_size": meta[0],
        "format_version": meta[2],
        "header_trailer_len": meta[4],
        "field_0x14": meta[5],
        "product_class_marker": meta[7],
        "hash1": meta[8],
        "size_a": meta[10],
        "record_count": meta[11],
        "size_b": meta[13],
        "hash2": meta[14],
    }


def extract(src: Path, dst: Path) -> None:
    blob = src.read_bytes()
    body = blob[HEADER_LEN:]
    dst.write_bytes(body)
    print(f"{src.name}: {len(blob)} bytes -> {len(body)} body bytes -> {dst}")


def info(src: Path) -> None:
    blob = src.read_bytes()
    h = parse_header(blob)
    print(f"file: {src}")
    print(f"  size on disk:   {len(blob)}")
    for k, v in h.items():
        if isinstance(v, int):
            print(f"  {k}: {v} (0x{v:08x})")
        else:
            print(f"  {k}: {v!r}")
    body = blob[HEADER_LEN:]
    if len(body) >= 0x8B0:
        device_class = body[0x8AD : 0x8AD + 4].hex()
        print(f"  device_class @ body[0x8AD]: {device_class}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path, help="input .ldf file")
    ap.add_argument("-o", "--output", type=Path, help="output .bin path (default: alongside input)")
    ap.add_argument("--info", action="store_true", help="dump parsed header instead of extracting")
    args = ap.parse_args()

    if not args.input.is_file():
        print(f"missing: {args.input}", file=sys.stderr)
        return 1

    if args.info:
        info(args.input)
        return 0

    out = args.output or args.input.with_suffix(".bin")
    extract(args.input, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
