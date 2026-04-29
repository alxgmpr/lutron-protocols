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

Decryptor at [exploits/firmware-unlock/grafik-eye-decrypt.py](../../exploits/firmware-unlock/grafik-eye-decrypt.py) implements the full pipeline. Running against `sysconfig32.dll`:

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

## Code analysis

Analysis of the decrypted main-MCU image `grafik-eye-qs-8.027-00008000-0007e913.bin` loaded at base 0x00008000 in Binary Ninja (M68K architecture).

### MCU

**Freescale ColdFire V2** (most likely MCF5225x / MCF5227x family — 512 KB flash, 64 KB SRAM, USB OTG, QSPI, 3× UART, I²C). Evidence:

- **Reset handler at 0x7DD78**: `MOVE #$2700,SR` (mask IRQs) → write `0x40000001` to `0x40000000` (enable MBAR) → `MOVEC D0,$0C05` (RAMBAR enable at address 0x20000000) → copy 0x100-byte vector table to RAM → `MOVEC A1,VBR` → `SP = 0x2000FDFF` → `JMP $390B0` (main). The MBAR-at-0x40000000 + MOVEC-CR-0x0C05 + RAMBAR layout is textbook MCF5xxx V2.
- **Core Watchdog Service Register at MBAR+0x13** (`sub_34820`): writes 0x55 then 0xAA to `$40000013` on each main-loop tick — matches MCF5272/MCF5307 CWSR pattern.
- **Build sandbox path** `C:\Sandbox\EcoSystemBoard\bin\qsg_eco_operate.prm` in UI resource region (file offset 0x419C4) — `.prm` is Freescale CodeWarrior linker parameter file.
- **Banner `GRX 8-27`** at file offset 0x400 (virtual 0x8400) — embedded version string.
- Classic 68K instruction patterns throughout (LINK.W, UNLK, JSR, MOVEM.L) with ColdFire-specific MOVEC to CR 0x0C05, no `MOVE from SR` in user mode — consistent with CF V2 core.

### Memory map

| Range | Purpose |
|-------|---------|
| `0x00000000 – 0x00007FFF` | 32 KB boot region (not in this dump — likely the never-field-updated boot ROM per [training notes](../reference/training-notes-index.md)) |
| `0x00008000 – 0x0007E913` | Main firmware code + const data (this binary) |
| `0x01600000 – ?` | External memory-mapped LCD display (chip-select to Display Board, byte-wise writes) |
| `0x20000000 – 0x2000FDFF` | 64 KB SRAM (SSP init = 0x2000FDFF) |
| `0x20000000 – 0x200000FF` | Relocated vector table (set via VBR) |
| `0x40000000 – 0x4000FFFF` | MBAR peripheral window |
| `0x40100000 – 0x401FFFFF` | Off-MBAR peripherals (GPIO, ADC, USB OTG, etc.) |

### Peripheral register usage (MBAR = 0x40000000)

Access counts derived from distinct 32-bit-absolute-addressing hits in code (per-register range only; earlier count of 215 for I²C overlapped QSPI — corrected here):

| Peripheral | Base | Refs | Purpose |
|-----------|------|------|---------|
| **UART0** | `0x40000200` | 29 | **QS Link** (RS-485 wired) |
| **UART1** | `0x40000240` | 28 | **Inter-board link** (Display Board / Power Board candidate) |
| **UART2** | `0x40000280` | 37 | **Inter-board link** (Daughter Board candidate — highest UCR activity) |
| **I²C0** | `0x40000300-0x31F` | 4 | Minimal — likely an RTC or temperature sensor probe |
| **QSPI** | `0x40000340-0x35F` | 196 | **External SPI flash** (persistent settings) — see below |
| **DMA** | `0x40000100` | 96 | Bulk transfers |
| **DTIM0-3** | `0x40000400` | 43 | Slot/frame timing |
| **INTC0** | `0x40000C00` | 23 | Interrupt controller |
| **GPIO** | `0x40100000` | 193 | Ports for buttons/LEDs/CS lines |
| **Clock** | `0x40120000` | 8 | PLL |
| **EPORT** | `0x40130000` | 4 | External interrupt pins |
| **ADC** | `0x401A0000` | 71 | Photosensor/IR/line-voltage sampling |
| **USB OTG** | `0x401C0000` | — | Firmware-update slave |
| **Ethernet (FEC)** | `0x40001000` | 8 | Present but not used (likely dead-stripped code) |

No references to `0x401D0000` (CFM/Flash controller) — persistent settings are NOT written to internal flash. Storage lives in external SPI flash on the QSPI bus (see "Persistent settings" section).

### External SPI flash on QSPI (was: "daughter board" — corrected)

Initial analysis mis-identified QSPI as the radio/daughter-board link. It's actually a **serial NOR flash** (Winbond/Macronix/Atmel-class 25xxx-series). Confirmed by the command-byte distribution written via `move.w #imm, ($40000354).l`:

| SPI cmd | Count | Meaning |
|---------|-------|---------|
| `0x20` | 9 | Sector Erase (4 KB) |
| `0x03` | 2 | Read Data |
| `0x05` | 2 | Read Status Register |
| `0x06` | 1 | Write Enable |
| `0x02` | 1 | Page Program |

`sub_2ECA8` is the SPI-flash read wrapper. It packs a 16-bit address into the QSPI Command RAM with opcode 0x03, starts the transfer via QDLYR, polls QIR, and returns the received byte from QDR. The `d7 >= 0x8000` branch distinguishes write (strip top bit) from read (invert) — a small Lutron abstraction, not a flash protocol concept.

Settings journal at `0x20005BB3`/`0x20005EB5` is the in-RAM cache; the journal is flushed to SPI flash sector-by-sector via `sub_3E500` → QSPI. Scene programs, zone assignments, labels, and the edit-lockout password all live in this flash.

### Interrupt vector table (selected entries)

Vector table starts at image 0x8000, 256 × 4-byte BE vectors. Default handler (`0x34AD4`) fills most slots.

| Vec | Offset | Handler | Role |
|-----|--------|---------|------|
| 0 | 0x000 | `SP = 0x2000FDFF` | Initial supervisor stack |
| 1 | 0x004 | `0x7DD78` | Reset PC → boot stub |
| 2-4 | 0x008-0x010 | `0x34B90/B58/B20` | Bus / address / illegal-instruction exception |
| 24 | 0x060 | `0x34A54` | Spurious |
| 65 | 0x104 | `0x4EA50` | **EPORT IRQ2** — 6-instruction stub that clears EPFR bit 1 (pending-flag ack); handoff happens in polling code. Likely the daughter-board attention line (radio has a packet ready). |
| 72 | 0x120 | `0x34BC4` | ? (possibly SW int / format-error) |
| 77 | 0x134 | **`0x436F4`** | **UART0 (QS Link)** — tests UISR bits 0/1, calls TX/RX handlers, resets errors |
| 78 | 0x138 | `0x3FD30` | **UART1** — reads USR/URB, same handler pattern |
| 79 | 0x13C | `0x343D0` | **UART2** — reads USR/URB, separate TX/RX funcs |
| 108-111 | 0x1B0-0x1BC | `0x43764/35C94/340D8/34F4C` | **DTIM0-3** (periodic slot timers) |
| 117 | 0x1D4 | **`0x63D40`** | **USB OTG** — handles endpoint state at `0x401C0080/0088/0090/00C0`. This is what the Win32 updater talks to. |
| 119 | 0x1DC | `0x45F08` | ? |
| 120 | 0x1E0 | `0x34440` | Reads `0x40160000` (timer/LCD) |

### Main boot flow

```
0x7DD78  reset stub → FLASHBAR/RAMBAR/VBR init → SP = 0x2000FDFF → JMP 0x390B0
0x390B0  main() → LINK → tail-call sub_390B8
0x390B8  main body:
           *0x500 = 1                           // bootflag
           fill RAM 0x2000F600-FDCF with 0xAAAAAAAA  // stack canary
           sub_39078() / sub_3904C() / sub_38E3C() / sub_38EAC()  // hardware init
           loop forever:
             sub_34820()                        // watchdog kick
             *0x40000C08 = 0xFE5F0FFF           // refresh/timer
             *0xC0C = 0xFFFF1EFE                // (MOVEC)
             sub_46204()                        // scheduler / main tick
```

### QS Link handler (UART0)

The UART0 ISR at **`0x436F4`** implements a half-duplex QS Link endpoint with a HW-assisted software CRC-16.

**Frame sync** lives as a ROM constant at **`0x67B90`**:

```
67b90:  55 55 55 FF FA DE 00 00 | CA 0F 5E 11 94 1E BC 22 ...
        └── preamble + sync ────┘  └── CRC-16/CA0F table ─┘
```

- `55 55 55` — 3-byte preamble (alternating bits for clock recovery on RS-485)
- `FF FA DE` — start-of-frame / 0xFADE sync word
- `CA0F` table starts at **`0x67B96`** — 256 × 16-bit entries, polynomial **0xCA0F** (identical to ESN-QS / QSM / CCA [see qslink.md](../protocols/qslink.md))

**TX path** (`sub_686B4`, invoked on UART0 TXRDY):
- Per-connection state at `0x2000A380 + 0x4B * conn_id` (stride 0x4B, room for ≥3 concurrent links).
- Drives a frame state machine: reads next payload byte from `*0x2000A3BB` (buffer pointer) or fixed preamble/sync lookup from `&data_67B96[]`, updates running CRC-16 at `*0x20000ABC` via `(a0,d0.l*2) = &data_67B96[d0]`, writes to UART0 UTB at `$4000020C`, decrements counter `*0x2000A3C3`. On done, writes `0xF0` to UTB (idle flag byte) and sets `*0x20000ABA = 1`.
- End-of-packet: clears connection state, resets UART TX with `UCR = 0x30`.

**RX dispatch** (`sub_6815C`, invoked on UART0 RXRDY via trivial `sub_686A0`):
- Reads DTIM-captured timestamp from `*0x401A0004` (gap-timing gate).
- Accepts byte from URB, runs it through the same CRC-16/CA0F table, checks connection state (idle=0 / header=1 / body=2).
- At state 1 the accumulated header word is compared against `0xFADE` — confirming the sync check lives in the RX path too. At state 2, length/control bytes are parsed (`& 0xC0`, `== 0x80`, etc.) and the per-connection length field (`*0x2000A3C4`) is set to one of `0x05`, `0x18`, or `0x35` depending on packet class (3 distinct packet-size classes, matching the QS Link "small / medium / large" tiers).

### CCA / RF path

No CC1101 register init patterns, no 433.6 MHz frequency constants (0x10A868), and no CCA sync-byte 0xD391 found in this main image. The CRC-16/CA0F table has only 8 xrefs and all are inside the UART0 (QS Link) handler — no radio code anywhere near that CRC.

**Architectural conclusion**: Grafik Eye QS uses a **radio daughter board** with its own MCU (HCS08 + CC1101, matching [qsm.md](qsm.md)). The radio daughter board is NOT on QSPI (that's SPI flash) — it's on **UART1 or UART2**. Both unused UARTs have near-identical ISR structure to UART0's QS Link handler (USR/URB read, UISR/UIMR mask, UCR reset), suggesting both speak Lutron's internal CRC-16/CA0F framing over RS-232-level lines between the boards.

Supporting evidence:

- UI resource strings `Display Board`, `Power Board`, **`Daughter Board`** at virtual 0x1D99C/0x1D9AA/0x1D9B6 — explicit board-role enumeration, referenced by `sub_20BFA` (self-test / version-display UI)
- Grafik Eye is [the only device that both TX and RX on CCA](../reference/training-notes-index.md), so it clearly has a radio — but the RF stack lives on a separate module
- The "Power Board" holds the TRIAC/SCR drive and zone-crossing detection (likely on UART1)
- The "Daughter Board" is the radio module (likely on UART2 — highest UCR reset activity, consistent with tight timing requirements)
- Vector 65 (EPORT IRQ2) = `sub_4EA50` just acks the edge-port flag — this is the daughter board's "attention" line. The polling consumer reads from the UART2 RX FIFO.

### Where the CCA radio firmware lives

**Searched and NOT FOUND in the 9.029 OTA payload:**

- Designer 26.0.2.100 ships 5 frequency-specific directories under `Firmware/QuantumResi/qs_firmware_and_tools/GrafikEye/{434, 434 Limited, 865, 868, 868.2}/sysconfig32.dll`. All 5 files are **byte-identical** (MD5 `c43cc3e57557025399b9987928415d33`, description `10 GRX 09.029 (434|434L|865|868|868L)SQHR`). The freq selection is runtime auto-detect, not per-image.
- Decrypted payload region map for 9.029 contains **only** the main ColdFire region (0x00008000 – 0x00079720) and UI resource region (0x90000000 – 0x9005151F). No third region for a daughter-board MCU image.
- No embedded HCS08 S-records, no Intel-HEX blobs, no bundled `.s19` sub-payload anywhere in the plaintext.

**Most likely location**: flashed at **manufacture** onto the daughter-board HCS08 via its BDM header and never updated in the field. This matches the [training-notes-index.md](../reference/training-notes-index.md) statement that "Boot firmware is never updated in the field; OS firmware is flashed via the QSE-NWK/Flash tool." The Grafik Eye main firmware IS the "OS firmware." The daughter-board radio firmware is the "boot firmware" equivalent — factory-only.

**Open paths to recovery**:
1. Physical BDM/TDI probe on a real unit (HCS08 has a BDM header just like QSM).
2. Pull delta/OTA builds from Lutron's firmware CDN (see [security/firmware-cdn.md](../security/firmware-cdn.md)) — a job-specific or engineering release may ship the daughter-board firmware separately.
3. Seed the protocol from QSM firmware ([qsm.md](qsm.md)) — the radio daughter board runs analogous code: HCS08 + CC1101 + CCA/CA0F. The TDMA slot math, CC1101 register defaults, N81 codec, channel-hop table, and packet framing should all transfer.
4. Capture UART1/UART2 traffic from a live Grafik Eye (serial tap between Display and Daughter Boards) to reverse-engineer the host↔radio wire protocol. That gets you the command set without needing the daughter firmware at all.

### Persistent settings

Settings journal in SRAM at `0x20005BB3` and `0x20005EB5` (pointer table at `0x3E0A8`). The save function `sub_3E500` writes a tag/value pair into a 0x18-byte record slot with indirect banking — a journaled ring-buffer pattern. Dirty sectors are flushed to **external SPI flash** over QSPI (see "External SPI flash on QSPI" above) — the write path is `sub_3E500` → `sub_3E40C`/`sub_3E444` → QSPI command sequence `[0x06 WR_EN][0x20 ERASE_4K][0x02 PROGRAM]` with `0x05 RD_STATUS` polling between steps.

**Boot mode flag** at RAM `0x200008E9` controls the startup banner (`sub_23F60`):
- `0` → normal boot
- `1` → **`BOOTLOAD`** (shown on LCD — firmware updater mode)
- `2` with `*0x2000069C == 0x61` ('a') → **`SNIFFER`** (hidden diagnostic mode — packet-sniffer UI, probably a raw QS Link / CCA tap dump)

Setter is `sub_3F048(mode)`. It also mirrors the flag to `*0x200008EE` and triggers a `sub_3E500(0x17, ...)` persistence call — so the mode survives reboot (written to SPI flash). No UI path into SNIFFER is surfaced in the string table; it's a factory diagnostic gated behind the dual flag + 'a' byte. Not clear yet what sets `0x2000069C` to 0x61 — likely a button-hold-at-boot combination or a Designer/updater IPL command.

No explicit Athena-vs-standalone gating found in this firmware — "Athena" as a brand postdates the 2014 copyright date embedded at `0x30DFB`. The hidden-menu gating the FSE training notes describe most likely lives in the `Wireless Mode` / RadioRA 2 path (visible UI strings `Connected` / `Not connected` at 0x64C5/0x64CF). The newer 9.029 we pulled from Designer 26.0.2.100 has the same architecture (see "9.029 delta" section below) — Athena gating probably arrives in an even later build.

### Notable constants and tables

| Address | Size | Contents |
|---------|------|----------|
| `0x8400` | 8 B | Banner string `GRX 8-27\0` |
| `0x30DFB` | 64 B | `,Copyright 2014 Lutron Electronics Co., Inc. All rights reserved` |
| `0x3E0A8` | 8 B | Journal-bank pointer table (2 × RAM pointers) |
| `0x67B90` | 6 B | Preamble + sync: `55 55 55 FF FA DE` |
| `0x67B96` | 512 B | CRC-16 table, polynomial 0xCA0F |
| `0x79A5C` | ? | 8-byte sequence (used by `sub_35C94` as LED-animation / PWM phase table) |
| `0x1D9DA` | 9 B | String `BOOTLOAD\0` (mode banner) |
| `0x1D9E3` | 8 B | String `SNIFFER\0` (hidden mode banner) |
| `0x1D9F0` | 32 B | Language list: `ENGLISH`, `FRANÇAIS`, `ESPAÑOL`, `DEUTSCH`, `ITALIANO`, `PORTUGUÊS` |
| `0x1D7F6 – 0x1D97B` | ~400 B | SKU/MODEL table: QSWS2-*, QSWEBO-*, HQW*-*, QSE-*, QSG-*, QSNE-*, LQSE-*, QSPS-*, QSSC-EDU |
| `0x419C4` | 48 B | CodeWarrior build path `C:\Sandbox\EcoSystemBoard\bin\qsg_eco_operate.prm` (in UI region) |

### UI resource region (`grafik-eye-qs-8.027-90000000-9004efb7.bin`, 324 KB)

- 14,210 ASCII strings ≥ 4 chars; 5,866 unique
- Pure localized UI text: 6 languages (English, French, Spanish, German, Italian, Portuguese)
- No "service", "debug", "factory", "engineer", "backdoor", "admin", "test" strings — the hidden modes are in the *code* region, not the UI region
- Password-related UI: `Password`, `Set Password`, `Enter Password`, `Lockout`, `Imposta Password`, `Inserire Password` (the password itself is stored in settings, not in the resource blob)
- No mentions of `Athena`, `Quantum`, `Homeworks`, or any explicit standalone/networked mode label — the Athena gating notes from training don't map to this firmware version
- `RadioRA 2` appears 12× (once per language × menu context), `Connected` / `Not connected` / `Connect` localized pairs suggest the networked-vs-standalone check is done at the code level and the UI simply renders the status

### Function inventory (selected)

| Address | Name | Role |
|---------|------|------|
| `0x7DD78` | reset_stub | FLASHBAR/RAMBAR/VBR init, jumps to main |
| `0x390B0` | main | Entry after reset_stub |
| `0x390B8` | main_body | Hardware init + scheduler loop |
| `0x34820` | kick_watchdog | `CWSR = 0x55; CWSR = 0xAA` |
| `0x436F4` | uart0_isr | QS Link — vector 77 |
| `0x686B4` | qs_link_tx_handler | TX byte pump with CRC-16 update |
| `0x6815C` | qs_link_rx_dispatch | RX state machine, CRC validation, length class select |
| `0x686A0` | uart0_rx_shim | Trivial wrapper → `sub_6815C` |
| `0x3FD30` | uart1_isr | Vector 78 — inter-board link (Power/Display) |
| `0x343D0` | uart2_isr | Vector 79 — inter-board link (Daughter Board candidate) |
| `0x4EA50` | eport_irq2_isr | Vector 65 — daughter-board attention ack |
| `0x63D40` | usb_otg_isr | Vector 117 — firmware-update USB endpoint |
| `0x2ECA8` | spi_flash_read | QSPI read wrapper (opcode 0x03 + 16-bit addr → 1 byte) |
| `0x3E500` | settings_save | Journaled settings write → SPI flash (QSPI) |
| `0x3F048` | boot_mode_set | Writes `*0x200008E9` and persists via `sub_3E500(0x17,…)` |
| `0x23F60` | boot_banner_draw | Selects `BOOTLOAD` / `SNIFFER` / default on LCD |

### 9.029 delta (newer build from Designer 26.0.2.100)

Designer 26.0.2.100 ships a newer firmware at `QuantumResi/BinDirectory/Firmware/QuantumResi/qs_firmware_and_tools/GrafikEye/{434,434 Limited,865,868,868.2} MHz/sysconfig32.dll`. All 5 frequency directories contain the byte-identical file (MD5 `c43cc3e57557025399b9987928415d33`), described as `10 GRX 09.029 (434|434L|865|868|868L)SQHR`. Decrypts cleanly with the same cipher as 8.027 (format-version tag still `10`, same striped-header + S-Box layout).

Delta vs 8.027:

| Metric | 8.027 | 9.029 |
|--------|-------|-------|
| Code region | `0x8000 – 0x7E914` (485,652 B) | `0x8000 – 0x79720` (464,672 B, -20,980 B) |
| UI region | `0x90000000 – 0x9004EFB8` (323,512 B) | `0x90000000 – 0x9005151F` (333,087 B, +9,575 B) |
| Reset PC | `0x7DD78` | `0x78D14` |
| Default ISR | `0x34AD4` | `0x32178` |
| V77 UART0 ISR | `0x436F4` | `0x40C00` |
| V78 UART1 ISR | `0x3FD30` | `0x3D128` |
| V79 UART2 ISR | `0x343D0` | `0x31AC8` |
| V117 USB OTG | `0x63D40` | `0x606A8` |

Vector table layout is identical (same populated entries, same purposes); only the target addresses shifted as code was recompiled. Memory map, peripheral mix, SPI-flash command protocol, and QS Link framing are unchanged.

### 6-050 older build

Designer also ships `QuantumResi/qs_firmware_and_tools/GrafikEye/Grafik Eye QS Firmware Updater 6-050.exe` (1,630,208 B, standalone PE32 with firmware embedded in `.data` section from file offset 0x46000, 1,019,904 bytes of encrypted payload). **Uses a different (older) encryption format** — our current decryptor reports a 2-character description tag and out-of-range table indices on the primed bytes. The `10` format version marker that 8.027/9.029 use isn't present. Extracting this requires a separate decryptor matching the 6-050 wrapper.

## Next steps

1. **Capture UART1/UART2 traffic between Main Board and Daughter Board** on a live Grafik Eye — reveals the host↔radio RPC protocol without needing to dump the daughter firmware. A logic analyzer on the inter-board connector is enough.
2. **Physical BDM probe of the daughter-board HCS08** — standard Lutron pattern (matches QSM). Would yield the factory radio firmware directly.
3. **Reverse the 6-050 encryption wrapper** — older format may reveal whether the inter-board protocol / SPI-flash layout has changed over time, and whether an older build included a daughter-board sub-payload that 8.027/9.029 dropped.
4. **Reach SNIFFER mode** — identify what writes `0x61` to `*0x2000069C`. Likely a button-hold-at-boot combo or an IPL command from the USB updater. Unlocking this gives a packet-sniffer UI on the Grafik Eye LCD itself.
5. **Enumerate the firmware CDN** for `QSGR`, `grafikeye`, `qsg*` paths to find delta/OTA builds — see [security/firmware-cdn.md](../security/firmware-cdn.md). Job-specific or engineering releases may ship the daughter-board firmware separately.
6. **Check other Designer-bundled firmware** — every `qs_firmware_and_tools/*/v*.s19` is already plaintext. Only Grafik Eye was wrapped in a custom loader; the rest should be direct-dumpable. Candidates for radio-code reference (HCS08 + CC1101): `qs_firmware_and_tools/qs keypad/QSW_7-001_*.s19`, `Hotel_Pico_7_002.s19`, `QSE_CI_WCI_7_005.s19`, `QSE-IR-WH/QS IR Eye Rev0x11OC.s19`.

## Target MCU

Grafik Eye QS main-board MCU: **Freescale ColdFire V2** (512 KB flash / "new hardware" branch). The HCS08 / Kinetis guess in older notes was wrong — the vector layout, MBAR/RAMBAR register access, Core-Watchdog at MBAR+0x13, and CodeWarrior build path all point to an MCF5225x / MCF5227x-class part. USB is a native on-chip OTG controller (vector 117, regs at 0x401C0000), so the earlier CP210x-bridge hypothesis is wrong too — the PC updater talks directly to the ColdFire's USB OTG endpoint and the "sysconfig" zip name is Lutron-internal, not Silicon Labs.

The daughter board (responsible for CCA RF) still appears to be an HCS08 + CC1101 combo matching [qsm.md](qsm.md). That firmware isn't included in the 8-027 updater payload — it's either bundled in a separate OTA package or flashed once at manufacture.
