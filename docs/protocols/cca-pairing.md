# CCA Pairing & Handshake Protocol

End-to-end reverse-engineering writeup of the CCA pairing/handshake protocol — what the device does, what the bridge does, what's authenticated, what's replayable, and where SKU enforcement lives. Companion to [docs/protocols/cca.md](cca.md), which covers the runtime/control packet types but only sketches the pairing flow.

> Scope: 433 MHz CCA radio (Phoenix EFR32MG12 bridge ↔ HCS08 device). Picos, dimmers, switches, sensors, PowPak. Vive (433 MHz, Lutron's own DCD pairing) and CCX (Thread/802.15.4) are separate protocols.

## TL;DR

| Question | Answer |
|----------|--------|
| Is there cryptography? | **No.** No AES, no SHA, no HMAC, no key exchange. Confirmed across Phoenix EFR32, HCS08 device, and old Caseta SmartBridge STM32 by entropy + sbox/Rcon scans. |
| Is there a shared secret? | **No.** Pairing establishes addressing (zone, integration ID, group) but no key material. |
| What gates "this device may pair with me"? | **Host-system policy** (LEAP server / pegasus on AM335x), enforced by reading the device's **DeviceClass** in PAIR_B0 byte 20–23 (4-byte BE). The EFR32 radio has no concept of SKU prefix; it relays everything. |
| Anti-replay mechanism? | Per-packet **monotonic sequence byte** (offset 1) tracked against a circular dedup buffer of `[type, seq, src_id_3byte]` tuples (6 bytes/entry, ~10 entries). |
| What's the handshake actually doing? | A **liveness/echo proof**: bridge proves it received the device's challenge bytes by retransmitting them with type+1 and seq+5. Establishes addressable round-trip exists; does not authenticate. |

## Hardware ground truth

```
┌───────────────────────────┐               ┌────────────────────┐
│ Phoenix bridge            │ host-link     │ AM335x main proc   │
│ EFR32MG12 coprocessor     │◀──UART/SPI───▶│ runs LEAP/pegasus  │
│ — decodes 433 MHz CCA     │               │ — owns DeviceClass │
│ — runs handshake state-mc │               │ — owns SKU policy  │
│ — does dedup / CRC / N81  │               │ — assigns zone_id  │
└────────────┬──────────────┘               └────────────────────┘
             │
             │ 433 MHz FSK,
             │ 8N1-encoded, 0xCA0F CRC,
             │ FA DE sync word
             ▼
┌───────────────────────────┐
│ End device (HCS08)        │
│ basenji/eagle-owl/bananaq │
│ — sends PAIR_B0 announce  │
│ — sends C1/C7/CD/D3/D9/DF │
│   handshake challenges    │
│ — flashes config to NVM   │
└───────────────────────────┘
```

The EFR32 is a **dumb radio**. The handshake state machine lives in the EFR32 firmware (decompiled at `FUN_0800cc74` in `phoenix_efr32_8003000-801FB08.bin`), but the `device class → may pair` decision crosses the host-link to the AM335x. CC110L on dimmers is **analog only** (FSK transceiver) — it has no protocol awareness; the HCS08 drives all framing.

## Sequence diagram (bridge pairing, dimmer/switch)

```
Bridge (EFR32)                        Device (HCS08)
─────────────────                     ────────────────
                                      [user holds tap-to-pair button]
0x91/0x92/0x93 BEACON ───broadcast──▶
   subcmd=0x01 idle / 0x02 active
   ←──── 65 ms beacon cadence ────
                                      [device sees beacon, broadcasts itself]
                       ◀── PAIR_B0 (53B, format 0x13, sub 0x08)
                                            byte[5]=0x7F (pair flag)
                                            byte[16-19]=serial BE
                                            byte[20-23]=DeviceClass BE  ⓘ
                                            byte[2]=0xA0 first / 0xA1 retx
   [host-link] forward B0 to AM335x ─▶ [AM335x: lookup DeviceClass]
                                       [AM335x: SKU policy check ✗ → drop, ✓ → continue]
   [AM335x: assign zone_id, integration IDs]
   ◀── [host-link] commit pair to bridge

0x82 UNPAIR_PREP (24B, fmt 0x09) ───▶ [device clears any prior pairing]
   bytes 16-19 = device serial         confirms target

0x82 IDENTIFY (fmt 0x09) ─────────▶  [device: blink LED, "I'm being paired"]

0xA0+ FORMAT-LIST CONFIG (53B) ───▶
   format 0x13: dim capability         (5 retx, ~70 ms)
   format 0x28: zone assignment
   format 0x14: function map
   format 0x12: final bind w/ zone_byte
                                       ◀── HS_C1 (24B, fmt 0x07, seq 0x20)
                                            byte[5]=0xF0 (round-1 marker)
                                            byte[8-21]=14B challenge payload
   [bridge: store payload in slot 0]

   HS_C2 ──────────────echo───────▶
   = HS_C1 with: type=0xC2, seq=seq+5=0x25,
     byte[5] |= 0x90 (slot-0 special),
     payload bytes copied verbatim, CRC recomputed
                                      ◀── HS_C7 (seq 0x40) round 2 challenge
   HS_C8 ──────────────echo───────▶  type=0xC8, seq=0x45, payload echoed
                                      ◀── HS_CD (seq 0x60) round 3
   HS_CE ──────────────echo───────▶  type=0xCE, seq=0x65
                                      ◀── HS_D3 (seq 0x80) round 4
   HS_D4 ──────────────echo───────▶  type=0xD4, seq=0x85
                                      [rounds 5-6 D9/DA, DF/E0 if device requests]

[device: pair complete, all rounds confirmed]
0x91 BEACON subcmd 0x04 (committed) ─▶ [bridge tells RF world the device is bound]
```

For sensors and Vive devices, the structure is similar but uses different format codes (0x17 for sensor announce, 0x10 for Vive accept, 0x23 for Vive request) and the handshake echo type bumps by **+4** (HS_C5 vs HS_C2).

## Per-opcode payload format

All handshake packets are 24 bytes (22 data + 2 CRC, 0xCA0F poly). All pairing packets are 53 bytes (51 data + 2 CRC). Field numbering is 0-based byte offset within the un-encoded packet (after N81 decode, before CRC).

### PAIR_B0 — Device announces itself (initial enrollment)

53 bytes. Sent by HCS08 device when user holds tap-to-pair on a dimmer/switch/PowPak. Broadcast to bridge.

| Off | Len | Field | Notes |
|-----|-----|-------|-------|
| 0   | 1 | type | 0xB0 (or 0xB1/0xB2 for retx variants) |
| 1   | 1 | sequence | First=0x00, retx increments by 6 |
| 2   | 1 | flags | 0xA0 first packet, 0xA1 thereafter |
| 3-4 | 2 | subnet | BE; arbitrary 16-bit |
| 5   | 1 | pair_flag | **0x7F** during pairing (off otherwise) |
| 6   | 1 | proto | 0x21 (`QS_PROTO_RADIO_TX`) |
| 7   | 1 | format | 0x13 (dimmer/switch announce) |
| 8   | 1 | flags | 0x00 |
| 9-13| 5 | broadcast | 0xFF × 5 |
| 14  | 1 | subcmd | 0x08 (announce) |
| 15  | 1 | caps | 0x05 (dimmer/switch capability flags) |
| 16-19 | 4 | **serial** | BE, the device's hardware ID |
| 20-23 | 4 | **DeviceClass** | BE, 4-byte SKU descriptor — the field that triggers SKU-prefix policy upstream |
| 24  | 1 | constant | 0xFF |
| 25-50| 26| padding | 0x00 or 0xCC |
| 51-52| 2 | CRC-16 | poly 0xCA0F |

The **DeviceClass at byte 20–23** is the single field that makes a PowPak RMJ → LMJ conversion attack feasible: the bridge does no integrity check on this, so a device that flashed a different DeviceClass announces itself differently. Bridge enforcement must happen on the AM335x against a host-system whitelist (RMJ→ESN, RMJS→Vive, LMJ→RA2/3/HW per the SKU rules).

### PAIR_B8 / B9 / BA / BB — Pico / Vive / sensor variants

53 bytes. Same overall structure as B0 but with Pico-specific fields. See [protocol/cca.protocol.ts:804](../../protocol/cca.protocol.ts) (`pairB8Fields`) for the canonical layout.

| Type | Direction | Use |
|------|-----------|-----|
| 0xB8 | device → hub | Vive pair request / pico bridge-only pair |
| 0xB9 | device → hub | Direct-pair-capable / Vive beacon (timer=0x3C active, 0x00 stop) |
| 0xBA | hub → device | Bridge-only pair / Vive accept (sensors use format 0x17) |
| 0xBB | both | Direct-pair capable |

Differences from B0: byte[2-5] is device_id (not flags+subnet), byte[10] is `btn_scheme`, byte[28] is `device_class` (single byte, distinct from the 4-byte BE class in B0).

### PAIR_RESP_C0 — Pairing response container (24B base)

`PAIR_RESP_C0` (0xC0) is the base type from which all handshake rounds inherit. Field layout:

| Off | Len | Field | Notes |
|-----|-----|-------|-------|
| 0   | 1 | type | 0xC0–0xE0 (round/role discriminator) |
| 1   | 1 | sequence | 0x20, 0x40, 0x60, 0x80, 0xA0, 0xC0, 0xE0 — round# × 0x20 |
| 2-5 | 4 | device_id | BE (target serial during echo, source serial during challenge) |
| 6   | 1 | proto | 0x21 |
| 7   | 1 | format | 0x07 (handshake) |
| 8-21| 14| **payload** | Round-specific. Bridge **echoes verbatim** during response |
| 22-23| 2| CRC-16 | |

### HS_C1 / C7 / CD / D3 / D9 / DF — Device challenges (odd in C-rank)

Sent by **device → bridge**. Six-round half-duplex challenge. Round number = `((type - 0xC1) / 6) + 1`.

The 14-byte payload (offset 8–21) is opaque to the radio firmware but contains:
- Bytes 8–9: per-round opcode
- Bytes 10–13: device serial echo / addressing
- Bytes 14–21: round-specific configuration request (function map, group id, etc.)

The **only field the device validates on bridge response** is the payload echo and the type+1 / seq+5 transformation — there is no MAC, no nonce, no signature. From `firmware/src/cca/cca_pairing.cpp:264`:

> Handshake echo is CRITICAL — bridge must echo device's exact challenge bytes: `type+1`, `seq+5`, `byte[5]=0xF0` (round 1 only), recalculate CRC. Hardcoded handshake data = guaranteed failure; device validates the echo.

### HS_C2 / C8 / CE / D4 / DA / E0 — Bridge responses (even in C-rank)

Sent by **bridge → device**. The bridge's only production rule is:

```
response = challenge.copy()
response[0] = challenge[0] + 1
response[1] = challenge[1] + 5
if round == 1 and slot == 0:
    response[5] |= 0x90       # round-1 marker bit
recompute_crc(response)
transmit(response)
```

That's the entire authentication artifact. **Anyone with a 433 MHz transceiver and the CCA framing layer can produce valid handshake responses by snooping and parroting.**

### HS_C5 — Sensor echo (sensor → bridge)

Daylight/occupancy sensors use C5 instead of C2 (offset +4 from C1, not +1). Same echo rule but the sensor uses the response to confirm bridge presence rather than the dimmer pattern.

## Anti-replay

Decompiled `FUN_0800c230` (the dedup walker, called from the master RX dispatcher `FUN_0800cc74`):

- Maintains a circular buffer of recent packet 6-byte tuples: `[type, seq, byte2, byte3, byte4, byte5]` (effectively `[type, seq, src_id_3byte]`).
- ~10 entries (head pointer at base+0x30, wraps when reaching `base + 0x2A`).
- Incoming packets walk the buffer backward; if `(type, src_id_lo3)` matches AND seq matches AND flags-bit-3 indicates "already processed", the packet is rejected.
- Sequence byte is the **monotonicity gate**: the master RX handler at `FUN_0800cc74` rejects any packet whose `seq < last_seq_for_this_class` (with class = `type & 0xC0`).

```c
// from FUN_0800cc74, branch 'uVar19 == 0xc0' (handshake range)
if (*(byte *)(iVar12 + 1) < 0xc0) {
    *(undefined1 *)(DAT_0800d1cc + 0x1e) = 8;       // accept, advance state
}
else if ((*(byte *)(iVar12 + 1) == 0xc0) && (uVar24 < *(ushort *)(DAT_0800d1cc + 6))) {
    *(undefined1 *)(DAT_0800d1cc + 0x1e) = 8;       // accept, seq monotonic
}
// else: stale, ignore
```

So the anti-replay primitives are:

1. **Per-class sequence monotonicity** — `seq` must be ≥ last seen in the same packet class.
2. **6-byte tuple dedup** — `[type, seq, src_id]` already in the recent buffer → drop.

There is **no nonce, no challenge freshness, no time-based window**. A replay attacker who captures a complete handshake conversation can replay it after the bridge has rebooted (state buffer cleared) — the bridge will accept it as fresh.

## Slot map (bridge handshake state)

The bridge stores up to **7 handshake slots** keyed by sequence value. From `FUN_08011a1a`:

| Sequence byte | Slot | Storage offset |
|---------------|------|----------------|
| 0x20 | 0 | base + 0x46 |
| 0x40 | 1 | base + 0x56 |
| 0x60 | 2 | base + 0x66 |
| 0x80 | 3 | base + 0x76 |
| 0xA0 | 4 | base + 0x86 |
| 0xC0 | 5 | base + 0x96 |
| 0xE0 | 6 | base + 0xA6 |

Each slot is **0x10 (16) bytes** wide — the full payload (offset 8–21 of the 24-byte handshake packet, plus 2 trailing CRC bytes). On reset (`FUN_08011a78`), the bridge memsets the entire 0x70 (112) byte slot buffer to 0xFF.

The current implementation in `firmware/src/cca/cca_pairing.cpp:190` only uses 4 slots (0x20/0x40/0x60/0x80) covering the first 4 rounds; rounds 5–6 are produced from the same data. The hardware bridge's state machine has 6 unique echo types (`{0xC2, 0xC8, 0xCE, 0xD4, 0xDA, 0xE0}`) but reuses the same 4 captured payloads.

## DeviceClass enforcement (where SKU policy lives)

**Not in the EFR32.** Confirmed by:

1. No 4-byte DeviceClass constants found in the EFR32 binary by direct search.
2. The handshake state machine in `FUN_0800cc74` does not consult the announce data after the dedup phase.
3. The radio firmware's job ends at "is this packet well-formed and addressed to me?" — the AM335x decides "is this device allowed to pair with this system?".

The flow:

```
                             Bridge (EFR32)                      AM335x (LEAP/pegasus)
PAIR_B0 [DeviceClass=X] ───▶  decode + dedup       ──host-link──▶ deviceclass-policy.json lookup
                              forward verbatim                    ✓ if X is in allowed-set
                                                                  ✗ if X is wrong-SKU (e.g. RMJ on RA3)
                                                                  ✗ if X already enrolled
                              ◀── commit (continue) or          ─
                                  drop (silent)
```

This means **a converted device** (PowPak with flashed LMJ DeviceClass — see `docs/firmware-re/powpak.md`) will pair to RA3 cleanly because the AM335x sees DeviceClass = LMJ in PAIR_B0 byte 20–23 and enrolls it. The radio layer cannot distinguish.

The LEAP server's enforcement is in pegasus's device-allowlist module, not in this writeup's scope.

## Comparison: old Caseta SmartBridge vs Phoenix

Analyzed `caseta-sb_stm32_80031E4-801FB08.s19` (old Caseta SmartBridge STM32 coproc, 117 KB, base 0x080031E4):

| Aspect | Old Caseta SB (STM32) | Phoenix EFR32 |
|--------|----------------------|---------------|
| Crypto primitives | None | None |
| AES sbox / Rcon | Absent | Absent |
| FA DE preamble | 1 occurrence (encoder template) | 1 occurrence |
| 0xCA0F CRC poly | 2 occurrences | 1 occurrence |
| CMP-cascade for handshake | Identical (B9 B0 BA C0 C1 C2 family) | Identical |
| Handshake state-machine | Same `seq → slot` map structure (verified at CMP rX,#0xC0, 11 hits) | Same |
| Format dispatch | Same 0x07/0x10/0x12/0x13/0x14/0x1A | Same |

**The handshake protocol is functionally identical.** The Caseta SmartBridge does NOT have a simpler handshake — same 6-round half-duplex echo, same anti-replay (sequence monotonicity + 6-byte tuple dedup), same lack of crypto. Phoenix added Vive support (BB beacon, format 0x10 accept retx variants) and CCX/Thread but the CCA pairing payload and rounds are unchanged.

This makes sense: end devices (HCS08 picos, dimmers) are shared across product lines and were designed against one fixed protocol. The bridge had to evolve while staying backward-compatible.

## Unresolved opcodes

The following type bytes are typed in `protocol/cca.protocol.ts` but were not individually identified in the EFR32 dispatch (they're handled by the generic `& 0xC0 == 0xC0` branch and disambiguated by sequence value, not by direct CMP):

- `HS_C5` (sensor echo): inferred from device source, no CMP rX,#0xC5 in EFR32 — bridge produces it via the same echo logic as C2 with type offset +4, but the producer wasn't isolated.
- `HS_DF` and `HS_E0` (round 6): `firmware/src/cca/cca_pairing.cpp` references all 6 echo types but only consumes 4 challenge slots (0x20/0x40/0x60/0x80). Rounds 5–6 (sequences 0xA0/0xC0/0xE0) appear to be silent — slots are allocated but the current implementation does not capture them. Whether the hardware bridge actually uses these rounds in a 6-round flow vs the captured-4 flow is **untested empirically**; the slot table provisions for it but the master RX dispatcher does not differentiate.

These can be characterized fully only with on-air capture during a live RA3 pairing session — the static analysis tells us the slot exists but not the temporal usage.

## Implementation notes for our bridge

`firmware/src/cca/cca_pairing.cpp` implements the **bridge side** of this protocol. Key gotchas already discovered (from `docs/protocols/cca.md:551–584` and prior session notes):

- **Echo verbatim**: the device validates `payload[8..21]` byte-for-byte. Any deviation from the captured challenge → device rejects, pair fails silently.
- **Sequence transform**: `response.seq = challenge.seq + 5`, NOT `+1`. We hardcoded `+5` per the validated capture.
- **Slot 0 special case**: `response.byte[5] |= 0x90` only on the slot-0 echo (round 1). Other slots use the captured byte 5 verbatim.
- **CRC recompute**: the echo changes `type` + `seq` + (sometimes) `byte[5]`, so CRC must be recomputed before TX.
- **Half-duplex timing**: long RX windows (5 s+) during handshake collection, short bursts (3 packets max) during echo. Violating this cadence causes the device to give up.

## References

- Decompiled functions:
  - `FUN_0800cc74` (`phoenix_efr32_8003000-801FB08.bin` @ `0x0800cc74`) — master packet RX dispatcher, format-byte and class (`& 0xC0`) routing.
  - `FUN_08011a1a` (`phoenix_efr32_8003000-801FB08.bin` @ `0x08011a1a`) — handshake slot map (sequence → slot offset).
  - `FUN_08011a78` (`phoenix_efr32_8003000-801FB08.bin` @ `0x08011a78`) — slot buffer reset (memset 0x70 to 0xFF).
  - `FUN_0800c230` (`phoenix_efr32_8003000-801FB08.bin` @ `0x0800c230`) — 6-byte tuple dedup walker, anti-replay.
  - `FUN_080119a4` / `FUN_08011798` (`phoenix_efr32_8003000-801FB08.bin` @ `0x080119a4` / `0x08011798`) — generic config-packet builder used as a substrate for handshake responses.

- Source code:
  - [`firmware/src/cca/cca_pairing.cpp`](../../firmware/src/cca/cca_pairing.cpp) — bridge-side state machine implementation.
  - [`protocol/cca.protocol.ts:782–906`](../../protocol/cca.protocol.ts) — packet type definitions for PAIR_* and HS_*.
  - [`docs/firmware-re/powpak.md`](../firmware-re/powpak.md) — PowPak HCS08 RE; DeviceClass at body offset 0x008AD; flash-write primitive at BN 0x4290.
  - [`docs/protocols/cca.md`](cca.md) — overall CCA protocol reference (this doc is the pairing chapter).

- Firmware analyzed:
  - `data/firmware/phoenix-device/coprocessor/phoenix_efr32_8003000-801FB08.bin` (117 KB Phoenix CCA bridge, EFR32MG12)
  - `data/firmware/phoenix-device/coprocessor/phoenix_efr32_8004000-803A008.bin` (221 KB Phoenix CCA bridge, newer)
  - `data/firmware/phoenix-device/coprocessor/phoenix_hcs08_3000-7E808.bin` (505 KB HCS08 device firmware, basenji/bananaquit)
  - `data/firmware/caseta-device/coproc-old/caseta-sb_stm32_80031E4-801FB08.s19` (242 KB old Caseta SmartBridge STM32)
