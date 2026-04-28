# Coprocessor Firmware Reverse Engineering

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

**Extraction tool**: `tools/coproc-extract.py`

Two variants of this cipher have been seen:

- **Phoenix** (RA3 / 6 MB binary): `key0=0x49`, key resets per S0 blob, multiple
  blobs concatenated with the `=z}/}~` (= `S02B00`) signature.
- **Caseta SmartBridge** (older L-BDG2/SBP2 / 0.3 MB binary) and **Vive prototype**:
  `key0=0x29`, key advances **continuously** across the entire stream, single blob
  with no S0 header (begins directly with `S3` records). See
  [caseta-smartbridge-coproc.md](caseta-smartbridge-coproc.md) for details.

The 6 MB caseta-ra2select and vive (production) binaries still lack any signature
match and may use yet another variant or key.

## Extracted Firmware Images

All extracted to `data/firmware/phoenix-device/coprocessor/`:

### EFR32 — CCA Radio Firmware (bare-metal, CC110L SPI driver)

| File | Size | Address Range | Git Hash | Notes |
|------|------|---------------|----------|-------|
| phoenix_efr32_8003000-801FB08 | 112K | 0x8003000-0x801FB08 | 64034cd9e8 | L-BDG (bridge), Copyright 2014 |
| phoenix_efr32_8003000-803FF08 | 243K | 0x8003000-0x803FF08 | ee2e4c2efb | Copyright 2017, newer variant |
| phoenix_efr32_8003000-807F808 | 498K | 0x8003000-0x807F808 | cb12f859dd | Large, mostly data tables |
| phoenix_efr32_8004000-803A008 | 216K | 0x8004000-0x803A008 | 64034cd9e8 | Superset of 112K (32K RAM) |

**Key finding**: These do NOT use Silicon Labs SDK/RAIL/EMLIB. The EFR32 is used purely as a
Cortex-M MCU driving an external CC110L over SPI for 433 MHz CCA. No internal 2.4 GHz radio.

### HCS08 — CCA Radio Firmware (Freescale 8-bit)

| File | Size | Address Range | Notes |
|------|------|---------------|-------|
| phoenix_hcs08_3000-1E808 | 108K | 0x3000-0x1E808 | S0: "CoProcApplication" |
| phoenix_hcs08_3000-3E808 | 151K | 0x3000-0x3E808 | eagle-owl CCA app |
| phoenix_hcs08_3000-7E808 | 149K | 0x3000-0x7E808 | bananaquit/basenji larger flash |

Uses banked/global addressing (S2 records, 24-bit). Ghidra import requires manual paged
memory setup (16K window at 0x8000-0xBFFF via PPAGE register).

### Kinetis — CCX Coprocessor (NXP ARM Cortex-M, FreeRTOS + OpenThread)

| File | Size | Address Range | SP | Reset |
|------|------|---------------|-----|-------|
| phoenix_kinetis_4000-FF80C | 1006K | 0x4000-0xFF80C | 0x20040000 (256K) | 0x3649D |

This is the **primary CCX reverse engineering target**. See detailed analysis below.

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
  ├── UART /dev/ttyS2, 230400 ──→ EFR32 (CCA coprocessor)
  │   Link 1, LinkType 9            Bare-metal, CC110L SPI driver
  │   "James RF"                     433 MHz FSK, 8N1 codec
  │                                  Variants: L-BDG bridge, sensors
  │
  └── UART /dev/ttyS1, 230400 ──→ Kinetis (CCX coprocessor)
      Link 0, LinkType 31 (0x1f)    FreeRTOS + OpenThread FTD
      "Pegasus"                      802.15.4 / Thread mesh
                                     HDLC/Spinel transport
```

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

```
Offset  Size  Field
0x00    4     Version Major (big-endian, usually 0 or 1)
0x04    4     Version Minor (big-endian, usually 1)
0x08    ...   Encrypted payload (AES, 0.96 byte entropy)
```

- Format 0 = boot images (~20K)
- Format 1 = app images (100K-900K)
- Encryption key is per-device-model, burned into device bootloader at manufacturing
- NOT stored on Phoenix processor — `PegasusLinkData.LinkDataKey` table is empty
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

## Custom Firmware Flashing — Attack Surface Analysis

### Viable Approaches (not yet attempted)

1. **SWD/JTAG on Sunnata** — If debug pads exist and aren't fused, bypasses all crypto.
   Need to open a Sunnata and probe for SWD.

2. **CoAP DFU over Thread** — Join network, send to `fw/ia` endpoint:
   - Extract Thread network key from Phoenix (root SSH → Spinel commands or NVM dump)
   - Join Thread with nRF52840 dongle
   - Send crafted PFF via CoAP Block1 PUT
   - Requires valid PFF or exploitable parser

3. **Bootloader exploit** — PFF parser vulnerabilities:
   - Buffer overflow in header/length parsing
   - CBC padding oracle (if different error codes for bad padding vs bad signature)
   - TOCTOU in dual-bank A/B validation

4. **Downgrade attack** — Push old firmware if no rollback protection (no monotonic counter)

### Prerequisites for all CoAP approaches
- Thread network key (extractable from live Phoenix)
- Device mesh-local IPv6 address (discoverable via Thread address resolver)
- Understanding of PFF validation on device side (need bootloader dump)

## Files Created This Session

- `tools/coproc-extract.py` — S19 extraction/deobfuscation tool
- `data/firmware/phoenix-device/coprocessor/phoenix_*.s19` — 10 deobfuscated S19 files
- `data/firmware/phoenix-device/coprocessor/phoenix_*.bin` — flat binary conversions
- `data/firmware/phoenix-device/coproc-firmware.gpr` — Ghidra project with 5 ARM images
- `docs/coproc-firmware-re.md` — this document
