# Caseta SmartBridge Coproc Firmware Reverse Engineering

## TL;DR

The older Caseta **SmartBridge** (L-BDG2 / SBP2, device class `080E0101`) embeds
its coprocessor firmware directly inside the `lutron-coproc-firmware-update-app`
ELF binary using a **variant** of the same polyalphabetic substitution cipher
used by the newer Phoenix bridge — but with a different starting key
(`0x29` instead of `0x49`) and **no per-record key reset** (the key advances
continuously across the whole S19 stream). There is no S0 header; the blob
begins directly with `S3` records at flash address `0x08000000`.

There is **no external firmware file** on the SmartBridge rootfs (`.s19`,
`.bin`, `.fw`, `.ldf`) and **no fwupdate-style network fetch path** — the
init script `S71-coproc-firmware-update` simply runs
`lutron-coproc-firmware-update-app -s /dev/ttyO1` at boot, which loads the
embedded image and reflashes the coprocessor over UART if its version differs
from `/etc/lutron.d/lutron-coproc-version`.

Three SmartBridge variants were extracted and saved to
`data/firmware/caseta-device/coproc-old/`:

| File | Build version | Address range | Lines |
|------|---------------|---------------|-------|
| `caseta-sb_stm32_80031E4-801FB08.s19`        | 03.03.01 (rootfs / 02.08.00f000) | 0x080031E4–0x0801FB08 | 5047 |
| `caseta-sb-0205_stm32_80030B0-801FB08.s19`   | 03.03.01 (rootfs-02.05.00a000)   | 0x080030B0–0x0801FB08 | 5067 |
| `caseta-sb-0210_stm32_8003454-801FB08.s19`   | 03.03.03 (rootfs-02.10.03a000)   | 0x08003454–0x0801FB08 | 5078 |

Each S19 ends with `S705 0801 42B1 FE` (Cortex-M reset start address `0x080142B1`).
String `"Copyright 2014 Lutron Electronics"` appears at flash 0x08016CE8 in the
03.03.01 image.

The host system architecture is `STM32` (32-bit ARM Cortex-M, S3 records,
`0x08000000` flash base). The S19 starts 12–13 KB into flash, meaning a
small bootloader sits below at 0x08000000–0x080030xx that the OS-level
update tool never touches.

## Binary structure

`/usr/sbin/lutron-coproc-firmware-update-app` is an ARM32 ELF (linked against
GLIBC 2.4 / GCC 3.5 — much older than Phoenix's 4.4 / GCC newer):

```
size: 282,932 bytes
arch: ARMv5 EABI5, dynamically linked, stripped
glibc: 2.4 / GLIBCXX_3.4
```

Notable strings:

- `Coprocessor Updater` — main banner
- `Reading embedded s19` — confirms inline firmware (not external file)
- `Lutron Coprocessor Updater - Version: 03.04.01f000` — host program version
- `MC9S08*` MCU ID table — the same shared updater code supports HCS08 too,
  but it's the wrong path for SmartBridge (no Freescale chip present;
  the updater branches on bootloader protocol version reply)
- `Example: lutron-coproc-firmware-update-app -f os.s19 /dev/ttyS1`
- The 256-byte **substitution table at offset `0x7AA5`** (preceded by a small
  zero-pad) — visible in `strings` output as garbled rows like
  `8?61$#*-pw~ylkbeHOFATSZ]` and `WPY^KLEBohafst}z`. This table is just
  the precomputed `((plain - 0x20 + key) % 95) + 0x20` lookup for fast
  encoding/decoding by C++ code.

## Cipher details

Same algorithm as Phoenix (see `docs/firmware-re/coproc.md` and
`exploits/firmware-unlock/coproc-extract.py`):

```python
decoded = ((encoded - key + 0x3F) % 95) + 0x20
key     = (key + 1) % 95
# CR/LF (0x0A, 0x0D) pass through and do NOT advance the key
```

**SmartBridge differences from Phoenix:**

| Property                | Phoenix        | Caseta SmartBridge |
|-------------------------|----------------|--------------------|
| Initial key (`key0`)    | `0x49` (73)    | `0x29` (41)        |
| Key reset boundary      | every S0 blob  | never (continuous) |
| S0 header signature     | `=z}/}~`       | (none)             |
| First record type       | `S0`           | `S3` (32-bit addr) |
| Number of blobs         | up to 10       | 1 per binary       |

The Caseta blob has no S0 record, so we cannot search for a fixed signature.
Instead the extractor brute-forces a starting offset by trying each candidate
and checking whether the first 6 decoded bytes spell a plausible S-record
prefix (`S31508`, `S20800`, `S214`, etc.). This always lands on the true
start within ~8KB of search range.

## Extraction

`exploits/firmware-unlock/coproc-extract.py` now handles both variants:

1. First tries the Phoenix path: scan for `=z}/}~` signature, decode each
   blob with `key0 = 0x49` and per-blob key reset.
2. If no signatures are found, falls back to the SmartBridge path:
   `extract_continuous_blob(data, key0=0x29)` — scans for a valid
   S-record start and dumps until an end record (`S7/S8/S9`) or
   non-S-record line is hit.

Run:

```sh
python3 exploits/firmware-unlock/coproc-extract.py
```

The SmartBridge extracts go to `data/firmware/caseta-device/coproc-old/`.
The Phoenix and Vive extracts continue to land in
`data/firmware/phoenix-device/coprocessor/`.

**Side benefit:** the same fallback also extracted firmware from the previously-
broken `vive-prototype` binaries (`vive-proto`, `vive-proto-007`) which use the
same continuous/`key0=0x29` variant, yielding two new images.

## How firmware actually reaches the coproc

Discovery path:

1. `/etc/init.d/S71-coproc-firmware-update` runs at boot.
2. It compares `/etc/lutron.d/lutron-coproc-version` (e.g. `03.03.01`,
   shipped read-only with the rootfs) against
   `/var/misc/coproc-version-file` (last loaded version, persisted in flash).
3. If they differ, it invokes `lutron-coproc-firmware-update-app -s /dev/ttyO1`
   without `-f`, so the embedded S19 (key0=0x29 form) is the source.
4. The updater opens UART at `/dev/ttyO1` (TI AM335x serial port 1, this is
   a TS-7180/Timesys "armv7l" board), speaks Lutron's BLCP-style serial
   bootloader protocol, erases/programs/verifies blocks, and exits.
5. On success the active version file is copied into the persistent location
   so subsequent boots skip the upgrade.

Hence the **device firmware lives in the binary itself**, fetched by `opkg`
inside the `coproc-firmware-update-app` package
(part of the `data.tar.gz` payload of the rootfs `.deb` shipped from
`https://caseta.s3.amazonaws.com/<version>/`). There is no per-device-class
firmware file — one .deb update bumps every coproc image at once.

## Rootfs scan results

- No `.s19`, `.bin`, `.fw`, `.ldf`, or `.hex` files anywhere in any of the
  three rootfs payloads (02.05.00a000 / 02.08.00f000 / 02.10.03a000).
- `/lib/firmware/` does not exist.
- Large non-ELF files in rootfs are limited to: SQLite databases
  (`lutron-db-default.sqlite`, `lutron-platform-db-default.sqlite`,
  `lutron-runtime-db-default.sqlite`), `etc/openssh/moduli`,
  `etc/ssl/certs/ca-certificates.crt`, bison/lisp examples, kernel module
  index `.bin` files, and the `data.tar.gz` / `rootfs.tar.gz` themselves.
- The SmartBridge has no `fwupdate`, `mender`, `swupdate`, or similar
  framework — `firmwareUpgrade.sh` is just a wrapper around `opkg upgrade`
  for the OpenWrt-style package manager.

## CDN probe

Speculative paths under `caseta.s3.amazonaws.com` and
`firmware-downloads.iot.lutron.io` for *device* (vs bridge) firmware:

| URL | HTTP |
|-----|------|
| `https://caseta.s3.amazonaws.com/devices/`                        | 403 |
| `https://caseta.s3.amazonaws.com/dimmers/`                        | 403 |
| `https://caseta.s3.amazonaws.com/coproc/`                         | 403 |
| `https://caseta.s3.amazonaws.com/`                                | 403 |
| `https://firmware-downloads.iot.lutron.io/caseta-devices/`        | 404 |
| `https://firmware-downloads.iot.lutron.io/caseta/`                | 404 |
| `https://firmware-downloads.iot.lutron.io/caseta/devices/`        | 404 |
| `https://firmware-downloads.iot.lutron.io/`                       | 404 |
| `https://caseta.s3.amazonaws.com/02.08.00f000/coproc-firmware.s19`| 403 |
| `https://caseta.s3.amazonaws.com/02.08.00f000/`                   | 403 |

`403` from S3 typically means the bucket exists and the object key may exist
but the request lacks credentials or the key needs the exact name. None of
these speculative paths are useful without a known filename. The Caseta
SmartBridge does not appear to fetch device-level firmware from a separate
URL — see `docs/security/firmware-cdn.md` for the bridge-firmware paths
that **are** known.

## Next steps / unknowns

- The bootloader region (0x08000000 → 0x080030xx, ~12 KB) is **not** in any
  extracted S19 — it's burned at the factory and never reflashed. To recover
  it we'd need either a chip readout or a leaked production image.
- Unknown which exact STM32 part (F0/L0/F1?) and pinout. The S19 size
  (~80 KB code) and 0x08000000 base imply a ~128 KB/256 KB Cortex-M0/M3.
  Pulling pin labels from the board and dumping flash would resolve.
- The reset start address `0x080142B1` (T-bit set → Thumb) is a normal
  Cortex-M signature; binwalk/Ghidra import as Cortex-M0/M3 should work.
- `Copyright 2014 Lutron Electronics` is the only copyright string in the
  03.03.01 image, suggesting a 2014-vintage codebase frozen across all three
  builds.

## Punch list

| Tried                                                            | Result |
|------------------------------------------------------------------|--------|
| Run existing `coproc-extract.py` against SmartBridge variants    | nothing — confirmed prior expectation |
| `file` / strings on the binary                                   | ARM32 ELF, glibc 2.4, "Reading embedded s19", visible substitution table |
| Search rootfs for `.s19/.bin/.fw/.ldf/.hex` files                | none found |
| Brute-force `key0` 0x20–0x7E with continuous-key Phoenix algorithm | hit at `key0=0x29`, decodes `S31508003...` |
| Confirm key does/doesn't reset per CRLF                          | continuous (does NOT reset) |
| Bracket the blob start with prefix-validation scan               | start at offsets 0x9298–0x995C across variants |
| Bracket the blob end with first non-S-record line                | end at `S705...FE` (start address record) |
| Extract all 3 SmartBridge variants                               | 3 distinct S19s saved |
| Extend `exploits/firmware-unlock/coproc-extract.py` to cover both variants          | done — adds `extract_continuous_blob()` + dispatch |
| Inspect rootfs init scripts to see invocation context            | confirmed: no `-f`, embedded-only, runs at boot |
| Probe Lutron CDN for device firmware paths                       | only 403/404 — no useful endpoints |
| Verify extracted firmware contains expected strings              | "Copyright 2014 Lutron Electronics" found |

| Still unknown                                                    | Notes |
|------------------------------------------------------------------|-------|
| Exact STM32 part used in SmartBridge (F0/F1/L0?)                 | needs board photo / chip markings |
| Bootloader (0x08000000–0x080030xx) contents                      | not in any S19 — would need physical chip readout |
| Whether there's a "newer" `02.10.03a000`-equivalent with EFR32 instead | this binary is still HCS08-table-aware, suggesting old radio path |
| Per-device-class (dimmer/pico/switch) firmware update path       | likely doesn't exist — Caseta dimmers receive OS via RF from the bridge, not a separate file |
