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

## Format 0x15: Trim/Phase Configuration (PARTIALLY CONFIRMED)

Sets high/low trim levels and forward/reverse phase for dimmers.

| Bytes | Value | Description |
|-------|-------|-------------|
| 13+ | TBD | Trim/phase data |

Uses the same 53-byte structure with CC padding and CRC.

## Format 0x0A: Pairing-Time LED (DIFFERENT)

LED configuration sent during pairing uses format 0x0A with type 0x81 (broadcast). This is distinct from runtime LED config (format 0x11).

## Unsolved: Delay Configuration

### Evidence That Delay Exists

RA3 scenes support per-command fade and delay. CCA captures of RA3 scene triggers (format 0x0b) show **identical packets** regardless of fade/delay settings:

```
2s fade, 5s delay:  83 01 a1 82 d7 00 21 0b 00 00 00 0c 50 ef 40 00 20 00 00 cc cc cc
4s fade, 10s delay: 81 99 a1 82 d7 00 21 0b 00 00 00 0c 50 ef 40 00 20 00 00 cc cc cc
                    ^^                                                         (only type/seq differ)
```

This proves format 0x0b is a **trigger-only** command ("go to stored preset"). Fade and delay parameters are pre-programmed on the device via configuration packets.

### What We've Tested

| Position | Result |
|----------|--------|
| Bytes 24, 26 (interleaved with fade) | Device reads bytes 23-24 as uint16 LE, corrupting fade value |
| Bytes 27-30 (after fade values) | Device ignores entirely, no effect |

### Where Delay Might Live

1. **Different config format** - Not format 0x1C. Maybe a separate format byte for delay config.
2. **"Static" bytes 17-22** - Currently hardcoded from capture. Byte 17=0x03 might indicate "number of parameters" or "config subtype". Changing this might unlock delay fields.
3. **Per-command (format 0x0E)** - Bytes 20-21 in SET_LEVEL packets are always 0x00. These could carry per-command delay, separate from stored config.

### Observations About Format 0x0b (RA3 Scene Trigger)

```
83 01 a1 82 d7 00 21 0b 00 00 00 0c 50 ef 40 00 20 00 00 cc cc cc ef cb
```

Known: 100% level, 2s fade, 5s delay. Key non-zero bytes:
- Byte 12: 0x50 (80 decimal)
- Byte 14: 0x40 (64 decimal)
- Byte 16: 0x20 (32 decimal)

The ratio 0x50/0x20 = 80/32 = 2.5 matches delay/fade = 5/2 = 2.5. If encoding is 1/16-second: byte 16 = 32/16 = 2s (fade), byte 12 = 80/16 = 5s (delay). However, this hypothesis needs a second data point with different values to confirm. The one comparison we have (4s/10s) showed identical packets, suggesting these bytes are NOT fade/delay but rather device/component addressing.

### 4-Hour Limit Observation

Lutron imposes a 4-hour maximum on fade/delay in RA3. This aligns with uint16 quarter-seconds: max 65535 * 0.25 = 16383.75s = ~4.55 hours. The 4-hour cap fits comfortably within this range.
