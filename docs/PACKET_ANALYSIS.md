# Lutron Pico Packet Analysis

Based on comprehensive captures from real Pico remote (Device ID: `05851117`)

## Two Packet Formats

Each button press transmits **both** short and long format packets in sequence:
1. Short format packets first (~5 packets)
2. Long format packets after (~5-9 packets)

### Short Format (Types 0x88, 0x8A)

```
Byte:  0    1    2    3    4    5    6    7    8    9   10   11   12-21    22-23
     [Type][Seq][-------Device ID------][0x21][0x04][0x03][0x00][Btn][0x00][CC pad][CRC]
```

Example (ON button): `88 00 05 85 11 17 21 04 03 00 02 00 CC CC CC CC CC CC CC CC CC CC 1A 38`

### Long Format (Types 0x89, 0x8B)

```
Byte:  0    1    2    3    4    5    6    7    8    9   10   11   12-15        16   17   18   19   20   21   22-23
     [Type][Seq][-------Device ID------][0x21][0x0E][0x03][0x00][Btn][0x01][DevID repeat][0x00][Fl1][Fl2][Fl3][Fl4][Fl5][CRC]
```

Example (ON button): `89 12 05 85 11 17 21 0E 03 00 02 01 05 85 11 17 00 40 00 20 00 00 41 9C`

## Field Definitions

| Byte | Short | Long | Description |
|------|-------|------|-------------|
| 0 | Type | Type | 0x88/0x8A (short) or 0x89/0x8B (long) |
| 1 | Seq | Seq | Sequence counter (complex pattern, NOT simple increment) |
| 2-5 | DevID | DevID | Device ID (4 bytes, LSB first) |
| 6 | 0x21 | 0x21 | Protocol constant |
| 7 | 0x04 | 0x0E | Format indicator (0x04=short, 0x0E=long) |
| 8 | 0x03 | 0x03 | Protocol constant |
| 9 | 0x00 | 0x00 | Protocol constant |
| 10 | Button | Button | Button code |
| 11 | 0x00 | 0x01 | Format flag (0x00=short, 0x01=long) |
| 12-15 | 0xCC | DevID | Padding (short) or Device ID repeat (long) |
| 16 | 0xCC | 0x00 | Padding (short) or zero (long) |
| 17 | 0xCC | Flags | Padding (short) or 0x40/0x42 (long) |
| 18 | 0xCC | Flags | Padding (short) or 0x00/0x02 (long) |
| 19 | 0xCC | BtnFlag | Padding (short) or button-related (long) |
| 20-21 | 0xCC | Extra | Padding (short) or 0x00,0x00 or 0x00,0x16 (long) |
| 22-23 | CRC | CRC | CRC-16 (polynomial 0xCA0F) |

## Button Codes

| Button | Code | Short byte 7 | Long format bytes 17-21 |
|--------|------|--------------|------------------------|
| ON | 0x02 | 0x04 | `40 00 20 00 00` |
| FAVORITE | 0x03 | 0x04 | `40 00 21 00 00` |
| OFF | 0x04 | 0x04 | `40 00 22 00 00` |
| RAISE | 0x05 | 0x0C | `42 02 01 00 16` |
| LOWER | 0x06 | 0x0C | `42 02 00 00 43` |

### Three Packet Format Types

**Standard Short (byte 7 = 0x04):** ON, OFF, FAVORITE
- Bytes 12-21: 0xCC padding

**Medium Short (byte 7 = 0x0C):** RAISE, LOWER (dimming buttons)
- Bytes 12-15: Device ID repeated
- Byte 16: 0x00
- Bytes 17-19: `42 00 02`
- Bytes 20-21: 0xCC padding

**Long (byte 7 = 0x0E):** All buttons
- Full extended format with device ID and button-specific flags

### Long Format Extended Bytes Pattern

For ON/OFF/FAVORITE buttons:
- Byte 17: `0x40`
- Byte 18: `0x00`
- Byte 19: `0x1E + button_code` (ON=0x20, FAVORITE=0x21, OFF=0x22)
- Bytes 20-21: `0x00 0x00`

For RAISE button:
- Byte 17: `0x42`
- Byte 18: `0x02`
- Byte 19: `0x01`
- Bytes 20-21: `0x00 0x16`

For LOWER button:
- Byte 17: `0x42`
- Byte 18: `0x02`
- Byte 19: `0x00`
- Bytes 20-21: `0x00 0x43` (byte 21 may vary: 0x43, 0x2D observed)

## Packet Type System

| Type | Format | Bit Pattern | Notes |
|------|--------|-------------|-------|
| 0x88 | Short | 1000 1000 | Group A, Short |
| 0x89 | Long | 1000 1001 | Group A, Long |
| 0x8A | Short | 1000 1010 | Group B, Short |
| 0x8B | Long | 1000 1011 | Group B, Long |

**Pattern:**
- Bit 0: Format (0=Short, 1=Long)
- Bit 1: Group (0=A, 1=B)
- Groups A and B alternate between button presses

**Observed sequence:**
1. First ON press: Types 0x88/0x89 (Group A)
2. First OFF press: Types 0x8A/0x8B (Group B)
3. Next button: Back to Group A
4. And so on...

## Transmission Sequence

Real Pico transmission for a single button press:

1. Short format packets (type 0x88 or 0x8A):
   - ~5 packets
   - Sequence increments by 2 between packets
   - ~70ms delay between packets

2. Long format packets (type 0x89 or 0x8B):
   - ~5-9 packets
   - Sequence increments by 6 between packets
   - ~70ms delay between packets

## Sequence Number Analysis

The sequence number does NOT follow a simple increment. Observed patterns from comprehensive capture:

**ON button sequences:** `0x00, 0x02, 0x06, 0x08, 0x0C, 0x12, 0x1E, 0x24, 0x2A, 0xAC, 0xB2, 0x36, 0x3C, 0x42`

**Sequence deltas:** Not constant - values like 2, 4, 6, 12, 130, 132 observed

The sequence may be:
- A rolling code with pseudo-random jumps
- An LFSR-based counter
- Time-dependent in some way

## RF Parameters

- Frequency: 433.602844 MHz
- Modulation: GFSK (real Pico) / 2-FSK works for TX
- Data rate: 62.5 kBaud
- Deviation: ~41 kHz
- Encoding: Async serial N81 (start bit + 8 data LSB-first + stop bit)
- Preamble: 32 bits alternating starting with 1 (10101010...)
- Sync: 0xFF byte (N81 encoded)
- Prefix: 0xFA 0xDE bytes (N81 encoded)

## CRC Calculation

CRC-16 with polynomial 0xCA0F:
- Calculated over bytes 0-21 (22 bytes)
- Stored big-endian in bytes 22-23

## Implementation Notes

For CC1101 transmission:
1. Send both short AND long format packets
2. Alternate type groups (A/B) between button presses
3. Use appropriate extended bytes based on button type
4. Real sequence number pattern may not matter if receiver only checks validity

## Open Questions

1. ~~What determines type 0x88/0x8A vs 0x89/0x8B selection?~~ **SOLVED**: Bit 0 = format, Bit 1 = alternating group
2. Is the sequence a rolling code or simpler counter? **Partially understood**: Complex pattern, not simple counter
3. Does the receiver require both formats or just one? **Testing needed**
4. What is the exact meaning of bytes 17-21 in long format? **Partially understood**: Button-type dependent flags
