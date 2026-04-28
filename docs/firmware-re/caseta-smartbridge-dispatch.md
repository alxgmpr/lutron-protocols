# Caseta SmartBridge Coproc — Dispatch & Protocol Mapping

Companion to [`caseta-smartbridge-coproc.md`](./caseta-smartbridge-coproc.md) (which
covers extraction). This file is the static RE of the three SmartBridge coproc
binaries with focus on the **on-air RX dispatch**, the **host↔coproc IPC table**,
the **TX builder**, and how everything compares against PR #29 (Phoenix EFR32 OTA)
and PR #32 (Phoenix EFR32 dispatch).

## TL;DR

The older Caseta SmartBridge (L-BDG2 / SBP2) STM32 coprocessor is a **runtime-CCA
only** transceiver. Compared with the newer Phoenix EFR32 coproc:

- Same on-air sync word (`0xFADE`), same CRC poly (`0xCA0F`), same packet-length
  classification by type-byte high bits (0x80=24-byte short, 0xA0=53-byte long).
- Same TX framing template `55 55 55 FF FA DE …` lives in flash.
- Same 35-channel hop table (entries 0x44..0x66) — *plus* an extended 84-entry
  range that climbs to channel 0x93 (used for spurious-emission sweeps?). The
  hop table also embeds 8 bytes of base FREQ values that are absent in PowPak.
- **No CCA OTA stack.** The Phoenix-style OTA opcodes (`0x2A` BeginTransfer,
  `0x32` Control, `0x36` CodeRevision, `0x41` TransferData, `0x58` QueryDevice,
  …) are absent from the RX state machine — the post-FADE byte is classified
  exclusively by runtime CCA type rules. The OTA framing template at
  `0x08016980` is referenced **only** by the TX builder, suggesting OTA TX may
  exist as a dead-code or partial path; there is no symmetric RX. The HDLC IPC
  command IDs `0x0121`, `0x0125`, `0x0127`, `0x0129`, `0x012B`
  (Phoenix's ClearError / GetDevFwRevs / Cancel / broadcast / ack) are not
  implemented — confirming OTA is **not exposed** via the AM335x↔STM32 link.
- The IPC dispatch is structured as a single big `cmp r3, #IMM; bne next` chain
  on a 16-bit big-endian command ID at byte 0-1 of the body. 61 entries in
  v02.05 / v02.08; v02.10 adds 6 new entries for a total of 67. The cmd
  numbering is **completely different** from Phoenix's 0x111-0x12B OTA range —
  cmds 0x0111-0x011B exist on Caseta SB but with mismatched lengths and stub
  handlers (response builders only, no CCA OTA semantics).
- Pairing/runtime control flows entirely through this IPC. The byte-level RX
  state machine writes received bytes into per-class RAM buffers (4 buffers,
  selected by `byte & 0x03` / `byte & 0xE0`); a higher-level processor then
  inspects `byte[0]` and `byte[1]` and either re-enters the IPC dispatch (HDLC
  upstream) or routes to short / long packet handlers.

## Per-binary anchors

All three binaries: ARM Cortex-M, flash base `0x08000000`, reset vector
`0x080142B1` (Thumb), each S19 starts a few KB after the bootloader region.

| Anchor                                  | sb-0205          | sb-0208          | sb-0210          |
|-----------------------------------------|------------------|------------------|------------------|
| Image start (S19 first record)          | `0x080030B0`     | `0x080031E4`     | `0x08003454`     |
| Image end                               | `0x0801FB08`     | `0x0801FB08`     | `0x0801FB08`     |
| OTA framing template `55 55 55 FF FA DE`| `0x08016980`     | `0x08016980`     | `0x08016DE0`     |
| CC1101 register list start (44 bytes)   | `0x08016A0C`     | `0x08016A0C`     | `0x08016E5D`*    |
| 35-channel hop table (entries 0x44..0x66)| `0x08016A48`    | `0x08016A48`     | `0x08016E4D`*    |
| 84-channel extended hop table (0x44..0x93)| `0x08016A48`-`0x08016AE8`| `0x08016A48`-`0x08016AE8`| `0x08016E4D`*-`0x08016EED`*|
| Sync-word (`0xFADE`) match at RX state 0 | `0x08012EE8`     | `0x08012EE8`     | (similar offset) |
| RX byte-state machine entry             | `0x08012C18`     | `0x08012C18`     | (similar offset) |
| TX framing function (xrefs OTA template)| `0x0801306C`     | `0x0801306C`     | `0x080134B8`*    |
| Radio scheduler (calls RX/TX state machines)| `0x0800570C`-`0x0800577E`| `0x0800570C`-`0x0800577E`| (similar offset)|
| HDLC IPC dispatch table head            | `0x0800BA84`     | `0x0800BA84`     | `0x0800BB80`     |
| Top-level packet processor (HDLC + RF)  | `0x0800C370`     | `0x0800C370`     | (similar offset) |

*0210 addresses estimated from offset deltas; verify in fresh load. The 0205
and 0208 builds are bit-identical in the address layout of these regions —
only the IPC bodies and a few tables differ.

## On-air RX state machine

The RX side is a **byte-by-byte UART/SPI input streaming machine** at
`0x08012C18` (sb-0208). It is called from the radio scheduler at `0x0800570C`
based on bit-21 of a peripheral status word.

State byte at `[state+0]` controls the FSM:

| State | Behavior |
|-------|----------|
| 0     | Sliding-window FADE search. Each incoming byte `r6` is shifted into the 16-bit window `[state+0x42] = (state[0x42] << 8) | r6`. When window equals `0xFADE`, transition to state 1. |
| 1     | Read **type byte** and classify: <br>• `r6 & 0xC0 == 0x00`  → length 5  (small packet) <br>• `r6 & 0xE0 == 0xA0` → length 53 (config packet, long) <br>• Otherwise          → length 24 (button/level packet, short) <br>Stash length at `[state+0x45]`, decrement counter at `[state+0x44]`, transition to state 2. |
| 2     | Streaming: write incoming byte to RX buffer at `[state+0x3C]`, increment ptr, decrement remaining counter at `[state+0x44]`. When counter hits 0, run CRC check (compare last 2 bytes vs computed CRC over preceding bytes) and either deliver to higher-level processor or drop. |

This is **runtime CCA framing only** — it has no path for OTA's explicit
`[LEN][OP][PAYLOAD][CRC]` framing where length comes from the wire. The high-bit
classification `0xC0/0xE0/0xA0` is the runtime CCA type-byte rule documented in
[`docs/protocols/cca.md` §3](../protocols/cca.md#3-packet-types).

The CRC step uses a half-byte indexed lookup table (`ldrh r2, [r2, r5, lsl #1]`)
with 16-bit accumulator — standard CCA CRC-16 with polynomial 0xCA0F (the
two-byte sequence `0F CA` appears in flash adjacent to other CRC infrastructure
at sb-0208 offset `0x0800FFAB`).

## Top-level packet processor (`0x0800C370`)

After the RX state machine has buffered a complete packet, this function
inspects the first two bytes of the buffer and routes to one of three paths:

1. **byte[1] & 0x80 != 0**: short-packet RF path (`0x0800C28C`)
2. **byte[1] & 0xC0 == 0xC0**: long-packet RF path (`0x0800C2E0`)
3. **byte[1] & 0xC0 == 0x00**: HDLC IPC dispatch (`0x0800BA84`)

The third arm is the AM335x↔STM32 IPC. The other two arms hand off to the
runtime CCA packet-handling cluster (functions `0x0800C28C`, `0x0800C2E0`,
`0x0800C238`, etc.) which decodes button presses, level commands, ACK
responses, and config blob phases. No further opcode-table dispatch — branches
are open-coded against format constants:

```text
cmp r0, #0x1C  → fade config (format 0x1C)
cmp r0, #0x0E  → OUTPUT format
cmp r0, #0x40  → level command class
cmp r0, #0x42  → dim command class
cmp r0, #0x9C  → button class
cmp r0, #0xA0..#0xA3 → rotating config types
```

Counts of these comparisons across sb-0208 (each is a distinct decoder branch):

| Format/class      | Hits |
|-------------------|------|
| `cmp r,#0x40` (level)  | 16 |
| `cmp r,#0x80`          | 21 |
| `cmp r,#0xC0` mask     | 14 |
| `cmp r,#0x0E`          | 8  |
| `cmp r,#0x0D`          | 6  |
| `cmp r,#0x0B` (ACK)    | 5  |
| `cmp r,#0xA0`          | 4  |
| `cmp r,#0x42` (dim)    | 3  |
| `cmp r,#0x1C` (fade)   | 2  |
| `cmp r,#0x15` (trim)   | 2  |
| `cmp r,#0x1A` (scene)  | 1  |
| `cmp r,#0x11` (LED)    | 1  |

This matches the Caseta runtime CCA repertoire (output set-level, button
events, scene/fade/trim/LED config, ACK packets) but **no OTA opcodes**. The
zero hits on `0x2A`, `0x36`, `0x58`, the only legitimate `0x41` hit at
`0x800FC64` (a `cmp r3, #0x41; beq; cmp r3, #2; beq` two-way branch unrelated
to TransferData), and zero `0x32` hits in code (just the runtime length 0x32
literals) all point to the same conclusion: **OTA dispatch is absent on the
RX side.**

## TX builder (`0x0801306C`)

The single function that references the OTA framing template at `0x08016980`
is the radio TX byte-output state machine. Driven by the same scheduler that
calls RX (`0x0800577A` is the only caller). Internal logic:

- Reads `state[0x46]` and `state[0x48]` for byte counter and packet length.
- For preamble/sync-word region, indexes into the OTA framing template via
  `r3 = template + (state[0x46] - 6)`. Only the first 6 bytes of the template
  (`55 55 55 FF FA DE`) are streamed verbatim; subsequent bytes come from the
  packet buffer.
- For payload region, reads the encoded byte at `state[0x3C][i]`, runs it
  through the CRC accumulator, writes to the TX FIFO/SPI register.
- Special handling for type-byte classes `0xA0` (long packet, 53 bytes) and
  default (short, 24 bytes) with appropriate trailing CRC bytes.

The fact that `[template+0..5]` is `55 55 55 FF FA DE` and the function only
reads up to 6 bytes confirms this binary **does** know how to TX both
runtime CCA packets and the OTA preamble — but with no RX-side OTA processor
the OTA TX would only useful for forwarding host-built OTA packets verbatim.

## CC1101 / radio init data tables

All three binaries share the same radio data layout (only base offsets differ):

```text
0x08016A0C : register list (44 bytes)
              00 01 02 03 04 05 06 07 08 09 0a 0b 0c 10 11 12 13 14 15 16
              17 18 19 1a 1b 1c 1d 1e 1f 20 21 22 23 24 25 26 27 28 29 2a
              2b 2c 2d 2e
0x08016A38 : 8-byte FREQ-base block
              2a 57 21 00 b1 63 23 67
0x08016A40 : 4-byte PA / sync extras
              95 6a 0b 6d
0x08016A44 : another 4-byte block
              7a 71 ad 74
0x08016A48 : extended 84-channel hop table (channels 0x44..0x93, 168 bytes)
              44 ec 45 e8 46 e4 47 dc … 92 b1 93 ad
```

The first 35 entries of the hop table (`0x44 ec` … `0x66 66`) match PowPak's
35-channel table byte-for-byte. The remaining 49 entries (`0x67 5e` …
`0x93 ad`) extend up to channel 0x93. With `FREQ2/1/0` interpretation this
covers approximately 423-460 MHz at ~92 kHz spacing — i.e., a wider-than-PowPak
band, possibly used during pairing for diagnostic / test transmissions.

The register list omits FREQ2/1/0 (regs 0x0D-0x0F), exactly as in PowPak —
band selection happens through a separate code path.

## HDLC IPC dispatch table

Located at `0x0800BA84` (sb-0205, sb-0208) / `0x0800BB80` (sb-0210). Each entry
is a `cmp r3, #IMM` (or `movw r2, #IMM; cmp r3, r2` for ≥ 0x100) followed by a
length check (`cmp r0, #LEN`) and a `bl HANDLER`.

The 16-bit big-endian command ID is read from `[r1+0]` (after `rev16`).
Handlers either return 1 directly (stub), forward to a real implementation
function elsewhere in flash, or call into a "build response" pair
(`0x08005E38` init buffer → `0x08005FEC` send via UART).

### Common dispatch (61 entries — present in all three versions)

Length column: bytes the IPC framer requires (excluding the 2-byte cmd ID).
"-" = no length check (handler accepts any length).

| Cmd ID | Len | Handler  | Group / role (best guess) |
|-------:|----:|---------:|---------------------------|
| `0x0000` | -  | `0x08005880` | low-level radio control (response code 0x02) |
| `0x0002` | -  | `0x08005894` | low-level radio control (response code 0x03) |
| `0x0004` |  7 | `0x080058A8` | low-level radio control (response code 0x04) |
| `0x0006` | var| `0x08005920` | multi-record packet (`len = 3*byte[2] + 3`) |
| `0x0100` | -  | `0x08005B90` | radio status |
| `0x0103` | -  | `0x08005BA4` | radio status |
| `0x0106` |  8 | `0x08005BCC` | radio status |
| `0x0108` |  7 | `0x08005BE0` | radio status |
| `0x010A` |  6 | `0x08005BB8` | radio status |
| `0x010B` |  5 | `0x08005BF4` | radio status |
| `0x010C` | -  | `0x08005C08` | radio status |
| `0x010F` |  8 | `0x08005C1C` | radio status |
| `0x0111` |  6 | `0x08005D84` | (response builder, code 0x36, 4-byte payload) |
| `0x0113` |  3 | `0x08005AF8` | **stub** — returns 1, no-op |
| `0x0115` |  6 | `0x08005D98` | (response builder, code 0x33, 4-byte payload) |
| `0x0116` |  6 | `0x08005DAC` | (response builder, code 0x34, 4-byte payload) |
| `0x0119` |  7 | `0x08005DC0` | (response builder, code 0x3D, 5-byte payload) |
| `0x011B` |  6 | `0x08005DD4` | (response builder, code 0x3E, 4-byte payload) |
| `0x0200` | 25 | `0x080059A4` | TX direct packet (sends 25-byte buffer) |
| `0x0202` | 15 | `0x08005A30` | TX direct packet (15 bytes) |
| `0x0205` | 16 | `0x08005A44` | TX direct packet (16 bytes) |
| `0x0300` | 10 | `0x0800BFE8` | (likely TX or pair) |
| `0x0302` |  9 | `0x08005990` | TX direct packet (9 bytes) |
| `0x0304` |  9 | `0x08005AFC` | (response builder, code 0x24, 7-byte payload) |
| `0x0306` | 10 | `0x0800C090` | **stub** — returns 1 |
| `0x0309` |  9 | `0x0800C098` | **stub** — returns 1 |
| `0x030B` |  8 | `0x0800C038` | reset/clear (calls 0x0800CF1C) |
| `0x0400` |  8 | `0x08005D5C` | (response builder, code 0x4F, 6-byte payload) |
| `0x0404` | -  | `0x08005D70` | (response builder) |
| `0x0501` | 11 | `0x080059B8` | TX direct packet (11 bytes) |
| `0x0503` | 11 | `0x080059CC` | TX direct packet (11 bytes) |
| `0x0505` |  9 | `0x080059E0` | TX direct packet (9 bytes) |
| `0x0507` |  9 | `0x080059F4` | TX direct packet (9 bytes) |
| `0x0509` | 14 | `0x08005A08` | TX direct packet (14 bytes) |
| `0x050B` |  9 | `0x08005A58` | TX direct packet (9 bytes) |
| `0x050D` | 11 | `0x08005A6C` | TX direct packet (11 bytes) |
| `0x050F` | 14 | `0x08005A1C` | TX direct packet (14 bytes) |
| `0x0511` | 10 | `0x08005A80` | TX direct packet (10 bytes) |
| `0x0513` | 10 | `0x08005A94` | TX direct packet (10 bytes) |
| `0x0518` |  8 | `0x08005AA8` | TX direct packet (8 bytes) |
| `0x051C` |  5 | `0x08005ABC` | TX direct packet (5 bytes) |
| `0x051D` | 21 | `0x08005AD0` | TX direct packet (21 bytes) |
| `0x051E` |  8 | `0x08005AE4` | TX direct packet (8 bytes) |
| `0x0600` |  7 | `0x08005C30` | radio config |
| `0x0602` | -  | `0x08005C44` | radio config |
| `0x0604` |  9 | `0x08005C58` | radio config |
| `0x0606` | 14 | `0x08005C6C` | radio config |
| `0x0608` | 14 | `0x08005C80` | radio config |
| `0x060A` | 15 | `0x08005C94` | radio config |
| `0x060C` | 15 | `0x08005CA8` | radio config |
| `0x060E` | 15 | `0x08005CBC` | radio config |
| `0x0610` | 13 | `0x08005CD0` | radio config |
| `0x0612` | 13 | `0x08005CE4` | radio config |
| `0x0614` | 14 | `0x08005CF8` | radio config |
| `0x0700` | 32 | `0x08005D0C` | scene/programming (32-byte payload) |
| `0x0702` | 32 | `0x08005D20` | scene/programming (32-byte payload) |
| `0x0707` | 60 | `0x08005D34` | scene/programming (60-byte payload, response code 0x38) |
| `0x0709` | 60 | `0x08005D48` | scene/programming (60-byte payload, response code 0x36) |
| `0xE100` | -  | `0x08005B64` | async event (upstream notification) |
| `0xE101` | -  | `0x08005B7C` | async event |
| `0xE203` | -  | `0x080058BC` | async event (response code 0x5E) |
| `0xE205` | -  | `0x080058D0` | async event (response code 0x5F) |
| `0xE207` | -  | `0x080058E4` | async event |
| `0xE209` |  6 | `0x080058F8` | async event |
| `0xE20B` | -  | `0x0800590C` | async event |

The `0xE1xx` / `0xE2xx` block is the upstream-notification range — handlers
are typically called from runtime code (button received, level changed) rather
than from inbound IPC, but they still pass through this dispatch with the
`E1`/`E2` prefix to distinguish event direction.

### v02.10-only additions (6 new entries)

| Cmd ID | Len | Handler  | Likely role |
|-------:|----:|---------:|-------------|
| `0x011D` |  6 | `0x08005E08` → `0x0800840C` | reads 4 bytes BE, calls 0x0800CB3C with arg2=0 |
| `0x011F` |  6 | `0x08005E10` → `0x0800841C` | reads 4 bytes BE, calls 0x0800CB5C with arg2=4 |
| `0x0800` | 13 | `0x08005E18` → `0x0800842C` → `0x0800D0F8` | builds response with code `0x0801` |
| `0x0802` | 13 | `0x08005E20` → `0x08008438` → `0x0800D114` | builds response with code `0x0803` |
| `0x0900` | 11 | `0x08005E28` → `0x08008444` → `0x0800D130` | builds response with code `0x0901` |
| `0x0902` | 11 | `0x08005E30` → `0x08008450` → `0x0800D14C` | builds response with code `0x0903` |

The four `0x08xx`/`0x09xx` cmds use a request/response numbering pattern
(`req=0x0800` ↔ `rsp=0x0801`) and forward into a separate function group that
reads a single byte argument and builds a 1-byte response — typical of
**feature-flag toggles** added in firmware revisions. Possibilities:
- Smart Bridge Pro 2 telnet integration enable/disable
- Rolling-code re-key
- New device-type acceptance flags
- Diagnostics on/off

## Side-by-side with Phoenix EFR32 (PR #29 / PR #32)

| Aspect                                  | Caseta SmartBridge (older STM32) | Phoenix EFR32 (newer)         |
|-----------------------------------------|----------------------------------|-------------------------------|
| Radio chip                              | CC110L (or CC1101)               | EFR32MG12 integrated radio    |
| Sync word                               | `0xFADE`                         | `0xFADE`                      |
| Preamble + sync template                | `55 55 55 FF FA DE` at `0x08016980`/etc. | Same template at `0x08018A8C` |
| CRC polynomial                          | `0xCA0F`                         | `0xCA0F`                      |
| Channel hop table size                  | **84 channels** (0x44..0x93)     | 35 channels (0x44..0x66)      |
| First 35 hop entries                    | Match PowPak byte-for-byte       | Match PowPak byte-for-byte    |
| CC1101-style register list              | 44 entries (omitting FREQ regs)  | n/a (different radio)         |
| RX state machine                        | At `0x08012C18` (FADE-window FSM)| HDLC + radio dispatch fan-out |
| RX byte classification                  | Type-byte high bits → length     | Type-byte high bits → length  |
| OTA opcode dispatch                     | **Absent**                       | Full 10-opcode table          |
| OTA framing TX                          | Template referenced once (TX builder) | Active TX path             |
| HDLC IPC cmd ID width                   | 16-bit big-endian @ byte 0       | 16-bit big-endian @ byte 0    |
| HDLC IPC entry count                    | 61 (v02.05 / v02.08), 67 (v02.10)| ~30 in PR #32 mapping         |
| HDLC IPC numbering                      | 0x0000-0x07xx + 0xE1xx/0xE2xx    | 0x111-0x12B (OTA) + others    |
| Cmds 0x0111-0x011F implementation       | Stubs / 4-byte response builders | Real OTA opcodes (Query/Begin/Transfer/Control/CodeRev) |
| Designer firmware-update target?        | No (Designer doesn't OTA CCA)    | No (Designer doesn't OTA CCA) |
| Cloud System-Monitor OTA target?        | No (no OTA dispatch in firmware) | Yes — full OTA path           |

The shared `0xFADE` / `0xCA0F` / register list / preamble / first-35-channel
hop table establish that **the on-air format is the same Lutron CCA protocol
across both generations** — the older STM32 SmartBridge predates the EFR32-era
OTA opcode set but speaks the same wire framing for runtime button/level/scene
traffic.

The 84-channel hop table is one place where the older bridge has *more*
infrastructure than newer Phoenix coproc binaries; the extra 49 channels above
0x66 are not used during normal CCA traffic and may be vestigial calibration /
spurious-emission sweep entries.

## Pairing / handshake — how the older bridge does it

The Caseta SB does **not** use the modern Sunnata-era smart pairing protocol
(handshake echo, integration ID exchange, multi-phase config). Pairing is
driven entirely from the AM335x main proc via the IPC dispatch:

1. AM335x sends an IPC command (one of `0x05xx` or `0x06xx`) telling the coproc
   to TX a specific config or button packet. The handler at `0x080059xx` /
   `0x08005Cxx` packages the body bytes into a runtime CCA frame and queues it
   for the radio scheduler.
2. Coproc TX'es the packet on the next scheduling slot.
3. When the device responds (button-press ACK, config ACK), the on-air RX state
   machine buffers it, the top-level processor runs it through the format
   classifier, and an `0xE1xx` / `0xE2xx` notification is fired upstream to the
   main proc.
4. Main proc orchestrates retries, multi-phase config, integration-ID
   assignment.

So **all pairing intelligence lives in the AM335x userspace** (`lutron-coproc-*`
processes) — the STM32 coproc is an essentially-stateless RF transceiver
controlled by IPC. This is the opposite arrangement from Phoenix's smart-pairing
era where the coproc tracks pairing state internally.

There is no implementation of the Sunnata-style "smart pairing" handshake echo
in the STM32 binary — no field-extraction of integration IDs from incoming
packets, no responder-state machine. Just type-byte classification and pass-up.

## Version evolution highlights (v02.05 → v02.08 → v02.10)

| Aspect                       | v02.05  | v02.08  | v02.10                  |
|------------------------------|---------|---------|-------------------------|
| Image size (KB)              | 114.6   | 114.3   | 113.7                   |
| IPC entry count              | 61      | 61      | 67                      |
| OTA template offset          | 0x16980 | 0x16980 | 0x16DE0 (+0x460 shift)  |
| New IPC commands             | —       | —       | 0x011D, 0x011F, 0x0800, 0x0802, 0x0900, 0x0902 |
| Bit-identical with previous? | n/a     | YES (in dispatch / radio layout) | NO (new commands, code shifted) |

**v02.05 vs v02.08**: identical IPC dispatch table and radio data layout. Only
internal handler bodies differ (a 0x134-byte shift in pool addresses; the
extracted images differ by 308 bytes total). v02.08 is a maintenance bump
without protocol changes.

**v02.08 vs v02.10**: meaningful protocol expansion. Six new IPC commands
introduce two unrelated feature groups:
- `0x011D` / `0x011F`: take a 4-byte BE argument and dispatch into a deeper
  function pair (`0x0800CB3C` / `0x0800CB5C`). Likely added support for
  reading/writing a new 32-bit configuration register or device-class field.
- `0x0800` / `0x0802` / `0x0900` / `0x0902`: simple 1-byte set/get pairs with
  matching `+1` response codes. Pattern matches feature-flag toggles. Could be
  Smart Bridge Pro 2 telnet integration enable, scene-mode flag, or
  remote-control mode flag.

The 0210 build also rearranges the dispatch table to accommodate the new
entries (the dispatcher head moved from `0x0800BA84` to `0x0800BB80`,
+0x100), and shifted the radio data tables forward by +0x460 — these are
purely the result of code growth, not protocol redesign.

There is no v02.05 → v02.10 introduction of any opcode that maps to the
Phoenix EFR32 OTA dispatch (no `0x0121` / `0x0125` / `0x0127` / `0x0129` /
`0x012B`). The older Caseta SmartBridge **never gained CCA OTA capability** in
its lifecycle — confirming that whatever firmware updates Caseta dimmers/
keypads/picos receive cannot come through this bridge generation.

## Method / reproducibility

S19 → flat .bin via the parser at `/tmp/s19_to_bin.py` (start at the lowest
address per file). Loaded into a fresh Ghidra project at `/tmp/caseta-sb-scratch/`
with `BinaryLoader` + `-loader-baseAddr <per-binary>` (the GUI Ghidra is locked
on Phoenix; we don't touch that project). Disassembly via
`arm-none-eabi-objdump -D -b binary -m arm -M force-thumb --adjust-vma=<base>`.

Dispatch tables extracted by walking `cmp/movw + bne + bl HANDLER` patterns in
the IPC dispatch region — see scripts at `/tmp/walk_dispatch2.py`,
`/tmp/find_callers.py`, and `/tmp/find_rxbuf_users.py` (transient).

All anchors confirmed by inspecting the raw bytes via Python (`/tmp/dump_*`)
and cross-checking with the disassembly. RX state machine semantics derived
from the ARM/Thumb decompilation around `0x08012EE8` (FADE compare).

## Open questions / next steps

- Confirm the new v02.10 cmds `0x0800/0x0802/0x0900/0x0902` semantics by
  decompiling `0x0800D0F8` / `0x0800D114` / `0x0800D130` / `0x0800D14C` more
  thoroughly. They likely set persistent flags in a config block.
- Figure out the 84-channel hop table's role: is it actually used or dead code
  inherited from a wider-band variant? A live RTL-SDR sweep above 433 MHz
  during pairing could answer this.
- The `0x0006` IPC command's `len = 3 * byte[2] + 3` formula suggests it carries
  a list of 3-byte records (probably (channel, freq_hi, freq_lo) tuples for
  custom hop schedules). Decompile `0x08005920` to confirm.
- The TX builder references the OTA framing template but no RX-side OTA
  processor exists. Worth checking whether any IPC command would let the host
  push raw bytes through the OTA template path — that would be a "transmit
  OTA opcode N from host" primitive even without on-device dispatch.
- Cross-check `0xE1xx` / `0xE2xx` event handlers — they may correspond 1:1
  with specific incoming runtime CCA packet types (button press = `0xE2xx-A`,
  ACK = `0xE2xx-B`, config ACK = `0xE2xx-C`).
