# Lutron Bridge-Style Level Commands

## Overview

The Lutron Caseta bridge uses a different packet format than Pico remotes to send absolute level (brightness) commands to dimmers.

## Packet Structure

Based on capture of bridge setting levels via iPhone app:

```
Byte  Value       Description
----  ----------  -----------
0     0x81-0x83   Packet type (increments between commands)
1     seq         Sequence number
2-5   device_id   Target device ID (e.g., AF902C00)
6     0x21        Protocol constant
7     0x0E        Long format indicator
8     0x00        (differs from Pico's 0x03)
9     0x07        Command type (level set command)
10    0x03        Sub-command type
11-14 C3C6FE40    Unknown constants (possibly zone/group ID)
15    0x02        Unknown flag
16-17 LEVEL       16-bit brightness level (big-endian)
18    0x00        Unknown
19    0x01        Unknown
20-21 0x00 0x00   Unknown
22-23 CRC         CRC-16 (polynomial 0xCA0F)
```

## Level Encoding

Brightness is encoded as a 16-bit big-endian value in bytes 16-17:
- `0x0000` = 0%
- `0xFFFF` = 100%

Formula: `level_hex = (percent / 100) * 65535`

### Captured Values

| Set Level | Bytes 16-17 | Hex Value | Calculated % |
|-----------|-------------|-----------|--------------|
| 22% | 36 18 | 0x3618 | 21.1% |
| 82% | D5 C9 | 0xD5C9 | 83.5% |
| 48% | 79 10 | 0x7910 | 47.3% |

### Level Encoding Details

**IMPORTANT:** 0xFFFF is reserved/invalid. The bridge uses **0xFEFF** for 100%.

| Target % | Hex Value | Bytes 16-17 | Notes |
|----------|-----------|-------------|-------|
| 0% | 0x0000 | 00 00 | |
| 25% | 0x3FBF | 3F BF | |
| 50% | 0x7F7F | 7F 7F | |
| 75% | 0xBF3F | BF 3F | |
| 100% | 0xFEFF | FE FF | NOT 0xFFFF! |

Formula: `level_hex = (percent / 100) * 65279` (with 100% = 0xFEFF special case)

## Test Results

| Level | Working? | Notes |
|-------|----------|-------|
| 0% | ✅ Yes | Light turns off |
| 25% | ✅ Yes | Dims to ~25% |
| 50% | ✅ Yes | Dims to ~50% |
| 75% | ✅ Yes | Dims to ~75% |
| 100% | ✅ Yes | Uses 0xFEFF (confirmed from bridge capture) |

### 100% Level Discovery

Initially 100% (0xFFFF) did not work. Captured bridge sending 100% from app and discovered:
- Bridge uses **0xFEFF** (65279) for 100%, not 0xFFFF (65535)
- 0xFFFF appears to be reserved or treated as invalid by the protocol

## Device Addressing

The device ID in the bridge packets (AF902C00) appears to be the **target dimmer's address**, not the bridge's address.

This is different from Pico packets where the device ID is the **source** (the Pico remote itself).

## Unknown Bytes 11-14

The constant bytes `C3 C6 FE 40` in positions 11-14 were consistent across all captured bridge packets. These may represent:
- Zone or room identifier
- Group assignment
- Integration ID from Lutron system

If level commands don't work for a different dimmer, these bytes may need to be discovered for that specific device.

## Differences from Pico Protocol

| Feature | Pico | Bridge |
|---------|------|--------|
| Packet types | 0x88-0x8B | 0x81-0x83 |
| Byte 8 | 0x03 | 0x00 |
| Byte 9 | 0x00 | 0x07 |
| Purpose | Button press | Absolute level |
| Addressing | Source device | Target device |
