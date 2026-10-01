# Coprocessor Firmware Reverse Engineering

*Deobfuscating the S19 coprocessor firmware images embedded in `lutron-coproc-firmware-update-app`.*

## Overview

The `lutron-coproc-firmware-update-app` binary (ARM32 ELF, C++) embeds obfuscated S19 firmware
images for coprocessor MCUs. The obfuscation has been reversed, yielding 10 firmware images from
the Phoenix build. These were imported into Ghidra for analysis, with a focus on the CCX
(Thread/OpenThread) coprocessor.

## Obfuscation

**Algorithm**: polyalphabetic substitution cipher on printable ASCII (0x20–0x7E, 95 chars).

```
decoded = ((encoded - key + 0x3F) % 95) + 0x20
key = (key + 1) % 95    // starts at 0x49 (73), resets per blob
```

- Non-printable chars (\r, \n) pass through unchanged, don't advance the key
- Inverse: `encoded = ((plain - 0x20 + key) % 95) + 0x20`
- Class: `COPROC_FIRMWARE_UNOBFUSCATOR` at vtable 0x8b018, method at 0x22530
- Registry: `SINGLETON_REGISTRY<DEVICE_CLASS, map<LINK_TYPE, map<COPROC_IMAGE_TYPE, FIRMWARE_FILE_PROPERTIES*>>>`

**Extraction tool**: an S19 extraction/deobfuscation tool (maintained outside this repo)

Three variants of this cipher have been seen:

- **Phoenix** (RA3 / 6 MB binary): `key0=0x49`, key resets per S0 blob, multiple
  blobs concatenated with the `=z}/}~` (= `S02B00`) signature.
- **Caseta SmartBridge** (older L-BDG2/SBP2 / 0.3 MB binary) and **Vive prototype**:
  `key0=0x29`, key advances **continuously** across the entire stream, single blob
  with no S0 header (begins directly with `S3` records). See
  [caseta-smartbridge.md](caseta-smartbridge.md) for details.
- **RA2 Select REP2 / Caseta Pro** (1.5 MB binary): same continuous cipher, but
  multiple blobs concatenated with **key0 changes between blobs** (no embedded
  signature). Observed `key0` values: `0x25` (HCS08 + first EFR32) and `0x7E`
  (second EFR32). Blobs start at offsets the SmartBridge's narrow search misses;
  the S19 extraction/deobfuscation tool's `extract_multi_continuous_blobs()` walker scans the
  full binary trying multiple `key0` candidates.

The 6 MB caseta-ra2select-bundled binary (if any) and vive (production) binaries
remain unsolved.

## Extracted Firmware Images

All extracted to `data/firmware/phoenix-device/coprocessor/`:

### EFR32 — CCA + CCX Radio Coprocessor Firmware (Silicon Labs MG12, bare-metal)

Phoenix carries **two EFR32MG12 coprocessors** — one driving a CC110L over SPI for
433 MHz CCA (bit-banged, async serial mode), the other handling Thread/802.15.4
via the MG12's internal radio. Larger Phoenix variants ship two CCA EFR32 binaries
(probably master + slave, or two different SKUs sharing a build); smaller variants
appear to ship one of each.

| File | Size | Base | Role | Evidence |
|------|------|------|------|----------|
| phoenix_efr32_8003000-801FB08 | 115K | 0x08003000 | CCA | Strings "Cordless wakeup unsupported event received" / "Link event unsupported event received", "L-BDG", `0xFADE` sync (BE) at `0x0801E8C8`, CRC-16 table (poly `0xCA0F`) at `0x0801E8D0` |
| phoenix_efr32_8004000-803A008 | 216K | 0x08004000 | CCA | Same Cordless / Link event strings, `0xFADE` sync (5 occurrences), `0xCA0F` CRC poly, "L-BDG" |
| phoenix_efr32_8003000-803FF08 | 243K | 0x08003000 | CCX (likely) | No CCA debug strings; `fe80::` LL IPv6 prefix and `fd12::` Thread mesh-local prefix present in data; Copyright 2017 (newer build) |
| phoenix_efr32_8003000-807F808 | 498K | 0x08003000 | CCX (likely) | No CCA debug strings, no `0xFADE` sync match; deepest stack pointer (SP=0x20028000 = 160 KB) consistent with full mbedTLS + OpenThread footprint |

**CCA classification ground truth** is the Cordless / Link event log strings — those
two strings appear ONLY in 801FB08 and 803A008. Both also contain the CCA-specific
sync word `0xFADE` followed by the 256-entry CRC-16 lookup table for poly `0xCA0F`.

**CCX classification** is by exclusion — the other two EFR32 binaries have neither
of those CCA fingerprints. They contain `fe80::` and `fd12::` IPv6 prefix bytes
in their data segments (Thread link-local + mesh-local), which is the only
Thread-side fingerprint that survived stripping. We have not yet located internal
RAIL or OpenThread strings — those appear to be heavily compiled out / log-IDed.

**Note**: These coprocs do NOT use Silicon Labs SDK/RAIL/EMLIB strings in plaintext
(no `RAIL_*` / `RAIL_StateXXX` markers). All RAIL hooks are inlined or stripped.
This is consistent with a release-mode Lutron build that has been size-optimized.

### HCS08 — End-Device Firmware (NOT bridge dispatch)

These are the **firmware images Phoenix flashes OUT** to dimmers / picos / fan
controls over CCA OTA. They are NOT the EFR32 bridge dispatch — earlier notes
incorrectly grouped them as such.

| File | Size | Codename / Role |
|------|------|-----------------|
| phoenix_hcs08_3000-1E808 | 108K | "CoProcApplication" — actually this S0 banner is misleading; binary is end-device class (small flash) |
| phoenix_hcs08_3000-3E808 | 151K | eagle-owl CCA dimmer end-device firmware |
| phoenix_hcs08_3000-7E808 | 149K | bananaquit / basenji end-device firmware (larger flash variant) |

These are MC9S08-class 8-bit binaries with banked addressing (S2 records, 24-bit).
The CCA RX dispatch in these files is the **device side** of the protocol — what
listens for SET_LEVEL / BEACON / pairing packets and acts on them. The
**bridge / coordinator side** RX dispatch lives in the EFR32 binaries above.

### Kinetis — CCX Coprocessor (suspected NXP, FreeRTOS + OpenThread)

| File | Size | Address Range | SP | Reset |
|------|------|---------------|-----|-------|
| phoenix_kinetis_4000-FF80C | 1006K | 0x4000-0xFF80C | 0x20040000 (256K) | 0x3649D |

This is the **primary CCX reverse engineering target**. The "Kinetis" tag came from
the original `coproc-extract.py` heuristic (address range starting at 0x4000)
rather than a chip-ID confirmation; given that the rest of the Phoenix radio
coproc family is EFR32MG12, this binary may actually be a third EFR32 / different
Cortex-M part. Vector layout matches Cortex-M; chip-ID-by-strings is inconclusive.
See detailed analysis below for the OpenThread/CoAP framework.

### RA2 Select REP2 / Caseta Pro

Extracted to `data/firmware/ra2select-device/coprocessor/`. Same coproc lineup as
Phoenix (2 × HCS08 CCA + 2 × Cortex-M CCA), distinct binaries:

| File | Address Range | Notes |
|------|---------------|-------|
| rr-sel-rep2_hcs08_3000-1E808 | 0x3000-0x1E808 | HCS08 (108K), key0=0x25, blob @ 0x5C860 |
| rr-sel-rep2_efr32_8003000-801FB08 | 0x08003000-0x0801FB08 | Cortex-M (115K), key0=0x25, blob @ 0xAA646 |
| rr-sel-rep2_hcs08_3000-7E808 | 0x3000-0x7E808 | HCS08-large (494K), key0=0x25, blob @ 0xEA7B2 |
| rr-sel-rep2_efr32_8003000-803FF08 | 0x08003000-0x0803FF08 | Cortex-M (243K), key0=0x7E, blob @ 0x13B460 |

The Cortex-M images contain the same CCA OTA framing constants as Phoenix's EFR32
images (sync `55 55 55 FF FA DE`, CRC poly `0F CA`, 256-entry CRC lookup table) —
confirming that the CCA OTA wire protocol RE'd from Phoenix applies to RA2 Select
/ Caseta Pro as well. See [CCA firmware OTA wire protocol](../protocols/cca/ota.md).

The "efr32" label follows Phoenix's naming convention; whether RA2 Select REP2
actually uses an EFR32 (vs STM32 or another Cortex-M part) is unverified pending
chip ID. An earlier extraction (before the multi-blob walker landed) labeled these
as `_stm32_` — those are stale duplicates.

## Ghidra Project

Location: `data/firmware/phoenix-device/coproc-firmware.gpr`

5 ARM images imported and auto-analyzed:
- 4x EFR32 CCA (ARM:LE:32:Cortex, base addresses as above)
- 1x Kinetis CCX (ARM:LE:32:Cortex, base 0x4000)

HCS08 images need manual import with MC9S08GB60 variant and banked memory config.

## Phoenix Architecture (Confirmed)

```
Phoenix Processor (AM335x Linux)
  │
  ├── UART /dev/ttyS2, 230400 ──→ EFR32MG12 (CCA coprocessor)
  │   Link 1, LinkType 9            Bare-metal, drives external CC110L over SPI
  │   "James RF"                     433 MHz FSK (CC110L is bit-banged in async
  │                                  serial mode, PKTCTRL0=0x32 — MCU does
  │                                  preamble + sync + CRC + 8N1 codec).
  │                                  Variants ship 1-2 EFR32 CCA binaries.
  │
  └── UART /dev/ttyS1, 230400 ──→ EFR32MG12 (CCX coprocessor)
      Link 0, LinkType 31 (0x1f)    FreeRTOS + OpenThread FTD
      "Pegasus"                      MG12's internal 2.4 GHz radio handles
                                     802.15.4 / Thread mesh
                                     HDLC/Spinel transport
```

**Hardware confirmation (from owner of physical units, 2026-04-28):** main MCU is
the TI AM335x (Cortex-A8 Linux host). Both radio coprocs are Silicon Labs
EFR32MG12. The CC110L is a passive analog/digital sub-GHz transceiver — no MCU,
no firmware — bit-banged by the EFR32 over SPI. RA3-class Phoenix typically
carries two EFR32MG12s (one per radio); smaller Phoenix may carry only the CCX
one with a fixed-function CC110L driver still present. The HCS08 binaries we
extract from `lutron-coproc-firmware-update-app` are *end-device* firmware
(eagle-owl dimmers, basenji picos, bananaquit fan controls) — they are what
Phoenix flashes OUT, not the bridge dispatch.

## Kinetis CCX Firmware Deep Analysis

### Build Info
- Project: `perseus-reference-design`
- Jenkins: `COPROC_RELEASE_BUILDER`
- OpenThread fork: `third-party/openthread/openthread-lutron/`
- Full Thread Device (FTD) with Leader + Router + Border Router roles

### FreeRTOS Tasks (9)

| Task | Purpose |
|------|---------|
| CoprocOpenThreadStackTask | Main OpenThread stack loop |
| SpiServerTask | SPI slave interface to AM335x |
| hdlcTaskRunner | HDLC/Spinel framing for host comms |
| NVIMTask | NV persistence (LittleFS on flash) |
| deviceFirmwareUpdateTask | OTA DFU via CoAP |
| AppTaskletSchedulerTask | OT tasklet scheduling |
| TaskSupervisorTask | Watchdog/health monitoring |
| SafeResetManagementTask | Safe reset handling |
| queueSendThread/queueReceiveThread | Inter-task messaging |

### Lutron CoAP Endpoints (on Thread mesh)

| Path | Purpose |
|------|---------|
| `lut/ac` | Action Command — send commands to CCX devices |
| `lut/ra` | Resource Access — responses, port 0xBFF0 (49136) |
| `cg/nt/able` | Network Table — device registry/discovery |
| `cg/db/pr` | Database Preset — scene/preset data |
| `fw/ia`, `fw/ib` | Firmware Image slots A/B (dual-bank OTA) |
| `fw/ia/md`, `fw/ib/md` | Firmware metadata per slot |
| `fw/it`, `fw/it/md` | Firmware Image Transfer + metadata |
| `fw/ic/md` | Current image metadata |
| `fw/ip/md` | Pending image metadata |
| `/lg/all`, `/lg/lim` | Logging endpoints |

### CCX Message Format
```json
{"MId":<message_id>, "Data":"<hex_encoded_payload>"}
```

### DFU Protocol (CoAP Block-Wise Transfer, RFC 7959)

State machine at FUN_000186b4, transfer at FUN_000183d4:

| State | Action |
|-------|--------|
| 0xB | Idle — waiting for trigger |
| 6 | Start — resolve device, query `fw/ic/md` |
| 7 | Transfer — CoAP Block1 PUT to `fw/ia` or `fw/ib`, port 5683 |
| 2 | Verify — query `fw/ia/md` to confirm |
| 0 | Complete — notify host |

- Uses CoAP options 0x17 (Block2) and 0x1b (Block1)
- Block encoding: `block_num << 4 | more_flag << 3 | szx`
- PFF file is relayed **unmodified** — Kinetis does not decrypt
- Standard CoAP port 5683

### Crypto Stack
- mbedTLS: TLS-ECJPAKE-WITH-AES-128-CCM-8 (Thread commissioning)
- ECDHE-ECDSA cipher suites for DTLS
- AES-CCM for Thread MAC-layer encryption
- Full X.509 certificate infrastructure

### Storage
- LittleFS on flash (`littlefs` string)
- `/net/otSettings` — Thread network credentials
- `/log/bootCount` — boot counter
- NVM Manager: `NVMMLutronLFSDiagnostic`, `NVMMPSDiangostic`, `NVMMInstanceManagerDiagnostic`

## PFF File Format

PFF = "Pegasus Firmware Format" (update-file-format-{0,1}.pff)

Two header layouts exist. The u32 at `0x000` selects which: `1` → 308-byte
(`0x134`) header, `0` → 304-byte (`0x130`) header, the difference being the
presence of the target-flash field at `0x120`. Layout 0 is used by the CCX boot
images; CCA boot images use layout 1.

```
Offset  Size  Field                     Notes
0x000     4   Header layout version     BE u32; 1 → 0x134 header, 0 → 0x130 header
0x004     4   Constant                  BE u32, always 1
0x008    64   Per-file unique field     likely ECDSA-P256 sig (r‖s) or HMAC-SHA512
0x048   192   Reserved                  all-zero, universal across every PFF observed
0x108     2   Flags                     BE u16; 0 normally, 1 on secondary-MCU sub-images
0x10A     2   Image kind                BE u16; 2 = boot, 3 = app
0x10C     4   Revision                  Major, Minor, Patch, Label (one byte each)
0x110     4   MinimumRevisions gate     0 when the manifest lists none
0x114     4   DeviceClass (BE u32)      firmware-space class, e.g. 0x04630201 = DVRF-6L
0x118     4   ImageType (BE u32)        always 1
0x11C     4   Ciphertext length         BE u32; exact, see below
0x120     4   Target flash addr/size    layout 1 only; 0xFFFFFFFF or e.g. 0x00072000
  —      16   IV                        the 16 bytes immediately preceding the body
0x134   var   Encrypted body            AES-CBC, per-device-model key (0x130 on layout 0)
```

Verified across all 120 sample PFFs (9 Caseta + 9 RA2-Select + 46 Phoenix +
56 lite-heron): 31 CCA app, 12 CCA boot, 40 CCX app, 37 CCX boot.

**The encrypted body starts at `0x134` (layout 1) or `0x130` (layout 0), not
`0x10B` and not `0x124`.** The discriminator is the length field at `0x11C`:
`len(file) - header == field@0x11C` holds for 120/120 files, and every resulting
length is 16-byte aligned. Block alignment alone cannot settle this — `0x124` and
`0x134` differ by exactly one AES block, so both satisfy `(size - off) mod 16 == 0`.
The earlier `0x124` reading is why the length at `0x11C` looked like "a little
under the on-disk payload size": the 16-byte shortfall is the IV.

**The 16 bytes before the body are a per-image IV, not ciphertext.** 71 distinct
values across the 120 files; the 48 repeats are all byte-identical copies shared
between the `phoenix-device/` and `lite-heron-decrypted/` trees. Zero collisions
between files with differing content, i.e. no IV reuse to exploit.

Bytes `0x108..0x11F` are a plaintext metadata block readable *without* the
decryption key, and it agrees with `device-firmware-manifest.json`: image kind at
`0x10A` matches boot-vs-app for 120/120 files, and the revision at `0x10C` matches
the filename's major.minor for 116/120. The four exceptions are both eagle-owl app
builds (Caseta v2.025 and CCA v2.026, each appearing in two trees), which carry
`00 00 00 01` there instead of their actual revision — unexplained.

The `0x108` flag is set on exactly three images — `dart-hybrid-keypad-dimming-app`,
`powerbird-hybrid-coproc-app`, `powerbird-hybrid-coproc-switch-app` — all small
(~35 KB) secondary-MCU sub-images, and these are also the only three files whose
reserved run is not all-zero. It is *not* a "locked build" marker: the two
`kit-kat-*-locked-*` images have it clear.

The DeviceClass at `0x114` is the **firmware-space** class the device reports
(0x04630201 = DVRF-6L, confirmed against the 2026-04-28 live OTA capture), distinct
from Designer's commissioning-space QSDEVICECLASSTYPEID (e.g. 0x04240101 for HQR-3PD).

Use `tools/firmware/pff-parse.ts` to dump the layout and run the chi-square / structural
sanity check on any `.pff`.

- Format 0 = boot images (~20K)
- Format 1 = app images (100K-900K)
- Encryption key is per-device-model, burned into device bootloader at manufacturing
- NOT stored on Phoenix processor — `PegasusLinkData.LinkDataKey` table is empty
- The `6cba80b2bf3cf2a63be017340f1801d8` key (ATECC608 slot 6) decrypts the **outer
  `firmware.tar.enc` bundle**, not the per-`.pff` payload — empirically it decrypts
  none of the 5 CCA PFF payloads (eagle-owl/basenji/bananaquit/vogelkop/caseta),
  every result stays ~38% printable (still encrypted) in both ECB and CBC
- **No PFF payload has been decrypted.** Body entropy is 7.99–8.00 bits/byte on all
  120 files, nothing below 7.95. The `0x124` offset error did not mask a correct
  key: under CBC, treating the IV as ciphertext block 0 corrupts only the first
  block and yields correct plaintext from block 2 on, so a right key would still
  have shown mostly-printable output.

- Package signature verified by opkg with `/etc/ssl/firmwaresigning/public.pem` (valid 2020-2120)

### Device Firmware Manifest

`device-firmware-manifest.json` maps DeviceClass → PFF files. Key entries:

| DeviceClass | Codename | Type | Protocol |
|-------------|----------|------|----------|
| 0x045E0101 | dart-rf-dimmer | Sunnata dimmer | CCX |
| 0x045F0101 | dart-rf-switch | Sunnata switch | CCX |
| 0x01270101 | dart-keypad | Sunnata keypad | CCX |
| 0x04670101 | dart-rf-fan-control | Sunnata fan | CCX |
| 0x1B010101 | bulb-pegasus | Ketra bulb | CCX |
| 0x1B060101 | thin-mint | Unknown CCX device | CCX |
| 0x16261301 | hercules-rf | Unknown CCX device | CCX |
| 0x03120101 | cca-eagle-owl | CCA device (3 variants) | CCA |
| 0x03140601 | cca-bananaquit-avis | CCA device | CCA |
| 0x03150201 | cca-basenji | CCA device | CCA |

## Source Material

The firmware images behind this document live under `data/firmware/`, which is
gitignored — a clone does not carry them. Everything is reproducible from
published bundles on `firmware-downloads.iot.lutron.io`; no authentication is
required and nothing here came off live hardware.

### PFF provenance

71 unique PFFs, duplicated across four trees to 120 files on disk.

| Tree | Files | Chain |
|---|---|---|
| `ra2select-device/firmware/`, `caseta-device/firmware/` | 9 (byte-identical sets) | `caseta-ra2select/final/08.25.17f000/rootfs-08.25.17f000.deb` → `ar x` → `data.tar.gz` → `rootfs.ubifs.xz` → UBIFS → `/opt/lutron/device_firmware/firmware/`. Unencrypted deb, no key needed. |
| `phoenix-device/{cca,pegasus}/` | 46 of 55 | `phoenix/final/26.01.13f000/lutron_firmware` → AES-128-CBC with `6cba80b2bf3cf2a63be017340f1801d8` → `firmware.tar` → rootfs → `/var/misc_unsynced/device_firmware/phoenix-device-firmware-package.tar.gz` (contains 55; 46 extracted). Byte-identical bundle also ships in the Designer MSIX at `QuantumResi/BinDirectory/Firmware/phoenix/lutron_firmware`. |
| `lite-heron-decrypted/device-firmware/{cca,pegasus}/` | 55 | `lite-heron/final/26.00.12f000/lutron_firmware` → same decrypt → `device-firmware/` sits at the bundle root, no rootfs hop. Most complete set of the three. |
| `dvrf6l-v3.021.pff` | 1 | Renamed copy of `07911506_v3.021_VogelkopDimmerAppCaseta.pff` (same SHA-256). Kept under the DVRF-6L name because the 2026-04-28 live OTA capture matched it. |

Notes:

- The `caseta-ra2select/final/` channel carries 329 versions, all unencrypted
  `.deb`, so Caseta Pro / RA2 Select device firmware needs no key and no bridge
  access — just the deb and UBIFS tooling.
- The older SmartBridge rootfs (`caseta-smartbridge`, v02.x, L-BDG2/SBP2) has no
  `/opt/lutron/device_firmware` at all, matching it never gaining CCA OTA.
- `data/firmware/caseta-ra2select/rootfs.tar.zst` is the extraction working
  directory, not a device dump: it holds the deb members, the unpacked
  `rootfs.ubifs`, and `tmp/extracted/` with the full root filesystem.
- A per-tree `device-firmware-manifest.json` sits beside each PFF set and maps
  DeviceClass → codename → path.

### Reading a manifest without downloading the bundle

`device-firmware-manifest.json` is the **first member of the `lutron_firmware` ZIP
and is stored uncompressed** (method 0), so two HTTP Range requests retrieve it
from a 120 MB bundle. Parse the local file header at offset 0 for the name length,
extra length and compressed size, then range-read the body:

```
curl -s -r 0-200 "$URL"                      # local file header
# nameLen @0x1A, extraLen @0x1C, cSize @0x12 (all little-endian)
curl -s -r "$START-$((START+CSIZE-1))" "$URL" > manifest.json
```

Verified against `phoenix/final/26.09.18f000/lutron_firmware`: first member
`device-firmware-manifest.json`, method 0, 64,466 bytes.

Newest live versions as of 2026-10-01 (all unauthenticated):

| Channel | Newest | Device-firmware pkg | Entries |
|---|---|---|---|
| `caseta-ra2select/final/` | `08.30.09f000` | 001.003.004r000 | 15 |
| `phoenix/final/` | `26.09.18f000` | 002.025.035r000 | 36 |
| `lite-heron/final/` | `26.00.13f000` | 002.025.024r000 | 28 |

The local phoenix set is from 26.01.13f000; the 26.09.18f000 manifest adds eight
classes (`0x06190301`, `0x061F0101`, `0x1B010201`, `0x1B060201`, `0x1B060401`,
`0x1B060501`, `0x1B080501`, `0x1B0A0101`) and reaches 68 `.pff` paths. Its only
family-`0x04` classes are `0x045E0101`, `0x045F0101`, `0x04670101`. No channel at
any version carries `0x0448`.

### Coprocessor images

- `coprocessor/phoenix_*.s19` — deobfuscated S19 images, recovered from the
  embedded blobs in `lutron-coproc-firmware-update-app` (no external firmware
  file exists on these rootfs images)
- `coprocessor/phoenix_*.bin` — flat binary conversions, for loading into Ghidra
- `coproc-firmware.gpr` — Ghidra project over the ARM images

The S19 extraction/deobfuscation tool is maintained outside this repo.
