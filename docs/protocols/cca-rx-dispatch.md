# CCA RX Dispatch — Phoenix EFR32 Coproc

Reverse-engineered from the bridge-side EFR32MG12 radio coprocessor binaries shipped in
Phoenix (Caseta SmartBridge family) firmware. Companion to [cca.md](cca.md) §10 (TX
dispatch from PR #32). **All findings are static-analysis only — no live RF capture
was used to validate field-layout hypotheses.** Confidence calls are noted per
section.

## 1. Source binaries

Two EFR32 builds carry CCA receive code in this firmware family:

| Binary | Base | Size | Role |
|--------|------|------|------|
| `phoenix_efr32_8003000-801FB08.bin` | `0x08003000` | 115 KB | Older / smaller image — has precomputed CRC table at `0x0801E8CC` |
| `phoenix_efr32_8004000-803A008.bin` | `0x08004000` | 216 KB | Larger image — no precomputed CRC table; computes lazily |

Both use the same `0xCA0F` CRC polynomial and the same RX state-machine architecture
described below. **Function-for-function, the RX path is essentially the same** — the
larger image is just a recompile with more peripheral handlers attached. All addresses
in the rest of this doc are 801FB08 unless stated.

## 2. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CC110L (analog FSK transceiver, no firmware)                            │
│  GDOx → MG12 GPIO/USART pin                                              │
└──────────────────────────────────────────────────────────────────────────┘
                                   ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  IRQ slot 53  (FUN_080032FC)                                             │
│  ↓ feeds bytes one at a time into                                        │
│                                                                          │
│  FUN_0800F2AC  — RX byte-by-byte state machine                           │
│    state 0: wait for second sync byte (test for 0xFADE)                  │
│    state 1: type byte → choose buffer pool + length code                 │
│    state 2: accumulate body, run CRC, verify against trailing 2 bytes    │
│    on CRC pass → FUN_0800C7E0 (queue dispatch)                           │
│                                                                          │
│  FUN_0800EF98 — buffer-pool allocator (4 pools, keyed by type & 0xC0)    │
└──────────────────────────────────────────────────────────────────────────┘
                                   ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  TDMA scheduler                                                          │
│  FUN_0800E36C — per-tick handler; when state == 1, calls classifier      │
└──────────────────────────────────────────────────────────────────────────┘
                                   ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  FUN_0800CC74  — RX classifier & dispatcher       (THE RX ENTRY POINT)   │
│    switch(*pkt & 0xC0) {                                                 │
│      case 0x00:  OTA-class (type < 0x40)                                 │
│      case 0x40:  Pico/sensor short-form (type 0x40-0x7F) — unmapped      │
│      case 0x80:  Runtime CCA: STATE/BUTTON/BEACON/CONFIG/PAIR            │
│      case 0xC0:  Handshake (C0-E0)                                       │
│    }                                                                     │
│    delivers to FUN_0800C230 (sequence dedupe), then enqueues event via   │
│    FUN_0800EEC0 → HDLC IPC → AM335x lutron-core                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The bridge RX dispatch is **NOT a switch on each individual type byte** like the TX
side — it's a 2-bit-mask classifier. Within each arm, secondary discrimination uses
either bit 3 of the type byte (short-vs-long-format) or the format byte at offset 7.

## 3. Anchor table

| Anchor | 801FB08 | 803A008 | Purpose |
|--------|---------|---------|---------|
| RX byte state machine | `FUN_0800F2AC` | (paired image) | Byte-by-byte sync/length/CRC decoder |
| RX classifier (entry point) | **`FUN_0800CC74`** | **`FUN_0800EE08`** | Dispatch by `(type & 0xC0)` |
| TDMA tick / RX consumer | `FUN_0800E36C` | (paired image) | Calls classifier when packet ready |
| Buffer pool allocator | `FUN_0800EF98` | (paired image) | 4 pools by category |
| Dispatch-queue handoff | `FUN_0800C7E0` | (paired image) | Schedules dispatch after CRC pass |
| Sequence dedupe | `FUN_0800C230` | (paired image) | Cycle-counter-based dedup |
| Device-serial lookup | `FUN_080084C0` | `FUN_0800A608` | Serial → device-table index |
| Event enqueue (IPC out) | `FUN_0800EE28` | (paired image) | 10-slot ring buffer |
| HDLC TX wakeup | `FUN_0800A8BC` | (paired image) | Mark task #3 ready |
| CRC-16 lookup table | `0x0801E8CC` | (computed on demand) | 256 × `uint16_t`, poly `0xCA0F` |
| Sync constant `0xFADE` | `FUN_0800F2AC` @ `0x0800F2F8` | — | `cmp.w r3, #-0x522` |

## 4. Byte state machine — `FUN_0800F2AC`

Driven from IRQ slot 53 (`FUN_080032FC`). Maintains 4 phases keyed by `*pcVar5`:

- **Phase 0** (waiting for sync delimiter): accumulates the previous and current
  byte into a halfword; tests `*(short *)(buf+0x42) == -0x522`. `-0x522` as int16 is
  `0xFADE`. **This is the documented sync prefix** from `cca.md` §2 stored
  little-endian in memory.
- **Phase 1** (type byte just arrived): the type byte `bVar4` chooses both the
  buffer pool (`FUN_0800EF98`) and the body length:
  - `(bVar4 & 0xC0) == 0x00` → length code `5` (OTA / 5-byte minimal frame)
  - `(bVar4 & 0xE0) == 0xA0` → length code `0x35` = **53 bytes** (long packets)
  - else → length code `0x18` = **24 bytes** (everything else)
- **Phase 2** (body): each byte is appended; running CRC is updated as
  `crc = (crc<<8 | b) ^ table[crc>>8]`; counter decrements. When the byte counter
  hits 0, the trailing 2 bytes are read big-endian and compared to the CRC. On
  match, calls `FUN_0800C7E0(buf, len, 1)` to schedule dispatch. The CRC table
  pointer is `DAT_0800F564` → `0x0801E8CC` (**confirmed: matches first 32 bytes
  of a freshly-generated 0xCA0F lookup table**).
- **Phase 3** (other): housekeeping/cleanup branch; resets RX FIFO peripheral.

This validates `cca.md` §2 (framing) and §1 (CC1101 register init at runtime) end
to end. The size rules in `cca.md` §3 ("0x80–0x9F = 24 bytes, 0xA0+ = 53 bytes")
are encoded **literally** here as `(byte & 0xE0) == 0xA0 ? 53 : 24`.

## 5. Buffer pool allocator — `FUN_0800EF98`

Picks one of 4 RX buffers based on `(type & 0xC0)`:

| `type & 0xC0` | `(type & 0xE0)` | Buffer | Mask bit |
|---------------|-----------------|--------|----------|
| `0x00` | n/a | `DAT_0800EFFC` / `DAT_0800F004` / `DAT_0800F008` (3 pools by `type & 3`) | `*((byte*)pool+i)` |
| `0xC0` / `0x80` / `0x40` | `0xA0` (long config) | `DAT_0800F00C` | bit 0 of state +`bVar2 = 7` |
| else (short) | n/a | `DAT_0800F00C` | bit 0 of state +`bVar2 = 1` |

State byte `0x41` is a 4-bit pool-busy mask. If the requested pool's bit is set, the
allocator returns false (drop packet).

## 6. RX classifier & dispatcher — `FUN_0800CC74` / `FUN_0800EE08`

The actual receive entry point. Verified by:
1. Calls `FUN_0800C7E0` from `FUN_0800F2AC` schedule the buffer.
2. The TDMA tick handler `FUN_0800E36C` calls `FUN_0800CC74` when the RX state
   machine signals "phase = 1" (= packet ready).
3. The function reads `pbVar21 = *(byte **)(DAT_0800CF18 + 4)` (the just-received
   buffer pointer) and dispatches on `bVar14 = *pbVar21` (the type byte).

The four arms are:

### 6.1 Arm `(type & 0xC0) == 0x00` — OTA / firmware update

Matches OTA opcodes from `cca.md` §9.3: `0x2A, 0x32, 0x33, 0x34, 0x35, 0x36, 0x3A,
0x3C, 0x41, 0x58`. All have `& 0xC0 == 0`.

- Reads `*(char *)(state+1)` and checks `== -0x80` (== 0x80). This is the **OTA
  session-state guard** — the bridge only accepts OTA frames when the session is
  open. Closed sessions silently drop.
- Inside the open-session branch, reads `local_48 = *pbVar20 & 3` (the lower 2 bits
  of the type byte = sub-opcode hint), `pbVar20[1]` as a sequence/window byte, and
  performs replay-window validation against `*(ushort *)(state+6)`.
- On accept, the per-byte payload at `pbVar20[2]` is mirrored into either:
  - **Master OTA buffer** at `DAT_0800CF28+0x96` (when `*DAT_0800CF24 == 1`) — used
    during full firmware upload.
  - **Address-cursor buffer** at `DAT_0800CF28+0x4` (default) — used for device
    discovery + offset advancement.

The 9 TS-known OTA opcodes (`OTAOpcode` in `protocol/cca.protocol.ts`) are NOT
individually case-handled here. Instead the OTA arm normalizes them to:
- A **discovery vector** (lower nibble of state mask byte `(local_34 & 7)`) — this
  is the 8-way OTA channel hop counter discussed in `cca.md` §9.2.
- A **payload byte** (`pbVar20[2]`) — pushed into the buffer at the position
  computed from `local_34`.

The actual per-opcode state-machine work happens in the **OTA orchestration cluster
at `0x0800EE80`–`0x0800F2D8`** (PR #32 anchor table). Per-opcode dispatch is too
deeply state-machine-driven (10+ globals) to confidently split out from static
analysis without a live capture.

| Opcode | TS name | Wire arm | Status |
|--------|---------|----------|--------|
| `0x2A` | BeginTransfer | OTA arm | Visible — calls master-buffer reset |
| `0x32` | Control (multi-purpose) | OTA arm | Visible — sub-opcode in body byte 0 |
| `0x33` | GetDeviceFirmwareRevisions | OTA arm | Visible — short response |
| `0x34` | CancelDeviceFirmwareUpload | OTA arm | Visible |
| `0x35` | RemoteAddrDeviceDiscovery | OTA arm | Visible — broadcast scan |
| `0x36` | CodeRevision | OTA arm | Visible |
| `0x3A` | ClearError | OTA arm | Visible — clears `*(state+0x1e)` |
| `0x3C` | (ack/notify) | OTA arm | Visible — sets `*(state+0x1e) = 5` |
| `0x41` | TransferData | OTA arm | Visible — bulk-data path |
| `0x58` | QueryDevice | OTA arm | Visible — first opcode in handshake |

### 6.2 Arm `(type & 0xC0) == 0x40` — short-form pico/sensor (UNTYPED in TS)

This branch is **completely undocumented** in `protocol/cca.protocol.ts`. The TS
schema only types 0x80-class and above for runtime. The `0x40` arm:

- Reads bytes 3-4 as a **big-endian 16-bit serial** (`local_2a[0] = swap16(*(ushort
  *)(pbVar20 + 3))`).
- Calls `FUN_080084C0(local_2a, 0)` → device-table lookup by 16-bit serial. Returns
  index, 0xFF if not in table, or 100 if invalid.
- Reads `pbVar20[1] & 0x7F` as a sequence number.
- Reads `pbVar20[2] >> 5` as a 3-bit field (likely reason code or button index).
- Sets `*(state+0x1E) = 0x0B/0x05/0x03` based on whether sequence is in the
  expected window.

**Hypothesis**: this arm handles a previously-undocumented 16-bit-addressed CCA
class. The `(type & 0xC0) == 0x40` range covers `0x40-0x7F` — no TS PacketType
matches. **Most likely candidates**: very short OTA acks, low-priority sensor
beacons, or legacy QSM-bridge acks (cf. `qsm.md` cross-bridge note).

**Confidence: LOW.** No matching TS type. Needs live capture.

### 6.3 Arm `(type & 0xC0) == 0x80` — RUNTIME (the big one)

This is where 90% of the runtime traffic lands. Within this arm, the discriminator is
**bit 3 of the type byte** plus a few sub-fields:

#### 6.3.1 Sub-arm `(type & 0x08) == 0x00` — STATE reports (24 bytes)

Maps to: `STATE_80 (0x80)`, `STATE_RPT_81 (0x81)`, `STATE_RPT_82 (0x82)`,
`STATE_RPT_83 (0x83)`, plus the BEACON family `0x91/0x92/0x93`.

Path:
- Reads bytes 3-4 BE as 16-bit serial: `local_2a[0] = swap16(*(ushort*)(pbVar20+3))`.
- `uVar22 = FUN_080084C0(local_2a, 0)` — table lookup; 0xFF means unknown source.
- `bVar14 = pbVar20[5] >> 7` and `uVar22 = pbVar20[5] & 0x7F` — splits byte 5 into a
  flag bit and a 7-bit sequence, **NOT** documented in TS field tables.
- `uVar23 = pbVar20[2] >> 5` — top 3 bits of byte 2 as a "reason code" (0-7).
- Calls into the dedupe/state-machine path; on success, calls `FUN_0800C230` with
  `(buf, flags, seq, reason, flag_bit)`.

**TS fields validated**: `type@0`, `sequence@1`, `link_addr@2`, `subnet@3-4 BE`,
`zone@5`, `protocol@6`. These match.

**TS field gap**: byte 5 is `zone` in the TS schema, but RX-side it's split into
flag@7 + seq@0-6. The TS `STATE_RPT_81` field set has `zone=byte 5` — which the RX
code treats differently (probably the `&0x7F` mask only matters for byte-7
discriminator paths).

#### 6.3.2 Sub-arm `(type & 0x08) != 0x00` — BUTTON / SENSOR (24 bytes)

Maps to: `BTN_SHORT_A (0x88)`, `BTN_LONG_A (0x89)`, `BTN_SHORT_B (0x8A)`,
`BTN_LONG_B (0x8B)`, plus BEACON `0x91/0x92/0x93`.

Path:
- Reads bytes 2-5 BE as **32-bit serial** (`local_30 = swap32(*(uint*)(pbVar20+2))`).
- `uVar22 = FUN_080084C0(&local_30, 1)` — device-table lookup by 32-bit serial.
- `local_2c[0] = 1` — flag bit "wide-serial".
- `uVar23 = 5` — fixed "reason code".

**TS fields validated**: `type@0`, `sequence@1`, `device_id@2-5 BE`, `protocol@6`,
`format@7`. All match.

**Critical detail**: the RX code treats bytes 2-5 as the **canonical 4-byte serial**
for short-format buttons. This is the documented `device_id_be` field. Long format
(0x89/0x8B with format byte 0x0E) is also handled here but the additional
`bytes 12-15 = device_id_repeat` are validated separately downstream.

#### 6.3.3 BEACON dispatch (RX semantics — partial)

`BEACON_91/92/93` are short packets (`0x9x` → bit 7=1, bit 6=0, bit 4=1, bit 3=0
for 91/93 / bit 3=1 for 92). They land in:
- **0x91 (`bit3=0`)** → STATE sub-arm (6.3.1)
- **0x92 (`bit3=0`)** → STATE sub-arm
- **0x93 (`bit3=0`)** → STATE sub-arm

All three are processed by the same code path; the difference is purely in the type
byte. The downstream flag check `*(char *)(state+0x21)` (which the function tests
multiple times) likely encodes "pairing-mode beacon active" vs "stop beacon".

**Hypothesis (low-medium confidence)**:
- `0x91` = "bridge advertising pairing mode" — downstream sets `*(state+0x21) = 1`.
- `0x92` = "bridge ending pairing mode" — sets `*(state+0x21) = 0`.
- `0x93` = "initial pairing-mode beacon" — same as 0x91 with `(local_38 - 8) & 0xFF
  == 0xFF` boundary case.

Cannot confirm without a live capture of bridge-side beaconing.

#### 6.3.4 0xA0–0xBF (CONFIG / PAIR) — long packets

Verified by the byte-state-machine length code: `(type & 0xE0) == 0xA0` → 53 bytes.

These hit the runtime `0x80` arm too because `(0xA0 & 0xC0) == 0x80`. Sub-arm
discrimination:
- `(type & 0x18) == 0x00` (so `type` in 0xA0-0xA7) → `CONFIG_A1/A2/A3` family
- `(type & 0x10) != 0` (so `type` in 0xB0-0xBF) → `PAIR_B0/B2/B8/B9/BA/BB`

The classifier doesn't decode the format byte (`pbVar20[7]`) directly — that's
handed off downstream to `FUN_0800ECBC` (HDLC IPC TX) which forwards the 53-byte
packet wholesale up to lutron-core. **The bridge does not parse format byte
internally — it relays.**

This contradicts the assumption that the bridge knows which config-format is which.
It just forwards.

### 6.4 Arm `(type & 0xC0) == 0xC0` — HANDSHAKE (24 bytes, types C0-FF)

Maps to all `HS_C1, HS_C2, HS_C5, HS_C7..HS_E0` types. Path:
- Reads bytes 2-3 BE as 16-bit handshake nonce/sequence: `local_2a[0] =
  swap16(*(ushort*)(pbVar20 + 2))`. Stored at `state+0x11`.
- Reads `pbVar20[0] & 0x3F` as the sub-opcode (low 6 bits — strips the 0xC0
  category).
- Sets `*(state+0x1E) = 8` (handshake-pending mark).
- If `*DAT_0800D1D0 != 0` (handshake session active), looks up the per-round
  echo data at `DAT_0800D1DC + (round - 1) * 0x92`. **Each round has a 146-byte
  state slot** — confirms the 6-round handshake per `cca.md` §7 with
  `C1→C7→CD→D3→D9→DF` rotation.

The handshake **acknowledgment echoing** described in `cca.md` §7 ("type+1, seq+5,
byte[5]=0xF0, recalculated CRC") is built downstream after this RX hand-off — the
classifier just buffers the inbound and signals "handshake pending".

| Type | Class | Status |
|------|-------|--------|
| `0xC0` | HS_PAIR_RESP | Visible — `(0xC0 & 0x3F) == 0` |
| `0xC1` | HS round 1 dimmer | Visible — `(0xC1 & 0x3F) == 1` |
| `0xC2` | HS round 1 bridge | Visible |
| `0xC5` | HS sensor echo | Visible — `(0xC5 & 0x3F) == 5` (sensor offset is C1+4) |
| `0xC7` | HS round 2 | Visible — encoded as round 1 + 6 |
| `0xC8` | HS round 2 bridge | Visible |
| `0xCD` | HS round 3 | Visible |
| `0xCE` | HS round 3 bridge | Visible |
| `0xD3` | HS round 4 | Visible |
| `0xD4` | HS round 4 bridge | Visible |
| `0xD9` | HS round 5 | Visible |
| `0xDA` | HS round 5 bridge | Visible |
| `0xDF` | HS round 6 | Visible |
| `0xE0` | HS round 6 bridge | Visible |

The 6-round structure encoded as `round = ((type - 0xC1) / 6) + 1` matches the TS
schema exactly. **The classifier does not validate the contents** — that's
downstream pairing-engine work.

## 7. ACK packets (0x0B, 5 bytes)

Per `cca.md` §10 ("0x0B ACK Packets"), dimmers respond with 5-byte type-0x0B ACKs.
Following the byte-state-machine length rules, **`0x0B` lands in the
`(type & 0xC0) == 0` arm with length code 5** — the same path as OTA. This is
consistent with the `FUN_0800F2AC` length determination:
- `bVar4 & 0xC0 == 0` AND `bVar4 < 0x40` → length 5 (OTA + ACK shared)
- Distinguishing OTA from ACK happens **inside** the arm via the per-byte body
  validation.

The 5-byte ACK structure `[0B][seq][resp_class][seq^0x26][resp_subtype]` (cca.md §10)
fits inside the 5-byte length budget perfectly. The classifier does no further
discrimination — it just stuffs the buffer into the OTA arm and lets the upstream
HDLC IPC layer figure out which kind of frame it is. (This explains why CC1101
captures of ACKs sometimes show systematic `^ 0xFE` errors on bytes 2 and 4 —
they're treated as the OTA replay-window bytes, which the firmware overwrites
during its decoder pass.)

## 8. Findings vs. existing TS schema

### 8.1 Validated

- **Length-by-type rule**: `(type & 0xE0) == 0xA0` → 53 bytes; else 24 (or 5 for
  `type < 0x40`). Matches `getPacketLength()` in TS.
- **CRC poly 0xCA0F** — confirmed in 801FB08 precomputed table at `0x0801E8CC`.
- **Sync `0xFADE`** — confirmed (`-0x522` in int16) at `0x0800F2F8`.
- **Handshake structure**: 6 rounds, `C1+6n` rotation, sensor echo at `C5 = C1+4`.
- **STATE-vs-BUTTON discrimination**: bit 3 of type byte (short vs long format).
- **Device-table lookup**: 16-bit serial for STATE/BEACON, 32-bit for BUTTON.

### 8.2 New / unvalidated

- **`(type & 0xC0) == 0x40` arm**: an entire RX path for type bytes 0x40-0x7F that
  has NO corresponding TS type. The arm reads a 16-bit serial at byte 3-4 and
  validates against the device table. Hypothesis: legacy short-form
  pico/sensor packets, or a debug/test path. **Needs live capture to identify.**

- **0x0B ACK packets** are processed as OTA frames in the byte-state machine
  (length-5 path). The TS schema currently doesn't model them as a packet type
  (only as a discovery note in §10). Suggested: add `ACK_0B` virtual type for
  documentation completeness.

- **STATE byte 5 split**: TS treats `byte 5 = zone` as a single value, but RX code
  splits it as `flag@bit7 | seq@bits 0-6`. The `flag` bit may indicate "this STATE
  is a re-transmit" or "this STATE has no zone".

### 8.3 Cannot determine from static analysis

- **Per-OTA-opcode field layouts** (BeginTransfer payload, CancelDeviceFirmwareUpload
  payload, etc.). The OTA arm's per-opcode state machine is split across 10+ globals
  in the cluster `0x0800EE80`–`0x0800F2D8`. Identifying them statically would need
  cross-reference with PowPak's RX decoder (cca.md §9.7) which IS more readable.
- **BEACON 91/92/93 semantics**: confirmed they share a code path; cannot tell
  which is "start", "stop", "initial pairing" purely from RX-side. Bridge-side TX
  might reveal it.
- **Format-byte (byte 7) sub-dispatch** for CONFIG / PAIR packets: the EFR32 just
  relays the 53-byte packet over HDLC. Format-discrimination happens in
  AM335x lutron-core, not here.

## 9. Reproducibility

```bash
# Import binaries into a fresh scratch project
mkdir -p /tmp/cca-rx-scratch
bash tools/ghidra/ghidra-headless.sh /tmp/cca-rx-scratch rx -import \
  data/firmware/phoenix-device/coprocessor/phoenix_efr32_8003000-801FB08.bin \
  -processor ARM:LE:32:Cortex -loader BinaryLoader \
  -loader-baseAddr 0x08003000 -overwrite

# Find the RX classifier (look for the function with `(type & 0xC0)` plus
# multiple cmp #0x80, #0x40, #0xC0)
bash tools/ghidra/ghidra-headless.sh /tmp/cca-rx-scratch rx \
  -process phoenix_efr32_8003000-801FB08.bin \
  -postScript FindCCAByteMaskC0.java -scriptPath tools/ghidra-scripts \
  -noanalysis -readOnly

# Decompile a candidate
bash tools/ghidra/ghidra-headless.sh /tmp/cca-rx-scratch rx \
  -process phoenix_efr32_8003000-801FB08.bin \
  -postScript DecompileFunctionAt.java 0x0800CC74 \
  -scriptPath tools/ghidra-scripts -noanalysis -readOnly
```

Helper scripts added in this PR:
- `tools/ghidra/scripts/FindCCAByteMaskC0.java` — locates the RX classifier by its
  byte-mask compare signature (`& 0xC0` + cmp `0x40`/`0x80`/`0xC0`).
- `tools/ghidra/scripts/FindFADESync.java` — locates the sync-delimiter check.
- `tools/ghidra/scripts/FindCRCAndCallers.java` — locates CRC poly references and
  functions that consume them.
- `tools/ghidra/scripts/FindRXDispatcher.java` — coarse first-pass enumerator;
  superseded by `FindCCAByteMaskC0.java` for RX.
- `tools/ghidra/scripts/FindRXClassifier.java` — looks for cmp-cascades against
  RX type bytes; useful for finding individual handler clusters.
- `tools/ghidra/scripts/DumpStrings.java` — read-only string dumper. (No useful
  strings in EFR32 image — fully stripped.)

## 10. Outstanding work

1. **Capture live RF dumps of the 0x40-0x7F range** to identify the unknown arm.
   No CC1101 in our fleet is currently configured to RX this band; need to drop
   the runtime sync filter and let RTL-SDR capture wild type-byte distributions.
2. **Trace BEACON 91/92/93 split** — instrument the bridge in active-pairing
   mode and capture which type byte appears at which phase boundary.
3. **OTA per-opcode body layouts** — needs paired RX-side trace from PowPak (which
   has source-readable opcode jump table, per `powpak.md`) plus the bridge-side
   TX trace from `caseta-cca-ota.md`.
4. **Decompile and label `FUN_0800EE80`–`FUN_0800F2D8`** (OTA orchestration cluster)
   in 803A008. The cluster is too dense to consolidate here.

## 11. Open questions for the next pass

- Does the bridge ever **drop** packets for unknown type bytes, or does it forward
  everything 0xC0-aligned? (The `(type & 0xC0) == 0x40` arm doesn't reject — it
  processes.) → Suggests the bridge may forward unknown packets.
- The `*(state + 0x1E)` value (0/3/5/0xB) is the **RX disposition code**:
  - `0` = drop / unknown source
  - `3` = forward (out of sequence)
  - `5` = forward (in sequence — primary delivery)
  - `0xB` = forward (sequence skip but in window)
  - `8` = handshake-pending (handshake arm only)
  - These match a TDMA "slot assignment" enum that's referenced from `FUN_0800E36C`.
  Worth confirming by enumerating xrefs to those constants.
