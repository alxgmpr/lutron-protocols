---
name: s19-firmware-re
description: "Reverse engineer Lutron S19/LDF firmware files — HCS08 MCU, CC1101 radio, CCA protocol extraction using Ghidra and Binary Ninja MCP tools"
metadata:
  author: alex
  version: "1.0"
user_invocable: false
---

# Reverse Engineering Lutron S19 Firmware

Analyze Motorola S-record (.s19) and Lutron Device Firmware (.ldf) files from Lutron's HCS08-based CCA devices (dimmers, switches, keypads, sensors, picos, VCRX, QSM).

## Firmware File Locations

**S19 files** (~160 files): `re/designer/QuantumResi/BinDirectory/Firmware/qs_firmware_and_tools/`
**LDF files** (~34 files): Same tree, `.ldf` extension (Lutron proprietary container)
**QSM firmware**: `QSM_8.015_434MHz.s19` — the most-analyzed firmware, a Smart Bridge/processor

## MCU Architecture: Freescale HCS08

- **Family**: MC9S08 (8-bit, von Neumann, 40MHz bus)
- **Flash**: Banked — PPAGE register selects 16KB pages mapped at 0x8000-0xBFFF
- **Linear address**: `PPAGE * 0x4000` (e.g., page 0x0A → linear 0x28000)
- **RAM**: 0x0080-0x07FF (2KB typical), shared across all pages
- **Banked calls**: `CALL addr16, page_byte` (opcode 0xAC) / `RTC` (opcode 0x8D) for return
- **Interrupt vectors**: 0xFFC0-0xFFFF (unpaged, always visible)

### Key HCS08 Instructions for RE
- `AND #imm` on sequence bytes → TDMA slot mask extraction (AND #3, #7, #15, #31, #63)
- `CALL target, page` → cross-page subroutine (must track page context)
- `JSR` → same-page subroutine
- `LDHX` → load index register pair (16-bit pointer)
- `STA/LDA offset,X` → indexed memory access (common for packet field extraction)

## Ghidra Setup

### Patched HCS08 Processor
Ghidra's stock HCS08 lacks CALL (0xAC) and RTC (0x8D) opcodes. Patched in:
`/Users/alex/Downloads/ghidra_12.0.4_PUBLIC/Ghidra/Processors/HCS08/data/languages/HCS_HC.sinc`

If the .sinc is modified, delete `.sla` files to force recompilation.

### Project
`/Volumes/Secondary/lutron-tools/re/designer/ghidra_project3/qsm_final`

Contains 6 programs (QSM firmware split by page):
- `qsm_64k.bin` — unpaged code (0x0000-0xFFFF) — C startup, vectors, trampoline API
- `page_0A.bin` — CCA radio protocol, 8N1 codec, packet construction, pairing engine
- `page_12.bin` — 316 functions
- `page_16.bin` — 503 functions (largest page)
- `page_1A.bin` — 376 functions
- `page_1E.bin` — 65 functions (smallest)

### Using Ghidra MCP Tools
```
mcp__ghidra__list_functions        — enumerate all functions in current program
mcp__ghidra__decompile_function    — decompile by name
mcp__ghidra__decompile_function_by_address — decompile by hex address
mcp__ghidra__get_function_xrefs    — find callers/callees
mcp__ghidra__list_strings          — find string constants
mcp__ghidra__search_functions_by_name — search by partial name
mcp__ghidra__set_decompiler_comment — annotate findings
mcp__ghidra__rename_function       — rename from FUN_xxxx to meaningful name
mcp__ghidra__set_function_prototype — fix signatures for better decompilation
```

## Binary Ninja Setup

For firmware not loaded in Ghidra, or for cross-referencing, use Binary Ninja MCP:
```
mcp__binary_ninja_mcp__list_binaries       — see loaded files
mcp__binary_ninja_mcp__select_binary       — switch active binary
mcp__binary_ninja_mcp__decompile_function  — decompile
mcp__binary_ninja_mcp__search_functions_by_name
mcp__binary_ninja_mcp__list_strings
mcp__binary_ninja_mcp__hexdump_address     — raw memory inspection
mcp__binary_ninja_mcp__get_xrefs_to        — find references
```

## S19 File Format

Motorola S-record format:
- `S0` — header record (file info)
- `S1 LL AAAA DD...DD CC` — 16-bit address data record (len, addr, data, checksum)
- `S2 LL AAAAAA DD...DD CC` — 24-bit address data record
- `S9` — end record (16-bit start address)

### Parsing S19 to Binary
```bash
# Quick extraction with srec_cat (brew install srecord)
srec_cat input.s19 -o output.bin -binary

# For banked HCS08: extract specific address ranges
srec_cat input.s19 -crop 0x8000 0xC000 -offset -0x8000 -o page.bin -binary

# Python one-liner to dump S1 records
python3 -c "
import sys
for line in open(sys.argv[1]):
    if line.startswith('S1'):
        n = int(line[2:4], 16) - 3
        addr = int(line[4:8], 16)
        data = bytes.fromhex(line[8:8+n*2])
        print(f'{addr:04X}: {data.hex()}')
" input.s19 | head -20
```

### LDF Files
Lutron Device Firmware files — proprietary container wrapping S19 data with metadata (device class, version, checksums). The S19 payload can usually be found by searching for `S0` or `S1` ASCII within the file:
```bash
strings firmware.ldf | grep "^S[012]" | head -5
```

## Key Analysis Patterns

### Finding CC1101 Register Configuration
Search for SPI write sequences — the CC1101 config is written as register-address + value pairs:
- Register addresses 0x00-0x2E (configuration)
- Burst write to 0x3F (TX FIFO)
- Status read from 0x30-0x3D (with 0xC0 burst bit)
- Look for sequences of `STA 0x3F,X` or calls to the SPI write trampoline (0x04A9 in QSM)

### Finding CCA Packet Handlers
- Packet dispatch typically switches on byte[6] (protocol/command class) or byte[0] (type)
- Look for `CMP #imm` / `BEQ` chains or `LDHX` → `JSR` through jump tables
- The QSM trampoline at 0x0283 is the universal TX function: `func_0x0283(format_code, buffer)`

### Finding TDMA Timing
- `AND #7` / `AND #15` / `AND #31` on sequence bytes → slot mask
- TPM (Timer/PWM Module) configuration → slot frame timer
- RAM locations storing slot position (QSM: 0x0143-0x0144)

### Finding CRC Implementation
- Polynomial 0xCA0F (CCA CRC-16)
- Look for 256-entry or 32-entry (nibble) lookup tables
- QSM CRC table at linear 0x5D5E25 (SB page 0x175, offset 0x1E25)

### Finding 8N1 Codec
- Bit shift chains (`LSL` / `ROR` / `AND #mask`) across byte boundaries
- QSM encoder at page_0A FUN_8e4f, decoder at FUN_9068/909c
- Pattern: create single-bit mask, shift by position count, test individual bits

### Cross-Device Comparison
160 S19 files cover all Lutron CCA device families. Useful for:
- Confirming register values are consistent across devices
- Finding device-specific features (shade control, sensor readings, CCO relay)
- Identifying shared base code vs device-specific pages

## Existing RE Documentation

- `docs/firmware-re/qsm.md` — QSM (Smart Bridge) complete analysis: trampoline table, TDMA timing, 8N1 codec, CRC, CC1101 config, packet dispatch, frequency hopping
- `docs/firmware-re/esn.md` — ESN (Energi Savr Node) analysis
- `docs/protocols/cca.md` — CCA protocol reference built from RE findings
- `docs/infrastructure/firmware-updates.md` — How firmware update delivery works

## Workflow

1. **Identify target**: Pick an S19 file from the firmware tree based on device type
2. **Convert to binary**: Use `srec_cat` to extract the binary, noting address ranges
3. **Load in Ghidra/BN**: Import as HCS08 (Ghidra) or raw binary (BN), set base address
4. **Find entry points**: Interrupt vectors at 0xFFC0-0xFFFF, reset vector at 0xFFFE
5. **Identify pages**: For banked firmware, extract each page separately (0x8000-0xBFFF ranges)
6. **Cross-reference with QSM**: Known function addresses from QSM (trampoline table) often appear at the same addresses in other devices sharing the same base image
7. **Document findings**: Update `docs/qsm-firmware-re.md` or create device-specific docs, update protocol definitions in `protocol/cca.protocol.ts`
