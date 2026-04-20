# Grafik Eye QS Firmware

Reverse-engineering notes for Grafik Eye QS firmware (models QSGR-* 512kB hardware).

## Acquisition

Firmware ships with Designer install — despite older training notes suggesting otherwise ([training-notes-index.md](../reference/training-notes-index.md) cites 2014-era guidance). As of Designer 26.2.0.113, the updater is launched from *within* Designer (Tools → Upgrade QS Devices → Grafik Eye QS) and the payload lives at:

```
C:\Users\<user>\AppData\Local\Packages\LutronElectronics.LutronDesigner26.2.0.113_hb4qhwkzq4pcy\LocalCache\Local\Lutron Designer 26.2.0.113\Firmware\qs_firmware_and_tools\QSG\QSGR (512kB - new hardware)\Grafik Eye QS Firmware Updater 8-027.zip
```

Archived locally at `data/firmware-re/grafik-eye/Grafik Eye QS Firmware Updater 8-027.zip` (gitignored).

Zip contents:

| File | Size | Role |
|------|------|------|
| `Grafik Eye QS Firmware Updater.exe` | 616 KB | Win32 GUI updater (VS C++/MFC, PE32 x86) |
| `sysconfig32.dll` | 1.09 MB | **Firmware payload** — not a real DLL, file(1) reports `data` |
| `sysconfig64.dll` | 1.09 MB | Same, matching x64 build |

Build path in PDB string: `c:\projects\qsg_builds\8_xx\usb_updater\release\Grafik Eye QS Firmware Updater.pdb` — confirms this is the "USB updater" for QSG, build 8.xx line.

Designer 26.2 UI still shows `9.029 (434|434L|865|868|868L)SQHR` as the "current" firmware — so the bundled 8-027 is likely a floor, with Designer pulling newer builds from the CDN at runtime. Worth capturing a newer version the next time Designer is online.

## Payload format

The "sysconfig" files are a custom format where **the file is its own key**. Analysis in Binary Ninja against `Grafik Eye QS Firmware Updater.exe`:

### Overall structure

| Region | Offset | Role |
|--------|--------|------|
| Header (4 KB) | 0x000 – 0xFFF | Stride-16 description string + key tables |
| Payload | 0x1000 – (EOF-0x190) | Encrypted firmware body (block cipher via `sub_401880`) |
| Trailer (400 B) | last 0x190 bytes | 256-byte S-Box + 6 more 16-byte tables |

### Striped header

Each 16-byte row of the header has 1 "label" byte at position 0 and 15 "data" bytes at positions 1-15. The description string is recovered by taking `d[i*16]` until a null:

```
>>> bytes(d[i*16] for i in range(0xc7) if d[i*16])
b'10 GRX 08.027 (434 | 434L | 865 | 868 | 868L) SQHR'
```

Which tells us:
- `10` — format/algorithm version tag (EXE checks this at [sub_402410+0x299](bn://sub_402410))
- `GRX` — device signature (must match or "Detected firmware data is not for Grafik Eye")
- `08.027` — firmware version (confirmed as 8.027)
- `(434|434L|865|868|868L)` — RF band variants this firmware supports
- `SQHR` — product/SKU code

After the 50-char description (ending at offset `50*16 = 0x320`), the header's non-label bytes (positions 1-15 of each row, read by a cursor that skips `eax_30 & 0xf == 0`) carry the key tables.

### Key tables (all loaded from the file itself)

Parsed by `sub_402410` from the header/trailer — each byte is offset-biased during load:

| Dest | Size | Bias applied | Source |
|------|------|--------------|--------|
| `data_44d0a0` | 16 | +0x70 | header |
| `data_44b064` | 16 | +0x10 | header |
| `data_44b02c` | 16 | +0x60 | header |
| `data_44abd8` | 16 | -0x60 | header |
| `data_44ac24` | 16 | -0x70 | header |
| `data_44abe8` | 16 | -0x20 | header |
| `data_44b014` | 16 | -0x30 | header |
| **`data_44b074`** | **8** | 0 | **header — initial cipher state / IV** |
| **`data_44ac1c`** | **4** | 0 | **header — first 4 bytes processed** |
| `data_44ac0c` | 16 | 0 | trailer |
| `data_44b034` | 16 | -0x10 | trailer |
| `data_44ac38` | 16 | -0x50 | trailer |
| `data_44d0c8` | **256** | 0 (memcpy) | **trailer — primary S-Box** |
| `data_44abf8` | 16 | +0x30 | trailer |
| `data_44b054` | 16 | +0x20 | trailer |
| `data_44d090` | 16 | +0x50 | trailer |
| `data_44b07c` | 16 | -0x40 | trailer |
| `data_44abb8` | 16 | -0x80 | trailer |
| `data_44d0b4` | 16 | +0x40 | trailer |

`data_4480d0` (at 0x4480d0 in .data) is a static 16-entry table of pointers to these loaded tables — indexed by nibbles of the running cipher state to pick which sub-table to use.

### Cipher primitive (`sub_401880`)

Per-byte stream cipher with 8-byte running state. Input: 1 byte. Output: 1 byte. State: `data_44d204..data_44d20b` (initialized from `data_44b074` on first call).

Pseudocode of the round:

```python
def decrypt_byte(b, state):
    x = sbox[b]                        # data_44d0c8[b]
    # 4 rounds of "pick sub-table by state-nibble, lookup by combined nibble"
    t1 = tables[state[7] >> 4][(x >> 4)]
    t2 = tables[state[4] & 0xf][t1]
    t3 = tables[state[1] >> 4][t2]
    a  = tables[state[5] & 0xf][t3]
    # Second chain
    t4 = tables[state[6] & 0xf][(x & 0xf)]
    t5 = tables[state[0] >> 4][t4]
    t6 = tables[state[2] & 0xf][t5]
    b  = tables[state[3] >> 4][t6]
    # Recombine nibbles with bit-mask games
    out = ((b & 3) | (a & 0xc) | (a << 4))
    out = (out * 4) | ((b >> 2) & 3)
    # Shift state: drop state[0], append b
    state = state[1:] + bytes([b])
    return out, state
```

(Exact bit operations need confirmation from the function's LLIL — the high-level decompilation had some compiler artifacts.)

### Implications

Because every table is bundled with the ciphertext, anyone with `sysconfig32.dll` has everything needed to decrypt offline. This is format-level obfuscation, not cryptographic security.

## Extraction — working

Decryptor at [tools/grafik-eye-decrypt.py](../../tools/grafik-eye-decrypt.py) implements the full pipeline. Running against `sysconfig32.dll`:

```
Description:     '10 GRX 08.027 (434 | 434L | 865 | 868 | 868L) SQHR'
Payload start:   0x85
IV:              83cd3db8d30c3bd0
Start bytes:     976eeacf
Primed outputs:  0000a061  -> record_count = 41057 records
Decrypted:       1,096,964 bytes of plaintext
```

Parsed as binary S-records (type, length, addr, data, checksum — checksums **all 41057 verified**). Results written to `data/firmware-re/grafik-eye/`:

| File | Size | Contents |
|------|------|----------|
| `grafik-eye-qs-8.027.s19` | 2.2 MB | Reformatted Motorola S-record (ASCII) |
| `grafik-eye-qs-8.027-00008000-0007e913.bin` | 485 KB | **Main MCU code** — M68K/ColdFire (`N^Nu` epilogues, "GRX 8-27" banner) |
| `grafik-eye-qs-8.027-90000000-9004efb7.bin` | 324 KB | **UI resource region** — string table for menus (Scenes, Fade time, Master raise, RadioRA 2, Timeclock, Holiday, Daylight menu, Occ Sensor, Password, IR Menu, CCI Menu, …) |

The M68K/ColdFire identification supersedes our earlier HCS08 guess — Grafik Eye QS runs an MC68K-family MCU (likely ColdFire V1/V2 given the size). The 0x90000000-space region is separate flash for localized UI text/resources — worth disassembling to enumerate every UI menu that exists in the firmware.

## Next steps

1. **Load the 0x8000 region into Ghidra/BN** with M68K architecture to see code layout. Reset vector is at start of the region; interrupt vectors follow.
2. **Dump all UI strings** from the 0x90000000 region — likely reveals hidden menus and features that aren't in the user manual.
3. **Bump Designer to latest**, check if the bundled payload has moved to 9.029 and re-run the decryptor (expect the same cipher, different key tables).
4. **Enumerate the firmware CDN** for `QSGR`, `grafikeye`, `qsg*` paths to find delta/OTA builds — see [security/firmware-cdn.md](../security/firmware-cdn.md).
5. **Check other Designer-bundled firmware** — every `qs_firmware_and_tools/*/v*.s19` is already plaintext. Only Grafik Eye was wrapped in a custom loader; the rest should be direct-dumpable.

## Target MCU

Grafik Eye QS hardware family: 512 KB flash / "new hardware" branch → likely HCS08 or Kinetis. USB (mini-B on older / micro-B on newer) connects through on-board USB-to-UART bridge (Silicon Labs CP210x suspected — matches the "sysconfig" naming convention, which is the CP210x customization SDK term). The updater almost certainly talks to the MCU over CP210x-VCP at a vendor-specific baud.
