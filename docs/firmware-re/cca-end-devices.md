# CCA End-Device Firmware

Reverse-engineering notes for the three "phoenix_hcs08_3000-*" binaries extracted from the Phoenix coproc-firmware-update-app blob. The orchestration prompt described these as HCS08 (Freescale 8-bit) end-device firmware images for eagle-owl/basenji/bananaquit dimmers, picos, and switches. **That premise is wrong.** This document records what they actually are.

## TL;DR — These are NOT HCS08

All three "phoenix_hcs08_3000-*" .bin files are **ARM Cortex-M Thumb-2 binaries**, not HCS08. Evidence is unambiguous:

| File | Size (bin) | First-word (LE) | Reset handler (LE word minus Thumb bit) |
|------|------------|-----------------|------------------------------------------|
| `phoenix_hcs08_3000-1E808.bin` | 110 884 B mapped | `0x20004000` (16 KB SRAM) | `0x00014E14` |
| `phoenix_hcs08_3000-3E808.bin` | 154 728 B mapped | `0x20008000` (32 KB SRAM) | `0x000139F8` |
| `phoenix_hcs08_3000-7E808.bin` | 153 044 B mapped | `0x20010000` (64 KB SRAM) | `0x000136D8` |

- The first word of each image is a stack pointer at `0x2000xxxx` (i.e., Cortex-M SRAM region) — exactly as Cortex-M startup requires.
- The second word is a reset-handler address with the Thumb bit (`0x...01`) set — Cortex-M convention.
- Vector entries +0x08 through +0x38 all point to the same default-handler address (single-loop fault catcher) — classic Cortex-M layout, 14 IRQ slots in this file's case.
- Disassembled at the reset handler, all three start with `cpsid i` followed by `bl` calls into init routines — Cortex-M startup boilerplate.
- Bytes representative of Thumb-2 executable code dominate (`bx lr`/`70 47` appears 451-655 times per file; `nop.n`/`00 bf` 547-734 times; many `f0 b5`/`push {r4-r7,lr}` instances).
- Peripheral-base address literals match EFR32 family registers (EFR32 EMU `0x400E3000` appears 4-13 times per binary; EFR32 GPIO `0x4000A000` appears 5-10 times).

There is **no HCS08 banked-flash structure** in these images: no S2 record gaps that would correspond to PPAGE windows, no HCS08 instruction patterns, no `CPHX #$FADE; BNE` anchor of the kind found in PowPak's actual HCS08 firmware.

## What they actually are

Most likely the **same family as the explicitly-EFR32-named coproc images** (`phoenix_efr32_8003000-*`), with a different distribution wrapper. Stack-pointer values, reset-handler positions, and instruction density all match. The flash base differs (`0x3000` here vs `0x8003000` for the explicit-EFR32 set), but that's `0x8000000` = the Cortex-M flash base — i.e., the "hcs08" image was extracted with the absolute base stripped, while the "efr32" image kept it. The actual chip family appears to be **EFR32 (or another bare-metal Cortex-M)** running the bridge-side CCA radio firmware, **not** end-device firmware.

**These are bridge-side coprocessor variants, not end-device firmware.** PR #32's correction (that they are "DEVICE firmware, not bridge dispatch") is unsupported by the binary contents. That correction may have been overruled by my analysis here, or the same "device firmware" tag in upstream Lutron build trees may refer to firmware that runs on whatever device receives it via the OTA pipeline — but for the three files in question the wire-protocol fingerprint we expected from device-side RX/TX is absent.

## CCA wire-protocol fingerprint search results

Across all three binaries, byte-pattern searches for the CCA wire-protocol constants returned essentially nothing:

| Pattern | 1E808 | 3E808 | 7E808 |
|---------|-------|-------|-------|
| `FA DE` (sync, BE inline) | 0 | 0 | 1 (BN `0x20473`) |
| `DE FA` (sync, LE half-word) | 1 (BN `0x6BA2`) | 0 | 2 (BN `0x539E`, `0x14662`) |
| `0xFADE` as Thumb-2 `MOVW`/`CMP` immediate | 0 | 0 | 0 |
| `55 55 55 FF FA DE` preamble template | 0 | 0 | 0 |
| `CA 0F` CRC poly bigram | 0 | 0 | 0 |
| `0F CA` CRC poly bigram (LE 0xCA0F) | 1 (BN `0x11C23`) | 0 | 0 |
| Full 256-entry CRC-16/0xCA0F LUT | 0 | 0 | 0 |
| `LEC` magic (CC1101 register table tag) | 0 | 0 | 0 |
| CC1101 IOCFG2/1/0 init triple `0E 2E 0D` | 0 | 0 | 0 |

For comparison, the explicitly-EFR32-named coproc images (`phoenix_efr32_8003000-{801FB08,803FF08,807F808}.bin`) contain `FA DE`, `0F CA`, and the full CRC-16/0xCA0F lookup table — that's where bridge-side CCA OTA packet construction lives, and it's documented in [coproc.md](./coproc.md) and [protocols/cca.md](../protocols/cca.md).

The few isolated `FA DE` / `DE FA` bigrams in our three binaries (1-2 per file) are statistically consistent with random byte coincidence in dense Thumb-2 code (they don't sit inside instruction immediates, they don't occur in literal pools that get loaded by `LDR rN, [pc, #...]`, and they don't appear with neighboring preamble bytes). They are not the CCA sync-word constant.

## Per-binary observations

### phoenix_hcs08_3000-1E808 (small variant, "CoProcApplication")

- Mapped range: `0x3000` - `0x1E807`, sparse in S19 (110 884 bytes mapped out of 113 672 file bytes; the .bin pads gaps with `0x00`)
- Reset handler at `0x14E14`. Init body:
  ```
  0x14E14  cpsid    i
  0x14E16  bl       0x14d84
  0x14E1A  bl       0x14a2c
  0x14E1E  bl       0x3b2c
  0x14E22  bl       0x14a90
  ```
  Four init calls — typical bare-metal Cortex-M C runtime startup.
- S0 record of the S19 says `bin/CoProcApplication/CoProcApplication.` (truncated). This file was likely renamed from a build-tree path that wraps a Cortex-M binary into the same delivery mechanism HCS08 would have used — the build-tree path does not, by itself, prove an HCS08 chip.
- Copyright string: `Copyright 2016 Lutron Electronics` at `0x1D704`.
- Ghidra processor: `ARM:LE:32:Cortex` with `BinaryLoader -loader-baseAddr 0x3000`. (PR #34 originally found this; the tool now does it automatically — see [tools/ghidra-load-arm-coproc.sh](../../tools/ghidra-load-arm-coproc.sh).)

### phoenix_hcs08_3000-3E808 (medium variant, supposed "eagle-owl CCA app")

- Mapped range: `0x3000` - `0x3E807`, 154 728 bytes mapped.
- Reset handler at `0x139F8`:
  ```
  0x139F8  cpsid    i
  0x139FA  bl       0x13968
  0x139FE  bl       0x13524
  0x13A02  bl       0x5990
  0x13A06  bl       0x1358c
  ```
- S0 record path is `/home/jenkins-agent/workspace/Production` — the same Jenkins build tree used for other Phoenix coproc images.
- Copyright string: `Copyright 2014 Lutron Electronics` at `0x2814C`.
- 164 references to Cortex SCB VTOR (`0xE000ED00`) — heavy use of vector-table relocation, suggesting a multi-image (bootloader + app) layout where SCB->VTOR gets repointed at boot.

### phoenix_hcs08_3000-7E808 (large variant, supposed "bananaquit/basenji larger flash")

- Mapped range: `0x3000` - `0x7E807`, 153 044 bytes mapped (sparse — large gaps between code regions).
- Reset handler at `0x136D8`:
  ```
  0x136D8  cpsid    i
  0x136DA  bl       0x13648
  0x136DE  bl       0x13204
  0x136E2  bl       0x5680
  0x136E6  bl       0x1326c
  ```
- Init structure is nearly identical to 3E808 — same library, different application code on top.
- Copyright string: `Copyright 2014 Lutron Electronics` at `0x27BA8`.
- 161 references to Cortex SCB VTOR — same multi-image layout as 3E808.

## Why the original HCS08 hypothesis was wrong

Several plausible mistakes that could have led to the misidentification:

- **Build-tree path naming.** Lutron's Jenkins workspace contains a directory called `bin/CoProcApplication` that produces images for multiple chip families. Whoever first wrote the doc may have generalized "HCS08" from a single image type without verifying.
- **S2-record format.** Motorola S-record S2 lines use 24-bit linear addresses, which can host Cortex-M images perfectly well (most ARM toolchains emit S19/S2 by default). S2 ≠ HCS08.
- **PowPak precedent.** PowPak's HCS08 firmware ([powpak.md](./powpak.md)) is genuine and well-characterized, with anchors at `0x92C0` (`CPHX #$FADE; BNE`) and `0x8680` (opcode 0x41 dispatch). Someone may have transferred the "HCS08 device firmware" pattern from PowPak to these binaries by analogy without verifying.

## Next steps

If the orchestrator's premise was right that **separate** end-device firmware images for eagle-owl/basenji/bananaquit exist somewhere in the Phoenix build, those images are not these three binaries. Possible locations to check:

1. **The encrypted Phoenix `firmware.tar.enc` PFF entries.** `cca/cca-eagle-owl-*.pff`, `cca/cca-bananaquit-avis-*.pff`, `cca/cca-basenji-*.pff` were enumerated in `device-firmware-manifest.json` (see [coproc.md](./coproc.md) §Device Firmware Manifest). These are the **actual end-device images** that get OTA'd to the device — but they're encrypted with the per-model AES-128 key in ATECC608 slot 6 (`6cba80b2bf3cf2a63be017340f1801d8` for the chip line in question) and need decrypting before RE.
2. **HomeWorks QSX firmware bundle.** May carry distinct CCA end-device images that don't appear in the RA3 Phoenix bundle.
3. **MSIX-bundled `.ldf` files in Designer.** PowPak's actual HCS08 firmware ships in `QuantumResi/BinDirectory/Firmware/QuantumResi/qs_firmware_and_tools/powpak modules/`; eagle-owl / basenji / bananaquit `.ldf` files (if they exist) would ship in a similar tree.

Until the orchestration prompt's premise is reconfirmed against actual end-device firmware, the wire-protocol RE for what dimmers/picos/switches send and receive remains an open question. The bridge side is well-characterized in [coproc.md](./coproc.md) and [protocols/cca.md](../protocols/cca.md); the device side requires acquiring the matching `.pff` decryption result or the `.ldf` body for these specific device classes.

## Tooling notes

- Use [tools/ghidra-load-arm-coproc.sh](../../tools/ghidra-load-arm-coproc.sh) (renamed from `ghidra-load-cca-hcs08.sh`) to import these binaries — uses `-processor ARM:LE:32:Cortex` with the base address auto-detected from the filename pattern `*_<starthex>-<endhex>.bin`. The whole file is loaded as one block (no carving — these are flat Cortex-M images, not banked HCS08).
- Capstone (`/tmp/cca-arm-venv` Python venv) provides a workable disassembly path without needing Ghidra: `capstone.Cs(CS_ARCH_ARM, CS_MODE_THUMB)`. Reset-handler dumps and instruction-byte stats above all came from this path.

## Cross-reference vs bridge-side knowledge

| Bridge-side claim | Confirmed in these binaries? |
|-------------------|------------------------------|
| Sync word `0xFADE` | **No** — not present as instruction immediate or literal-pool entry |
| Preamble `55 55 55 FF FA DE` | **No** — not present as inline byte sequence |
| CRC-16 polynomial `0xCA0F` | **No** — only one isolated `0F CA` bigram in 1E808, no LUT |
| Opcodes `0x2A`/`0x32`/`0x33`/.../`0x58` | **N/A** — without the sync word search anchor we can't confirm dispatch |
| 35-channel hop table (`0x44..0x66` increments) | **No** — not located in any of the three |
| Format-0x0E SET_LEVEL / DIM_CONFIG / ZONE_BIND | **N/A** |
| Button events / pairing requests | **N/A** |

Every wire-protocol marker the orchestrator asked for was absent. The bridge-side EFR32 binaries (`phoenix_efr32_8003000-*`) are the ones where the markers live. Until we get the actual end-device firmware decrypted from the PFF bundle, the device-side RX dispatch and TX builder cannot be walked.
