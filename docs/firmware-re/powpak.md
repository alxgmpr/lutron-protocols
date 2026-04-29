# PowPak RF Module Firmware

Reverse-engineering notes for Lutron PowPak (RMJ/LMJ/RMJS-prefixed) RF modules — relay, contact closure output (CCO), and 0-10V dimmer. Driven by the question "can we OTA-convert an RMJ unit (paired to ESN) into an LMJ unit (paired to RA3/HomeWorks QS)?"

## TL;DR

**What PowPak is**: Banked HCS08 (likely MC9S08QE128) + TI CC1101 sub-GHz transceiver, running 433/868 MHz GFSK at 30 kbps in **async serial mode** (the MCU bit-bangs all CCA framing — chip-side sync detection is disabled). Same hardware ships under three SKU prefixes:
- **RMJ-** pairs only to **ESN** (EnergiSavr — broadcast-style)
- **RMJS-** pairs only to **Vive** (CCA link type 30, smart pairing)
- **LMJ-** pairs only to **RA2 / RA3 / HomeWorks QS** (smart, connected)

The device's identity is determined by **a 4-byte DeviceClass at body offset `0x008AD`** in the bootloader's factory-config region. SKU prefix is a marketing label applied by the host system based on this field; flashing different bytes changes what the device claims to be.

**LDF format**: `.ldf` files in Designer's MSIX are simple containers — 0x80-byte header (filename + metadata) + plaintext compiled HCS08 image. No encryption.

**The CCA OTA wire protocol is fully decoded** (from RE'ing the Phoenix EFR32 coproc):
- Sync word `0xFADE`, preamble `55 55 55 FF`, CRC poly `0xCA0F`
- Packet layout `[len][op][payload][CRC16]`, 6-14 bytes typical
- 35-row table at BN `0x9B30` (codes 0x44..0x66) — earlier suspected to be a hop table; the **2026-04-28 live OTA capture shows single-channel operation** at ~433.566 MHz, not hopping. The table is something else (calibration LUT, retry channels, or unrelated). See [cca-ota-live-capture.md](cca-ota-live-capture.md).
- 10 OTA opcodes; the wake-up sequence is `QueryDevice(0x58) → CodeRevision(0x36) → BeginTransfer(0x2A) → ChangeAddressOffset(0x32) → TransferData(0x41)×N → EndTransfer(0x32) → ResetDevice(0x32)`
- The Phoenix coproc has **no DeviceClass enforcement** — it relays whatever lutron-core asks it to send

**PowPak's RX-side anchors located**: sync-word check `CPHX #$FADE; BNE` at BN `0x92C0`, opcode-0x41 dispatch at BN `0x8680`, framing template + CRC poly constants at BN `0x9714`.

**Flash-write primitive** at BN `0x4290` — standard HCS08 FCMD/FSTAT sequence. All flash-write callers route through `sub_8bb4` (which has no static callers — likely reached via interrupt/state-machine).

**Conversion attack — feasible path**: Direct CCA OTA from a Nucleo+CC1101 transmitter, bypassing every Lutron host system. Build CCA OTA packets in software, send the wake-up sequence to a target PowPak's serial number, stream LMJ firmware bytes via TransferData. Whether the device's bootloader cross-checks the firmware's declared DeviceClass against the in-flash one is the only remaining unknown — answerable empirically by attempting the attack.

**Path NOT viable**: Designer/processor-mediated update — Designer doesn't OTA CCA devices (only CCX), and even the cloud-portal CCA OTA path on Phoenix/Caseta processors only carries `0x03xx` device-class entries (eagle-owl/bananaquit-avis/basenji — HQRD-style devices), not PowPak (`0x16xx`). Plus an RMJ-prefixed device can't pair to an RA3 system to begin with.

## Acquisition

Firmware ships embedded in Lutron Designer's MSIX package, under `QuantumResi/BinDirectory/Firmware/QuantumResi/qs_firmware_and_tools/powpak modules/`. Seven `.ldf` files cover the product line:

| File | Body size | Variant | Family/Product/HW (per FirmwareHeaderFile.xml) |
|------|-----------|---------|------------------------------------------------|
| `PowPakRelay434_1-49.LDF` | 99 928 B | RMJ-16R-DV-B (relay) 434 MHz NA | 0x16/0x03/0x02 |
| `PowPakRelay868_1-49.ldf` | 99 922 B | Relay 868 MHz EU | 0x16/0x01/0x02 |
| `PowPakRelay434L1-53.ldf` | 102 516 B | Relay 434L (RA HWQS, newer rev) | 0x16/0x08/0x02 |
| `RFCCO434_1-51.LDF` ≡ `RFCCO868_1-51.LDF` | 100 616 B | RMJ-CCO1-24-B (contact closure) — **dual-band single binary** | 0x16/0x07/0x04, 0x16/0x07/0x05 |
| `RFZeroTen434_1-34.ldf` ≡ `RFZeroTen868_1-34.ldf` | 112 468 B | RMJ-2DSC-1-B / 1-10V — **dual-band single binary** | 0x16/0x06/0x02, 0x16/0x06/0x03 |

Five unique firmwares. RFCCO and RFZeroTen 434/868 are byte-for-byte identical — the chip frequency band is selected at runtime (likely via a hardware strap or config byte). PowPak Relay 1.49 still has separate per-band builds; 1.53 is the latest unified build.

Extracted binaries at `data/firmware-re/powpak/*.bin` (gitignored).

## LDF container format

```
0x00-0x3F : ASCII filename, NUL-padded (64 bytes)
0x40-0x7F : metadata (16 × BE32 fields)
            +0x00 file_size            (matches file size on disk)
            +0x08 0x00000002           (format version)
            +0x10 0x0000007C           (header trailer length marker)
            +0x14 0x00000006
            +0x1C 0x000117xx           (product class marker, mostly constant)
            +0x20 hash1                (likely CRC32 of section A)
            +0x28 size_a (~58 KB)      (section A length)
            +0x2C record_count         (4 or 5)
            +0x34 size_b               (section B length)
            +0x38 hash2                (CRC32 of section B)
0x80+     : binary body (HCS08 image)
```

Extractor at [tools/ldf-extract.py](../../tools/ldf-extract.py) (TODO promote from /tmp).

## Body layout

Each body is plaintext compiled HCS08 code (entropy 6.88-6.92 bits/byte), **not encrypted** — distinct from Grafik Eye's `sysconfig.dll` obfuscation scheme. Top byte frequencies are `0x02`, `0x01`, `0x9E` (SP-relative addressing prefix), `0xAC` (banked CALL opcode), `0x00` — all consistent with compiled banked HCS08 (likely **MC9S08QE128**).

Two embedded `Copyright 2008 Lutron Electronics` banners delimit a two-section structure:

| Region | Body offset | Role |
|--------|-------------|------|
| Bootloader header | `0x00-0x1F` | Fixed 32-byte handshake table — **identical across all 5 firmwares**. Contains 16-bit address constants `0x08A1`, `0xFA7D`, `0xC00C`, `0xC89F`, `0x0080`, `0x0100`, `0x1F7E`. Likely a memory-init / load directive table consumed by the on-device bootloader. |
| Section A code | `0x20-~0xE8C5` | Bootloader / shared platform code (~58 KB) |
| Section A trailer | `~0xE8C6-~0xE8F7` | 12 × `0xFF` followed by 0x00 padding |
| Section B header | `~0xE8F8` | `fc 0e` magic + 7 × 3-byte function pointer table targeting addresses 0x7403-0x75F0 |
| Section B banner | `~0xE92C` | `Copyright 2008 Lutron Electronics` |
| Section B code | `~0xE94E-EOF` | Application code (~42-54 KB) |

The mid-body function pointer table at section B header is the runtime entry into application code — these 7 pointers are likely interrupt or event handlers exposed to the bootloader.

## CC1101 radio configuration

PowPak modules use the **TI CC1101** sub-GHz transceiver. The radio's register init data lives at a structured table tagged with the ASCII magic `LEC` (Lutron Electronics Co.).

For the 1.53 build, the table is at BN address `0x09913`:

```
0x09913: 4c 45 43                                 'LEC' magic
0x09916: 00 01 02 03 04 05 06 07 08 09 0a 0b 0c
         10 11 12 13 14 15 16 17 18 19 1a 1b 1c
         1d 1e 1f 20 21 22 23 24 25 26 27 28 29
         2a 2b 2c 2d 2e                          register list (8-bit, 44 entries — skips FREQ2/1/0 at 0x0D-0x0F)
0x9942:  (00,00) (00,01) ... (00,2E)              register list (16-bit pairs, same regs)
0x999A:  values (44 bytes — see below)
```

A second similar table at BN `0x09A4F` adds writes to PATABLE (0x7E), TX FIFO (0x7F), and FSCAL2 (0x24, written last for VCO calibration).

### Decoded register values (1.53 build, common configuration)

| Reg | Name | Value | Meaning |
|-----|------|-------|---------|
| 0x00 | IOCFG2 | 0x0E | GDO2 = carrier sense |
| 0x01 | IOCFG1 | 0x2E | GDO1 = high-Z (default) |
| 0x02 | IOCFG0 | 0x0D | GDO0 = serial data clock (async serial mode) |
| 0x03 | FIFOTHR | 0x00 | RX threshold = 4 bytes |
| 0x04-05 | SYNC1/0 | 0x00, 0x00 | sync word disabled (chip doesn't filter — MCU does) |
| 0x06 | PKTLEN | 0x00 | not used in async serial |
| 0x07 | PKTCTRL1 | 0x00 | no addr check, no CRC autoflush |
| 0x08 | **PKTCTRL0** | **0x32** | **async serial mode**, fixed length, no CRC, no whitening |
| 0x09 | ADDR | 0x00 | (unused in async mode) |
| 0x0A | CHANNR | 0x00 | base channel |
| 0x0B | FSCTRL1 | 0x08 | IF freq ≈ 203 kHz |
| 0x0C | FSCTRL0 | 0x00 | freq offset = 0 |
| 0x0D-0x0F | FREQ2/1/0 | — | **NOT in this table — set per-band elsewhere** |
| 0x10 | **MDMCFG4** | **0x9C** | CHANBW_E=2, CHANBW_M=1, DRATE_E=12 → bandwidth ≈ 162 kHz |
| 0x11 | **MDMCFG3** | **0x3B** | DRATE_M=0x3B → **30.49 kbps** ← Lutron CCA's 30 kbps |
| 0x12 | **MDMCFG2** | **0x10** | **GFSK**, no Manchester, **SYNC_MODE=0 (sync detection disabled)** |
| 0x13 | MDMCFG1 | 0x00 | no preamble bytes inserted, no FEC |
| 0x14 | MDMCFG0 | 0x00 | channel spacing M=0 |
| 0x15 | DEVIATN | 0x44 | deviation ≈ 32 kHz |
| 0x16 | MCSM2 | 0x07 | RX_TIME = 7 (no timeout) |
| 0x17 | MCSM1 | 0x0F | stay in RX after RX, stay in TX after TX |
| 0x18 | MCSM0 | 0x01 | manual frequency calibration |
| 0x19 | FOCCFG | 0x1D | freq offset compensation |
| 0x1A | BSCFG | 0x00 | bit sync default |
| 0x1B-0x1D | AGCCTRL2/1/0 | 0x07, 0x47, 0x00 | AGC config |
| 0x1E-0x1F | WOREVT1/0 | 0x00, 0x00 | wake-on-radio off |
| 0x20 | WORCTRL | 0xF8 | |
| 0x21 | FREND1 | 0xB6 | front-end RX |
| 0x22 | FREND0 | 0x10 | front-end TX (PATABLE index = 0) |
| 0x23-0x26 | FSCAL3/2/1/0 | 0xEA, 0x10, 0x0D, 0x41 | freq synthesizer cal |
| 0x27-0x28 | RCCTRL1/0 | 0x00, 0x57 | RC oscillator |
| 0x29-0x2B | FSTEST/PTEST/AGCTEST | 0x7F, 0x3F, 0x81 | (test/production values) |
| 0x2C-0x2E | TEST2/1/0 | 0x35, 0x09, 0x00 | high sensitivity, VCO cal enabled |

### Key takeaways

- **CC1101 in async serial mode** (PKTCTRL0 = 0x32). The chip handles physical-layer FSK, but **the MCU bit-bangs the entire CCA framing** — preamble, sync word, length, CRC. This is consistent with Lutron's custom CCA protocol that doesn't use CC1101's built-in packet engine.
- **30 kbps GFSK, 32 kHz deviation, 162 kHz channel bandwidth.** Matches existing CCA protocol notes.
- **No SYNC word in CC1101** (MDMCFG2 SYNC_MODE = 0). All Lutron CCA sync detection is in firmware via 8N1 bit decoder + sync byte search.
- **FREQ registers excluded** — the band (434 vs 868) is configured by a separate code path not in this main init table.

## 35-row stepping table (NOT a frequency hop table)

Region at BN `0x9B30-0x9B7F` contains a stepping table:

```
44 EC  45 E8  46 E4  47 E0  48 DC  49 D8  4A D4  4B D0
4C CC  4D C8  4E C4  4F C0  50 BD  51 B9  52 B5  53 B1
54 AD  55 A9  56 A5  57 A1  58 9D  59 99  5A 95  5B 91
5C 8D  5D 89  5E 85  5F 81  60 7E  61 7A  62 76  63 72
64 6E  65 6A  66 66
```

35 entries, 2 bytes each. First byte increments by 1; second byte decrements by ~4.

**Empirically NOT a frequency hop table.** The 2026-04-28 live OTA capture
([cca-ota-live-capture.md](cca-ota-live-capture.md)) shows the OTA runs on a
single channel at ~433.566 MHz for the entire 19-minute transfer — no hop
pattern. Interpretation as `(FREQ1, FREQ0)` pairs with implied FREQ2 = 0x10
yielded ~423-425 MHz (below the 433 MHz ISM band) for the same reason: it
isn't a direct CC1101 freq table. Probably a calibration LUT, retry-channel
offset list, or unrelated feature.

Adjacent at BN `0x9B2D`: explicit `21 63 b1` = FREQ2/1/0 for **868.1249 MHz** — the 868 MHz "anchor" frequency, despite this being the 1.53 RA HWQS firmware that should be 434 MHz only. Possibly leftover from shared codebase, dead code.

## Tooling

- [tools/ldf-extract.py](../../tools/ldf-extract.py) — TODO promote from `/tmp/ldf-extract.py`. Strips 0x80-byte LDF header.
- [tools/ldf-find-cc1101.py](../../tools/ldf-find-cc1101.py) — TODO promote. Locates `LEC` magic + extracts CC1101 register tables.

## DeviceClass and SKU identity

The DeviceClass triplet `(family, product, hwrev, custrev)` is **stored at body offset `0x008AD`** (BN `0x48AD`) in every PowPak firmware — inside the bootloader region (Section A), early in the factory-config block:

```
body[0x8A4]:  00 00 00 00 37 a5 00 00 40 1b   <- header / magic / version word
body[0x8AD]:  16 08 02 01                     <- DeviceClass (LMJ-16R-DV-B = family/product/hwrev/cust)
body[0x8B1]:  e4 0c d0 49 10 e3 62 9d         <- 8-byte build-specific value (per-band per-version)
body[0x8B9]:  cf 8f bf 00 60 0d 02            <- more config
body[0x8C0]:  ff ff c3 a8 00 00 00 00         <- 0xFFFF marker + 4-byte CRC?
body[0x8C8]:  41 00 41 00 ...                 <- repeated 16-bit pattern (UTF-16 init/padding)
```

DeviceClass values across the 5 unique PowPak firmwares (all at the same body offset 0x008AD):

| Firmware | DeviceClass bytes | Marketing SKU |
|----------|-------------------|---------------|
| `PowPakRelay434_1-49.LDF` | `16 03 02 01` | RMJ-16R-DV-B (NA standalone) |
| `PowPakRelay868_1-49.ldf` | `16 01 02 01` | RMJ-16R-DV-B (EU standalone) |
| `PowPakRelay434L1-53.ldf` | `16 08 02 01` | **LMJ-16R-DV-B (RA HWQS connected)** |
| `RFCCO434_1-51.LDF`/`RFCCO868_1-51.LDF` | `16 07 04 01`/`16 07 05 01` | LMJ-CCO1-24-B (CCO, dual-band binary) |
| `RFZeroTen434/868_1-34.ldf` | `16 06 02/03 01` | RMJ-5R-DV-B (0-10V dual-band binary) |

**The DeviceClass is in firmware bytes, not in some untouchable NVM.** This means a flash update *that overwrites Section A* would change the device's identity. A normal application-only OTA update wouldn't touch it, but if the flash protocol reaches Section A bytes the conversion is mechanical.

The 4-byte sequence is **not referenced anywhere else in the firmware** by direct LDA/LDHX (no `c6 48 ad`, no `45 48 ad`, no `c6 88 ad`, no `45 88 ad`). It's a manifest constant — read by the bootloader's pairing-response code or by the OTA-receiver to validate the firmware image, not by the application's runtime path. Almost certainly the application reports DeviceClass to the processor via a packet template that the bootloader sends, with the 4 bytes copied from this fixed location.

## Flash-write primitive

Standard HCS08 FCMD/FSTAT sequence located at **BN `0x429a-0x4314`** (function body, prologue around `0x4290`):

```
0x429a  c6 18 25      lda $1825          ; FSTAT — wait for FCBEF (buffer empty)
0x429d  a4 80         and #$80
0x429f  27 f9         beq -7             ; loop while busy
0x42a1  ...           ; load address bytes (page, hi, lo) into RAM scratch
0x42b9  ldhx $3,SP
0x42bc  lda ,X        ; read data byte from caller's pointer
0x42bd  aix #$1       ; advance pointer
0x42c2  sta $7d       ; FDATA mirror in zero-page
0x42c5  lda $a,X      ; load command byte
0x42c7  sta $1826     ; FCMD <- command (0x25 BURST_PROGRAM / 0x20 BYTE_PROGRAM / 0x40 PAGE_ERASE)
0x42ca  lda $1825     ; FSTAT
0x42cd  and #$80      ; FCBEF
0x42cf  sta $1825     ; W1C — initiates flash op
0x42d8  ...           ; wait for FCCF (Flash Command Complete)
0x42e2  ...           ; check FACCERR (return 0xF3 on access error)
0x42ef  ...           ; check FPVIOL (return 0xF4 on protection violation)
0x42fc  ...           ; loop for remaining bytes (BURST_PROGRAM)
0x430d  lda #$1       ; success return value
0x4314  rts
```

Returns: `0x01` success, `0xF3` access error, `0xF4` protection violation. A second copy of the same routine sits at BN `0x9E76-0x9F23` — likely the application-section flash-write for runtime parameter persistence.

## OTA delivery pipelines

PowPak is **pure CCA** — 433 MHz RF only. It is not on QS-Link and does not flow through any sub-network controller. Phoenix's own CCA coprocessor is what owns the radio on the TX side.

Triggered in production by Lutron's **System Monitor portal** + iOS app, NOT by Designer (Designer only OTAs CCX devices). The portal calls into the processor via cloud-broker → LEAP, and the processor routes to the correct pipeline based on the device's reported family/product.

### Pipeline 1: Pegasus Firmware Update (CCX / Thread devices)

For Sunnata, Hercules, dart, bulb, downlight, powerbird, robin, lorikeet, omnikeet, thin-mint, lutron-dynamic — all Pegasus-framework CCX/Thread devices.

- Manifest entries with codename pattern `pegasus/*.pff`, `dart-*.pff`, `bulb-*.pff`, `hercules-*.pff` (in `device-firmware-manifest.json`)
- Phoenix processor module: `lutron-core` Pegasus path (`PEGASUS_FIRMWARE_UPDATE_*` commands, `CLAP_FILE_TRANSFER_*` underlying transport)
- Wire: LEAP → HDLC over `/dev/ttyS1` → coproc (EFR32) → Thread 802.15.4 RF → device

### Pipeline 2: CCA Firmware Update (CCA 433 MHz RF devices)

For eagle-owl (HQRD HomeWorks QS Reverse Dimmers), bananaquit-avis, basenji **and PowPak (family 0x16)** when paired to a system that knows about them.

- Manifest entries with codename pattern `cca/cca-eagle-owl-*.pff`, `cca/cca-bananaquit-avis-*.pff`, `cca/cca-basenji-*.pff` (in the Phoenix RA3 firmware bundle we extracted)
- Phoenix processor path: lutron-core's CCA path uses `CCA_FIRMWARE_UPDATE_*` commands, sent over HDLC to a CCA coprocessor
- Wire: LEAP → HDLC → CCA coproc (HCS08 `phoenix_hcs08_*.s19` on older Phoenix, EFR32 `phoenix_efr32_*.bin` on newer) → 433 MHz CCA RF → device
- Coproc commands: `QUERY_DEVICE`, `RESET_DEVICE`, `REQUEST_BEGIN_TRANSFER`, `TRANSFER_DATA`, `CHANGE_ADDRESS_OFFSET`, `REQUEST_END_TRANSFER`, `REQUEST_CODE_REVISION`, `CLEAR_ERROR`
- This is the path the Lutron System Monitor portal triggers for HQRD-style CCA devices on RA3
- File format: `.pff` (256-byte preamble + AES-128 encrypted payload). AES key in ATECC608 slot 6 = `6cba80b2bf3cf2a63be017340f1801d8`

**PowPak (family 0x16) belongs in this pipeline architecturally**, but is **NOT in the RA3 Phoenix manifest we extracted**. Neither Phoenix RA3 (28 device classes) nor Caseta (15) lists any `0x16xx` DeviceClass for CCA OTA. The only `0x16xx` entries on Phoenix are `0x16261301` hercules-rf and `0x16271301` hercules-sensor — both **CCX**, not CCA.

That doesn't mean PowPak can't be OTA'd through Pipeline 2 — it means the bundle we have doesn't carry the appropriate `.pff` manifest entries. The relevant `.pff` for `0x16/0x08/0x02` (LMJ-16R-DV-B) and `0x16/0x03/0x02` (RMJ-16R-DV-B) probably ships in the **HomeWorks QSX** firmware bundle (different processor variant from RA3) or in an ESN/Vive bundle. The wire mechanics — HDLC → CCA coproc → 433 MHz RF → device — are the same pipeline, just with a different file-table entry.

### Why the QSE-CI-NWK-E was a dead end

We initially hypothesized PowPak rode through the QSE-CI-NWK-E (a wired Ethernet ↔ QS-Link bridge). That was wrong on two counts:
- PowPak is pure CCA RF, never on QS-Link
- QSE-CI-NWK-E (Freescale ColdFire MCF5235) has **no radio code** — no CC1101 driver, no GFSK config, no OTA framer. It's an Ethernet/RS-485 bridge for wired QS-family devices like GRAFIK Eye QS / QS Wallstation. The 610 KB ColdFire firmware contains only its own self-update bootloader.

The full RE notes for QSE-CI-NWK-E (architecture, device-name table, integration command list, BLT mode and its QSPI block) are in the subagent report — not relevant to the PowPak OTA goal.

### The actual RE target for the CCA OTA wire protocol

Phoenix's own CCA coprocessor binaries:
- `data/firmware/phoenix-device/coprocessor/phoenix_hcs08_3000-*.s19` — older HCS08 CCA coproc (3 variants for different code/load addresses)
- `data/firmware/phoenix-device/coprocessor/phoenix_efr32_*.bin` — newer EFR32 (Cortex-M) CCA coproc
- `data/firmware/phoenix-device/coprocessor/phoenix_kinetis_4000-*.s19` — Kinetis (Cortex-M) variant

These contain the actual on-air CCA OTA framer that PowPak's bootloader RX path is listening for. They've already been imported into Ghidra/BN (see [coproc.md](./coproc.md) and `phoenix-device/binaries/*.bndb`) — that's where the wire protocol RE belongs.

## Implications for OTA conversion

Combining all findings:

1. **DeviceClass `0x16/0x03/0x02` (RMJ standalone) and `0x16/0x08/0x02` (LMJ connected) live at body offset 0x008AD inside the bootloader/factory-config region of every PowPak firmware.** Replacing this region replaces the device's identity.
2. **Flash-write primitive can target any flash address** in principle. Bootloader-imposed write-range protection is unverified but probably exists.
3. **Designer's update orchestrator is the only point where DeviceClass→file mapping happens** (since the processor's manifest doesn't cover PowPak). Designer reads the device's reported DeviceClass, looks up `FirmwareHeaderFile.xml`, picks the `.ldf`. (Subagent B is dumping the C# CIL to confirm exactly what gets checked.)
4. **Processor's `glink-link-driver` blindly streams the S-records it receives** — it does not validate which DeviceClass the firmware targets, only that the S-record format is well-formed. So if Designer pushes an LMJ `.ldf` to the processor, the processor will stream it to whatever device address it's told to.
5. **The CCA OTA wire protocol (between sub-network controller and PowPak) is unreverse-engineered.** The coproc binaries `phoenix_hcs08_*.s19` / `phoenix_efr32_*.bin` would need RE to learn the actual 433 MHz packet format. But for our case we can probably skip this: Designer's existing path already handles the wire protocol — we just need to feed it the wrong file.

## Designer-side firmware push internals

CIL analysis of `Lutron.Gulliver.Infrastructure.dll` revealed the **filename-encoding binding mechanism** that's the simplest attack point.

### Filename pattern

`Lutron.Gulliver.Infrastructure.DomainObjectFramework.DeviceFirmwareInfo` ctor (token `0x06001cf7` @RVA `0x692d4`) builds the firmware filename for the processor as a deterministic string:

```
"{DeviceFamily:X4}{DeviceProductType:X4}{HardwareRev:X4}{0|1:X4}.frm"
```

- `0|1:X4` trailing nibble = `0` for OS/app image, `1` for Boot image

For PowPak: a standalone RMJ-16R-DV-B device at DeviceClass `0x16/0x03/0x02` would have its app firmware requested as filename `0016000300020000.frm`. The connected LMJ-16R-DV-B at `0x16/0x08/0x02` would request `0016000800020000.frm`.

**The processor stores firmwares by these filenames.** When a device reports its DeviceClass during update prep, Designer + processor compute the filename, and the processor either streams that file or returns "not found." There is **no DeviceClass→file cross-check in Designer's logic** — the DeviceClass IS the filename's prefix.

### Designer's Gulliver-protocol opcodes for firmware push

The legacy push flow uses Lutron's binary "Gulliver" TCP protocol (LEAP is a wrapper around this for newer transports — `IsLeapTransferEnabled` config flag toggles it):

| Opcode | Class | Body |
|--------|-------|------|
| 0 | `GulliverCommandDataFileTransferStartRequest` | 24-byte ASCII filename (NUL-padded) + uint32 size |
| 1 | `GulliverCommandDataFileTransferBlock` | uint32 blockNumber + raw bytes |
| 2 | `GulliverCommandDataFileTransferComplete` | CRC/checksum |
| 290 (`0x122`) | `DeviceFirmwareUpgradeModeCommand` | 1-byte: 0=Exit / 1=Enter mode |
| 272 (`0x110`) | `UpdateDeviceFirmwareCommand` | externally-prepared payload (link/device filter + filename) |
| 342 (`0x156`) | `ReportDeviceTransferStatusCommand` | per-link status (completed/failed/pending/disconnected device dicts) |
| 91 (`0x5b`) | `FirmwareUpgradeErrorCommand` | `OSError` / `BootError` / `GenericError` / `InternalError` |
| 286 (`0x11e`) | `ProcessorFirmwareUpdateStatusCommand` | single-byte percent |

DeviceClass mismatch is rejected by the **processor** via `BadResponseException` carrying one of:
- `InvalidDeviceFamily` (3)
- `DeviceOfSpecifiedFamilyNotFoundOnLink` (4)
- `InvalidDeviceRevision` (13)

So the rejection point we have to bypass is *processor-side*, not Designer-side. The processor reads the file's embedded header and refuses if it doesn't match the live device. (Whether this check is in lutron-core's `glink-link-driver` or in the sub-network controller's S-record receiver remains TBD.)

### Designer cloud-download credentials (hardcoded)

For completeness — `FirmwareFileProvider..ctor` at RVA `0x3be80` initializes the cloud request with hardcoded creds for `https://firmwareupdates.lutron.com:443/sources`: username `lutron-bridge`, password `Lutr0n@1`. Default `deviceclass=08110101` (the request key Lutron's cloud uses to pick the bundle to return). Captured here for completeness; this isn't useful for OTA conversion but is a noted artifact.

### Where the orchestrator actually lives

`Lutron.Gulliver.Infrastructure.dll` only has the *bottom* of the stack — protocol opcodes, the bundle parser, the cloud-download client. The actual orchestrator that turns "user clicks update" into the LEAP/Gulliver byte stream is in a higher-tier DLL we haven't unpacked: most likely `Lutron.Gulliver.DomainObjects.dll`, `Lutron.Gulliver.Programming.dll`, `Lutron.Gulliver.MainViewModel.dll`, or `Lutron.Services.Leap*.dll`. The literal LEAP message names (`BeginTransferSession`, `getCcaFirmwareUpdateSupportedDevices`, `fetchCCADeviceFirmwareUpdateDetails`) appear in NONE of the five DLLs we've inspected — so they live up there too.

## Concrete attack plan: RMJ-16R-DV-B → LMJ-16R-DV-B conversion

### Two facts that constrain every path

1. **Pairing is gated by SKU prefix.** RMJ devices pair only to ESN, RMJS only to Vive, LMJ only to RA2/3/HW. There is no cross-system pairing — RA3 won't enroll an RMJ device regardless of how the device behaves on RF. So a conversion is only "real" if after flash the device reports DeviceClass `0x16/0x08/0x02` (LMJ) and pairs to a HWQS/RA3 processor.
2. **Designer does NOT OTA CCA devices.** Designer's CCA-device firmware-update orchestration that we hypothesized earlier (filename binding, `BeginTransferSession`, etc.) only applies to CCX devices. CCA devices get their firmware updates from whichever host system they're paired to — the RA2/3/HWQS processor for LMJ, the ESN controller for RMJ, the Vive hub for RMJS — not from Designer.

These two facts together mean **the legacy "filename-swap-via-Designer" Path A described earlier is wrong for CCA**. Designer is not in the loop. The orchestration runs entirely on the host system the device is paired to.

For RMJ → LMJ conversion the chicken-and-egg is acute:
- An unconverted RMJ won't pair to an RA3 processor (so RA3 can't OTA it)
- An ESN controller can talk to the RMJ but isn't going to push LMJ firmware to it (and may not push firmware at all — ESN is broadcast-style)
- Once converted (firmware bytes report LMJ DeviceClass), the device will pair to RA3 cleanly, but getting it into that state requires reaching the device's flash with bytes the device hasn't been "OTA'd" with

### Path 1: Hardware reflash (BDM/JTAG)

The most reliable. The device's PCB has a BDM debug header (standard HCS08 production-programming interface). With a Freescale/PEMicro BDM pod or equivalent:

1. Pop open the PowPak case, find the BDM header
2. Read out the existing flash image (verify, archive)
3. Flash the LMJ `.ldf` payload — strip the 0x80-byte LDF header and write the raw HCS08 image to flash starting at the correct base
4. Power-cycle. Device now reports DeviceClass `0x16/0x08/0x02` and pairs as LMJ to RA3.

Per-device, manual, but deterministic. Works regardless of bootloader checks because BDM bypasses the bootloader entirely (writes directly via the chip's flash controller).

### Path 2: Direct CCA OTA via Nucleo+CC1101 (with proto from Phoenix coproc RE)

Skip every host system, send OTA packets directly to the PowPak from our own RF transmitter.

Prerequisites:
- Reverse-engineer the **Phoenix CCA coprocessor firmware** at [data/firmware/phoenix-device/coprocessor/](../../data/firmware/phoenix-device/coprocessor/) — `phoenix_hcs08_*.s19` (older HCS08), `phoenix_efr32_*.bin` (newer Cortex-M EFR32), or `phoenix_kinetis_*.s19` (Kinetis Cortex-M). These contain the CCA OTA framer that talks to PowPak. Existing Ghidra/BN projects at `phoenix-device/binaries/*.bndb`.
- Reverse-engineer the PowPak's bootloader OTA-receive entry. We've located the flash-write primitive at BN `0x4290` and the orphaned `sub_8bb4` that exclusively calls it (likely the OTA receive flash writer reached only via interrupt). The trigger packet pattern that puts the device into "receive new firmware" mode is unknown.
- Confirm whether the device's bootloader cross-checks an incoming firmware's declared DeviceClass against the in-flash one at body offset 0x8AD, and whether it allows writes to that range.

If the bootloader is permissive, we can transmit the LMJ `.ldf` payload over CCA RF directly to the device and complete the conversion. This is the most invasive but most flexible approach — independent of which Lutron system the device is currently paired to.

### Path 3: Pair RMJ to ESN, push via ESN's update mechanism (if it exists)

Pair the device to an ESN controller (its native system), then use whatever firmware-update mechanism ESN supports. Open questions:

- Does ESN support OTA updates of paired RMJ devices at all? ESN is broadcast-style; the controller may not have a per-device firmware-update protocol.
- If ESN does push firmware, what tool issues the command? Might be a separate Lutron commissioning utility.
- Even if ESN can OTA RMJ, can we substitute LMJ firmware bytes for the RMJ one ESN expects?

Blocked on acquiring ESN-controller firmware to RE.

### Path 4: Get an HWQS firmware bundle that includes PowPak `.pff` entries

The cleanest path *if it works*. The Phoenix RA3 manifest doesn't list PowPak, but the HWQS variant of Phoenix probably does. Steps:

1. Acquire a HomeWorks QSX firmware bundle (a `lutron_firmware` ZIP from the HWQS update CDN — `firmware-downloads.iot.lutron.io/...`)
2. Decrypt it with the same AES key (`6cba80b2bf3cf2a63be017340f1801d8` — confirmed working for Phoenix bundles, likely the same chip line and key)
3. Inspect that bundle's `device-firmware-manifest.json` for PowPak entries (DeviceClass `0x16/...` rows)
4. If present, the `.pff` files in the HWQS bundle are the ones the System Monitor portal sends through Pipeline 2 to PowPak

This would tell us:
- The actual PowPak `.pff` format (vs. the Designer-shipped `.ldf` we have)
- Whether HWQS distinguishes RMJ and LMJ as separate DeviceClass entries
- The wire-protocol path is the same Pipeline 2 — confirming the conversion attack reduces to manifest editing on a rooted HWQS processor (modulo the device-bootloader's own DeviceClass check)

### Bootloader unknowns (gates Paths 2 and 3)

The PowPak's bootloader has its own validation that we haven't characterized:
- Does it check the firmware's declared target DeviceClass against the in-flash DeviceClass at 0x8AD before accepting the image?
- Does it allow flash writes to the address range containing 0x8AD (Section A's factory-config block)?
- Is there a CRC/signature check on the incoming firmware?

If the bootloader is permissive everywhere, Paths 2/3 work. If it refuses to write to certain ranges, only Path 1 (BDM) reliably works.

## CCA OTA wire protocol (RE'd from Phoenix EFR32 coproc)

Verified against PowPak's RX side — both ends configured byte-for-byte identically. Full reference: [reference-cca-ota-wire-protocol.md](file:///Users/alex/.claude/projects/-Users-alex-lutron-tools/memory/reference-cca-ota-wire-protocol.md).

### Modem config (CC1101)

Phoenix coproc (TX) and PowPak (RX) share:
- GFSK, 30.49 kbps, 32 kHz deviation, ~162 kHz channel bandwidth
- PKTCTRL0 = 0x32 — async serial mode (MCU bit-bangs framing on both ends)
- MDMCFG2 = 0x10 — sync-mode = 0 (chip does NOT do sync detection — software does)
- ~~35-channel frequency hopping table~~ — empirically single-channel at ~433.566 MHz; the 35-row table is something else (see [cca-ota-live-capture.md](cca-ota-live-capture.md))

### On-air framing

```
[3 × 0x55][0xFF][0xFA 0xDE][LEN:1][OP:1][PAYLOAD:N][CRC16:2]
```

Total 6-14 bytes per packet. Sync word **`FA DE`** is the discriminator the bootloader bit-bangs a search for. CRC-16 polynomial **0xCA0F** (the standard CCA polynomial — confirmed by the byte sequence `ca 0f` adjacent to the framing template constant in PowPak flash).

### OTA opcodes

| Opcode | HDLC cmd ID | Name | On-air body | Purpose |
|--------|-------------|------|-------------|---------|
| **0x2A** | 0x113 | **BeginTransfer** | 7 | **Wake-up — bootloader enters receive mode** |
| 0x32 | 0x119/0x11B/0x11D | ChangeAddressOffset / EndTransfer / ResetDevice | 6 | Multi-purpose control |
| 0x33 | 0x125 | GetDeviceFirmwareRevisions | 4 | |
| 0x34 | 0x127 | CancelDeviceFirmwareUpload | 6 | |
| 0x35 | 0x129 | (broadcast) | 0 | |
| 0x36 | 0x11F | CodeRevision | 4 | |
| 0x3A | 0x121 | ClearError | 8 | |
| 0x3C | 0x12B | (ack/notify) | 4 | |
| **0x41** | 0x115 | **TransferData** | 4 | **Carries firmware bytes — small chunks** |
| 0x58 | 0x111 | QueryDevice | 5 | Initial probe |

Wake-up sequence: `QueryDevice` → `CodeRevision` → `BeginTransfer` → `ChangeAddressOffset` → `TransferData` × N → `EndTransfer` → `ResetDevice`.

The Phoenix coproc has **NO DeviceClass enforcement** — it relays whatever lutron-core asks. The on-device gate is whatever the PowPak bootloader does itself.

### PowPak's RX side — anchors

Located in PowPak's bootloader region (verified in [data/firmware-re/powpak/PowPakRelay434L1-53.bin](../../data/firmware-re/powpak/PowPakRelay434L1-53.bin)):

| Anchor | Body offset | BN address | Bytes / decode |
|--------|-------------|------------|-----------------|
| **Sync word check** | 0x52C0 | 0x92C0 | `65 FA DE 26 6C` = `CPHX #$FADE; BNE +0x6C` |
| **OTA framing template constant** | 0x5714 | 0x9714 | `55 55 55 FF FA DE 00 00 CA 0F ...` (preamble + sync + CRC poly) |
| **Opcode 0x41 dispatch (TransferData)** | 0x4680 | 0x8680 | `C6 0C 08 A1 41 26 11 ...` = `LDA $0C08; CMP #$41; BNE +0x11` |
| **Opcode 0x32 dispatch (Control)** | 0x1023A | 0x1423A | `... A1 32 22 30 ...` = `CMP #$32; BHI +0x30` |

Multiple paths CMP against 0x32 (at body offsets 0x1023A, 0x15B0B, 0x15B82, 0x15BAC, 0x18903) suggest the dispatch fans out across multiple states or banks.

The receive-side state machine + flash-write integration appears to start in the BN 0x9290-0x9300 region (the function containing the FADE sync check). Likely the orphaned `sub_8bb4` (which exclusively calls flash-write) is reached from this state machine via a function pointer or banked-CALL we couldn't trace earlier.

## Revised attack feasibility

With the wire protocol fully decoded, **Path 2 (direct CCA OTA from Nucleo+CC1101) is now concrete**:

1. Configure Nucleo+CC1101 with the shared register values (LEC table from `docs/firmware-re/powpak.md`)
2. Build packets with framing `55 55 55 FF FA DE [len][op][payload][CRC16(0xCA0F)]`
3. Bit-bang via async serial mode (PKTCTRL0=0x32)
4. Hop channels per the 35-entry table
5. Send the sequence: `QueryDevice` (0x58) → `CodeRevision` (0x36) → `BeginTransfer` (0x2A) → `ChangeAddressOffset` (0x32) → `TransferData` (0x41) × N → `EndTransfer` (0x32) → `ResetDevice` (0x32)
6. Stream LMJ firmware bytes via TransferData chunks

Bootloader-side validation (the only remaining gate) can now be characterized with focused RE since we know exactly which dispatch entry to follow — start at BN `0x8680` (CMP #$41 for TransferData) and trace what the handler does with the incoming bytes; specifically, whether it checks the firmware's embedded DeviceClass at `0x008AD` against the in-flash one before flashing.

### Bootloader unknowns (gates on every path)

The PowPak's bootloader has its own validation that we haven't characterized:
- Does it check the firmware's declared target DeviceClass against the in-flash DeviceClass at 0x8AD before accepting the image?
- Does it allow flash writes to the address range containing 0x8AD (Section A's factory-config block)?
- Is there a CRC/signature check on the incoming firmware?

If the bootloader does flash *anywhere*, conversion is complete on next reset. If it refuses to write to certain ranges, we either need (a) a vulnerability in the bootloader's flash-range protection logic, or (b) BDM/JTAG hardware reflash (well-trodden path on HCS08).

## LDF vs PFF: format comparison

Lutron uses two completely different firmware container formats depending on the device family:

| Aspect | LDF (legacy QS — PowPak/QS-Wallstation/etc.) | PFF (Pegasus — CCA/CCX/Sunnata/etc.) |
|--------|----------------------------------------------|--------------------------------------|
| **Distribution** | Bundled in Designer MSIX (`QuantumResi/BinDirectory/Firmware/...`) | Inside encrypted Phoenix firmware bundle (`firmware.tar.enc → cca/*.pff`) |
| **Routing key** | Filename `{family:X4}{product:X4}{hwrev:X4}{0|1:X4}.frm` (Designer→processor) | DeviceClass lookup in `device-firmware-manifest.json` (processor) |
| **Header size** | 0x80 bytes (128 B) | 0x124 bytes (292 B) |
| **Header content** | ASCII filename (64 B) + 16×BE32 metadata (size, format ver, CRCs) | format ver + image type + IV/signature (64 B) + zero pad + DeviceClass + revisions + payload size + target flash address |
| **Encryption** | None — plaintext HCS08 binary | AES-128 (ATECC608 secure-element slot 6, key `6cba80b2bf3cf2a63be017340f1801d8`) |
| **Signature** | None visible | 64-byte IV/signature region in header (likely ECDSA over header+payload) |
| **DeviceClass byte location** | Inside the firmware bytes at body offset 0x008AD (factory-config region) | In the **header** at offset 0x110 (wrapper field, separate from payload) |
| **Underlying payload** | Compiled HCS08 image with bootloader + factory-config + application | Encrypted blob — when decrypted, **also** Motorola S-records (the device's MCU image) |
| **Byte order** | Big-endian metadata fields | Big-endian metadata fields |
| **Payload addressing** | Implicit — flashed as a 1:1 image | Explicit — header carries target flash address (e.g., `0x0006F000` for eagle-owl app) |

Key consequences:

- **PFF is verifiable without decryption** because the DeviceClass and target-flash-address are in the unencrypted header. Phoenix's `pegasus-firmware-update` module reads these wrapper fields, looks up the manifest entry by DeviceClass, then asks the secure element to decrypt the payload before streaming.
- **LDF binds DeviceClass through the filename**, not the header — so a renamed `.ldf` will be routed to whatever device's filename matches, which is the seam Path A exploits.
- **Both formats ultimately deliver Motorola S-records** to the device's MCU. The processor side just adds varying amounts of crypto/integrity tooling on top.
- **CCA-on-Pegasus** (newer 0x03xx CCA devices on Phoenix RA3) uses PFFs because the Phoenix firmware-bundle distribution model encrypts everything. **CCA-on-QS-Link** (PowPak family 0x16, QSE-CI-NWK-E sub-network controllers, GRAFIK Eye, etc.) uses LDFs because they ride Designer's much older "MSIX-bundled" distribution model.

The format inflection point matters for our attack: PFF's signed/encrypted header makes Path A (filename swap) impossible there — you'd need the ECDSA signing key. LDF's plaintext format means Path A works trivially: just rename a file. **PowPak being on the LDF path is exactly why the conversion attack is feasible at all.**

## Open questions

- **Does the bootloader's OTA receiver verify firmware-target compatibility?** Find the function that parses the incoming firmware header and decides whether to flash. Likely in Section A near the flash-write primitive at BN 0x4290.
- **What's the boundary between "updateable" and "non-updateable" flash?** If the OTA path only writes Section B, Section A's DeviceClass is locked. If it can write Section A, the conversion is mechanical.
- **Bootloader's reset/init code**: Section A starts at body 0x20 with the `sub_4020` trampoline. The reset vector and startup init are elsewhere — vector table not at any standard 16KB-aligned offset in the flat-load.
- **MC9S08 model identification**: FSTAT@0x1825, FCMD@0x1826 fits QE128. Heavy stores to $183D look unusual — could be SCI status register or a chip-specific peripheral. Distinguishing QE128 vs DZ128 vs LL family pending.
- **FREQ register setting**: where is FREQ2/1/0 written for this 434 MHz build? The CC1101 LEC table doesn't include it.
- **Bootloader header decoding**: the fixed 32-byte handshake at body[0:0x20] still needs decoding.
- **FREQ hopping schedule**: how channels are sequenced. CCA uses TDMA-aligned hopping.
- **Section B function pointer table** (7 entries → 0x7403-0x75F0): probably interrupt/event handlers.
