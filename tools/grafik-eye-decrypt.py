#!/usr/bin/env python3
"""
Grafik Eye QS firmware decryptor.

Decrypts `sysconfig{32,64}.dll` blobs shipped inside the "Grafik Eye QS Firmware
Updater" and emits the plaintext byte stream (binary S-record fields). The
format is self-contained — the file carries its own S-Box, sub-tables, and IV.

Format (see docs/firmware-re/grafik-eye.md):
  - first 0x1000 bytes: striped header (1 label byte + 15 data bytes per row)
  - middle: encrypted payload
  - last  0x190 bytes: trailer with 256-byte S-Box + 6 more 16-byte tables

Cipher:
  - 8-byte sliding state initialized from header IV
  - Per byte: sbox[input] -> two 4-round chained nibble lookups -> bit-scramble
  - State[7] = input byte each round (stream feedback)
"""

import sys
from pathlib import Path


def load_tables(path):
    data = Path(path).read_bytes()
    tables = [None] * 16
    sbox = None
    iv = None
    start = None

    # --- HEADER (striped, stride 16) ---
    header = data[:0x1000]
    descr_bytes = []
    for i in range(0xc7):
        b = header[i * 16]
        if b == 0:
            break
        descr_bytes.append(b)
    description = bytes(descr_bytes).decode("ascii", errors="replace")
    descr_len = len(descr_bytes)
    edi_1 = descr_len << 4  # end-of-description marker = descrlen * 16

    # Stream reader that mimics the updater: skip byte when cursor & 0xf == 0
    def make_stream(buf, edi):
        pos = [0]
        esi = [0]

        def next_byte():
            if esi[0] == 0:
                if (pos[0] & 0xf) == 0:
                    pos[0] += 1
                if pos[0] > edi:
                    esi[0] = 1
            b = buf[pos[0]]
            pos[0] += 1
            return b
        return next_byte

    hdr_next = make_stream(header, edi_1)

    # 7 tables loaded from header, each 16 bytes, with a bias adjustment.
    # Order and (table index, bias) from sub_402410 in BN:
    header_layout = [
        (9,  0x70),   # data_44d0a0
        (15, 0x10),   # data_44b064
        (10, 0x60),   # data_44b02c
        (6,  -0x60),  # data_44abd8
        (7,  -0x70),  # data_44ac24
        (2,  -0x20),  # data_44abe8
        (3,  -0x30),  # data_44b014
    ]
    for tidx, bias in header_layout:
        tables[tidx] = bytes((hdr_next() + bias) & 0xff for _ in range(16))
    iv = bytes(hdr_next() for _ in range(8))       # data_44b074
    start = bytes(hdr_next() for _ in range(4))    # data_44ac1c

    # Remember cursor inside the original file: number of bytes consumed
    # from the header so far (we need this for payload alignment).
    # The updater stores this as data_44ac08 after the header loop.
    header_cursor = 0
    for tidx, _ in header_layout:
        header_cursor += 16
    header_cursor += 8 + 4  # IV + start
    # This isn't directly equal to the file byte offset, because of skip-bytes.
    # The updater uses eax_30 which IS the raw byte cursor. Recompute:
    eax_30 = 0
    esi = 0
    for _ in range(header_cursor):
        if esi == 0:
            if (eax_30 & 0xf) == 0:
                eax_30 += 1
            if eax_30 > edi_1:
                esi = 1
        eax_30 += 1
    # The updater seeks the FILE to (eax_30 & ~0xf) and reads into a buffer,
    # but payload PROCESSING begins at buffer offset (eax_30 & 0xf), i.e.
    # still at the raw eax_30. So our payload cursor starts at eax_30 itself.
    payload_start = eax_30

    # --- TRAILER (last 0x190 bytes, no striping) ---
    trailer = data[-0x190:]
    tables[0]  = bytes((b + 0x00) & 0xff for b in trailer[   0:  16])  # data_44ac0c
    tables[1]  = bytes((b - 0x10) & 0xff for b in trailer[  16:  32])  # data_44b044
    tables[5]  = bytes((b - 0x50) & 0xff for b in trailer[  32:  48])  # data_44ac38
    sbox       = bytes(trailer[48:48 + 256])                           # data_44d0c8
    tables[13] = bytes((b + 0x30) & 0xff for b in trailer[304:320])    # data_44abf8
    tables[14] = bytes((b + 0x20) & 0xff for b in trailer[320:336])    # data_44b054
    tables[11] = bytes((b + 0x50) & 0xff for b in trailer[336:352])    # data_44d090
    tables[4]  = bytes((b - 0x40) & 0xff for b in trailer[352:368])    # data_44b07c
    tables[8]  = bytes((b - 0x80) & 0xff for b in trailer[368:384])    # data_44abb8
    tables[12] = bytes((b + 0x40) & 0xff for b in trailer[384:400])    # data_44d0b4

    assert all(t is not None for t in tables), "Missing sub-table(s)"
    assert len(sbox) == 256

    return {
        "description": description,
        "descr_len": descr_len,
        "edi_1": edi_1,
        "tables": tables,
        "sbox": sbox,
        "iv": iv,
        "start": start,
        "payload_start": payload_start,
        "header_cursor_raw": eax_30,
    }


class Cipher:
    """Exact port of sub_401880 in the updater EXE."""
    def __init__(self, iv, sbox, tables):
        assert len(iv) == 8
        self.state = bytearray(iv)
        self.sbox = sbox
        self.tables = tables

    def decrypt_byte(self, inp):
        s = self.state
        t = self.tables
        x = self.sbox[inp]

        # Chain A — uses high nibble of sbox output
        a = t[s[7] >> 4][x >> 4]
        a = t[s[4] & 0xf][a]
        a = t[s[1] >> 4][a]
        a = t[s[5] & 0xf][a]

        # Chain B — uses low nibble of sbox output
        b = t[s[6] & 0xf][x & 0xf]
        b = t[s[0] >> 4][b]
        b = t[s[2] & 0xf][b]
        b = t[s[3] >> 4][b]

        # Bit-scramble recombination:
        #   bit 0,1 = (B >> 2) & 3
        #   bit 2,3 = (B & 3)
        #   bit 4,5 = (A & 0xc) >> 2  == (A >> 2) & 3
        #   bit 6,7 = A & 3
        out = (
            ((a & 3) << 6)
            | ((a & 0xc) << 2)
            | ((b & 3) << 2)
            | ((b >> 2) & 3)
        ) & 0xff

        # State shift: drop state[0], append input byte
        self.state = bytearray(s[1:]) + bytearray([inp])
        return out


def iter_payload_bytes(data, payload_start, edi_1):
    """Yield ciphertext bytes from `payload_start` onward, skipping label bytes
    (every offset where (pos & 0xf) == 0) until we run past edi_1, then
    continuing without skipping."""
    pos = payload_start
    esi = 1 if payload_start > edi_1 else 0
    while pos < len(data):
        if esi == 0:
            if (pos & 0xf) == 0:
                pos += 1
                if pos >= len(data):
                    return
            if pos > edi_1:
                esi = 1
        yield data[pos]
        pos += 1


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("input", help="sysconfig32.dll or sysconfig64.dll")
    p.add_argument("-o", "--output", default="plaintext.bin",
                   help="Output plaintext binary stream")
    p.add_argument("--dump-tables", action="store_true",
                   help="Print decoded tables and exit")
    p.add_argument("--max-bytes", type=int, default=0,
                   help="Max plaintext bytes to emit (0 = all)")
    args = p.parse_args()

    meta = load_tables(args.input)
    print(f"Description:     {meta['description']!r}")
    print(f"Descr length:    {meta['descr_len']}")
    print(f"edi_1:           0x{meta['edi_1']:x}")
    print(f"Payload start:   0x{meta['payload_start']:x}")
    print(f"IV:              {meta['iv'].hex()}")
    print(f"Start bytes:     {meta['start'].hex()}")
    print()

    if args.dump_tables:
        print("SBox (256 bytes):")
        for i in range(0, 256, 16):
            print("  " + " ".join(f"{b:02x}" for b in meta["sbox"][i:i + 16]))
        print()
        for i, t in enumerate(meta["tables"]):
            print(f"Table[{i:2d}]: {t.hex()}")
        return

    data = Path(args.input).read_bytes()
    cipher = Cipher(meta["iv"], meta["sbox"], meta["tables"])

    # Prime with the 4 "start" bytes (sub_405150 does this before payload):
    # These are run through the cipher and the outputs form data_44b040, a
    # 32-bit record count. We don't currently use it but must run them to
    # advance the state.
    primed = []
    for b in meta["start"]:
        primed.append(cipher.decrypt_byte(b))
    # data_44b040 = (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]
    record_count = (primed[0] << 24) | (primed[1] << 16) | (primed[2] << 8) | primed[3]
    print(f"Primed outputs:  {bytes(primed).hex()} -> record_count=0x{record_count:x} ({record_count})")

    # Decrypt the payload stream
    out = bytearray()
    n = 0
    for cb in iter_payload_bytes(data, meta["payload_start"], meta["edi_1"]):
        out.append(cipher.decrypt_byte(cb))
        n += 1
        if args.max_bytes and n >= args.max_bytes:
            break

    Path(args.output).write_bytes(out)
    print(f"Decrypted {len(out)} bytes -> {args.output}")

    # Spot-check: show first 64 bytes and any ASCII strings
    print("\nFirst 64 plaintext bytes:")
    print("  hex:  ", " ".join(f"{b:02x}" for b in out[:64]))
    print("  ascii:", "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in out[:64]))


if __name__ == "__main__":
    main()
