# CCA Device Configuration Protocol

## Overview

CCA devices (dimmers, switches) accept configuration commands over the air using **type bytes A1-A3** (0xA0+ range). These packets MUST be **53 bytes** (51 data + 2 CRC) with 0xCC padding. Shorter packets are silently rejected.

The type byte rotates A1 -> A2 -> A3 across separate config calls (constant within a single burst of 20 retransmissions). This prevents mixup when multiple configs are sent simultaneously.

Zone alternation: first packet uses the primary zone ID, remaining 19 use the alternate zone (low byte + 2).

## Packet Structure (Common Header)

All config formats share bytes 0-12:

| Bytes | Description |
|-------|-------------|
| 0 | Type (A1/A2/A3 rotating) |
| 1 | Sequence (0x01 first, then +6 per retransmission) |
| 2-5 | Bridge zone ID (little-endian) |
| 6 | 0x21 protocol marker |
| 7 | Format byte (see below) |
| 8 | 0x00 |
| 9-12 | Target device ID (big-endian) |
| 51-52 | CRC-16 over bytes 0-50 |

## Format 0x11: LED Configuration (CONFIRMED)

Controls the status LED behavior on the device.

| Bytes | Value | Description |
|-------|-------|-------------|
| 13-22 | `FE 06 50 00 04 06 00 00 00 00` | Static command prefix |
| 23 | LED state | LED when load is OFF (0xFF=on, 0x00=off) |
| 24 | LED state | LED when load is ON (0xDF=on, 0x00=off) |
| 25-50 | 0xCC | Padding |

### LED Modes

| Mode | Byte 23 | Byte 24 | Description |
|------|---------|---------|-------------|
| Off | 0x00 | 0x00 | LED always off |
| On | 0xFF | 0xDF | LED always on |
| On when load off | 0xFF | 0x00 | LED on only when load is off |
| On when load on | 0x00 | 0xDF | LED on only when load is on |

Reference capture: `captures/cca-sessions/led_2026-02-10T09-04-26.csv`

## Format 0x1C: Fade Rate Configuration (CONFIRMED)

Sets the default fade-on and fade-off times used when the device is physically pressed.

| Bytes | Value | Description |
|-------|-------|-------------|
| 13-22 | `FE 06 50 00 03 11 80 FF 31 00` | Static command prefix |
| 23-24 | uint16 LE | Fade-on time (quarter-seconds) |
| 25-26 | uint16 LE | Fade-off time (quarter-seconds) |
| 27-50 | 0xCC | Padding |

### Encoding

- Quarter-seconds: `value = seconds * 4`
- Example: 15 seconds = 60 = 0x3C (byte 23 = 0x3C, byte 24 = 0x00)
- Example: 0.25 seconds = 1 = 0x01 (byte 23 = 0x01, byte 24 = 0x00)
- Max uint16: 65535 qs = ~4.55 hours (Lutron caps at 4 hours in UI)

### Confirmed Behavior

- Fade values are uint16 LE, NOT single bytes. Setting byte 24 to non-zero causes the device to read bytes 23-24 as a single large value (e.g., byte 23=0x01, byte 24=0x04 -> 0x0401 = 1025 qs = 256 seconds).
- Bytes 27-30 were tested for delay values; device ignores them entirely.

Reference capture: `captures/cca-sessions/real-set-fade-15s-both_2026-02-10T11-44-04.csv`

## Format 0x15: Trim Configuration (CONFIRMED via RTL-SDR)

Sets high/low trim levels for dimmers. The real bridge wraps trim config in a 3-phase sandwich:

1. **Phase 1**: type 0x82, SET_LEVEL(0x0000) — turn off, ~20 retransmissions
2. **Phase 2**: type 0xA3, TRIM CONFIG (format 0x15) — 2 packets only (seq 0x01 on AD, seq 0x02 on AF)
3. **Phase 3**: type 0x81, SET_LEVEL(save) — high-end test uses 0xFEFF (100%), low-end uses 0x0001 (min)

**Important**: The sandwich type bytes are 82 → A3 → 81, NOT 83 → A3 → 82.

### Full Packet Layout (53 bytes, RTL-SDR confirmed)

| Bytes | Value | Description |
|-------|-------|-------------|
| 0 | 0xA3 | Type (always A3 for trim, does NOT rotate like LED/fade) |
| 1 | seq | 0x01 first packet, 0x02 second |
| 2-5 | zone LE | AD first packet, AF second |
| 6 | 0x21 | Protocol marker |
| 7 | 0x15 | Format (trim config) |
| 8 | 0x00 | Zero |
| 9-12 | device ID | Target device (big-endian) |
| 13 | 0xFE | Command prefix |
| 14 | 0x06 | Config class |
| 15 | 0x50 | Trim component |
| 16 | 0x00 | Zero |
| 17 | 0x02 | Trim subcommand |
| 18 | 0x08 | Static |
| 19 | 0x13 | Static |
| 20 | high trim | High-end trim byte |
| 21 | low trim | Low-end trim byte |
| 22-23 | `23 0B` | Constant (NOT CRC) |
| 24-26 | `60 00 00` | Constant |
| **27-28** | **`00 FE`** | **Constant data — NOT CC padding!** |
| 29-50 | 0xCC | CC padding |
| 51-52 | CRC | CRC-16 over bytes 0-50 |

**Critical**: Bytes 27-28 are `00 FE`, not CC padding. Using CC at these positions causes the device to lock up and become unresponsive (requires factory reset). This was the root cause of all earlier trim failures.

### Trim Encoding

- Single byte: `byte = percent * 254 / 100` (0x00 = 0%, 0xFE = 100%)
- 90% → 229 = 0xE5
- 95% → 241 = 0xF1
- 15% → 38 = 0x26
- 5% → 13 = 0x0D

### Key Differences from LED/Fade Config

| Property | LED/Fade | Trim |
|----------|----------|------|
| Type byte | A1/A2/A3 rotating | Always A3 |
| Retransmissions | 20 | 2 |
| SET_LEVEL sandwich | No | Yes (82 → A3 → 81) |
| Bytes 27-28 | CC CC (padding) | 00 FE (data!) |
| Seq pattern | 0x01 first, then +6 | 0x01, 0x02 |

### Observations

- Lutron app separates "high-end trim" and "low-end trim" into separate UI operations, but the radio packet carries BOTH values (bytes 20-21)
- The app likely reads current values first, then re-sends with only the changed value
- Phase (forward/reverse) encoding location is UNSOLVED — byte 22 (0x23) is constant
- Device echoes back the config packet as an ACK when successfully received

### RTL-SDR Reference Captures

```
captures/trim-high-90.bin  — high-end trim set to 90%
captures/trim-low-15.bin   — low-end trim set to 15%
captures/trim-high-95.bin  — high-end trim set to 95%
captures/trim-low-5.bin    — low-end trim set to 5%
```

Decode: `bun run tools/rtlsdr-cca-decode.ts --rate 2000000 captures/trim-low-5.bin`

### API

- `POST /api/config/trim` — full sandwich (save + test): `{ bridge, target, high, low, is_high }`
- `POST /api/config/trim-save` — config only (no level sandwich): `{ bridge, target, high, low }`

## Format 0x0A: Pairing-Time LED (DIFFERENT)

LED configuration sent during pairing uses format 0x0A with type 0x81 (broadcast). This is distinct from runtime LED config (format 0x11).

## Format 0x1A: Scene Config — Fade & Delay (CONFIRMED via RTL-SDR)

Programs per-device fade and delay times for scene recall. Sent as part of the RA3 programming sequence when scenes are transferred to devices.

### Full Packet Layout (53 bytes, RTL-SDR confirmed)

| Bytes | Value | Description |
|-------|-------|-------------|
| 0 | A1/A2/A3 | Type (rotating) |
| 1 | 0x01 | Seq |
| 2-5 | zone LE | Bridge zone |
| 6 | 0x21 | Protocol marker |
| 7 | 0x1A | Format (scene config) |
| 8 | 0x00 | Zero |
| 9-12 | device ID | Target device (big-endian) |
| 13 | 0xFE | Command prefix |
| 14 | 0x06 | Config class |
| 15 | 0x40 | Scene component |
| 16-17 | 0x00 0x00 | Zero |
| 18 | 0x0C | Static |
| 19 | 0x50 | Dimmer marker (0x50) |
| 20-21 | 0xEF 0x20 | Static |
| 22 | 0x00 | Zero |
| 23 | 0x02/0x03 | Packet number (first=0x02, second=0x03) |
| 24 | 0x09 | Static |
| 25 | 0x02 | Static |
| 26-27 | 0xFE 0xFF | Static |
| **28-29** | **uint16 BE** | **Fade time (quarter-seconds)** |
| **30-31** | **uint16 BE** | **Delay time (quarter-seconds)** |
| 32-33 | 0x00 0x00 | Zero |
| 34-50 | 0xCC | CC padding |
| 51-52 | CRC | CRC-16 over bytes 0-50 |

### Encoding

- **Quarter-seconds, uint16 big-endian**: `value = seconds * 4`
- Example: 1 second = 4 = 0x0004 (byte 28=0x00, byte 29=0x04)
- Example: 5 seconds = 20 = 0x0014 (byte 28=0x00, byte 29=0x14)
- Example: 10 seconds = 40 = 0x0028 (byte 30=0x00, byte 31=0x28)
- Max uint16: 65535 qs = 16383.75s ≈ 4.55 hours (Lutron caps at 4 hours in UI)

### Confirmed Values

| Setting | Byte 28-29 | Byte 30-31 |
|---------|-----------|-----------|
| 1s fade, 0s delay | 00 04 | 00 00 |
| 5s fade, 10s delay | 00 14 | 00 28 |
| 0s fade, 10s delay | 00 00 | 00 28 |

### Programming Sequence

The RA3 bridge programs scenes using the following packet sequence:
1. **A1-A3 format 0x1A**: Scene config (fade + delay) — 2 retransmissions only
2. **0x81-0x82 format 0x0A**: LED config (broadcast) — 20 retransmissions
3. **0xC1-0xDF**: Device status/acknowledgment packets
4. **0x82-0x83 format 0x0D**: Scene definition (static preset ID) — 12 retransmissions
5. **0x81-0x83 format 0x0B**: Scene trigger/recall — 12 retransmissions

Format 0x0D (scene definition) payload is STATIC across all fade/delay settings — it only carries the scene/preset identifier, not parameters.

Format 0x0B (scene trigger) bytes 16-18 vary across settings but are NOT direct fade/delay values. They appear to be a scene revision hash/checksum.

### Key Differences from Other Config Formats

| Property | LED/Fade (0x11/0x1C) | Scene (0x1A) |
|----------|---------------------|--------------|
| Byte 15 (component) | 0x50 | 0x40 |
| Retransmissions | 20 | 2 |
| Fade/delay encoding | uint16 LE (format 0x1C) | uint16 BE |
| Packet numbering | Single packet | Two packets (0x02, 0x03) |

### RTL-SDR Reference Captures

```
captures/programming-cca-system-1s-0s.bin  — 1s fade, 0s delay
captures/programming-cca-system-5s-10s.bin — 5s fade, 10s delay
captures/programming-cca-system-0s-10s.bin — 0s fade, 10s delay
captures/programming-cca-system-0s-0s.bin  — 0s fade, 0s delay (missed A3 packet)
```

Decode: `bun run tools/rtlsdr-cca-decode.ts --rate 2000000 captures/programming-cca-system-1s-0s.bin`

## Unsolved: Per-Device Delay vs Scene-Level Delay

The format 0x1A scene config carries fade and delay per-device. However, format 0x1C (default fade rate config) only carries fade-on and fade-off — no delay field. It's unclear whether delay can be configured as a device default separate from scenes, or if delay is exclusively a scene property.
