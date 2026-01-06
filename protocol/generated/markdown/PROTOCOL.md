# Lutron Clear Connect Type A

**Version:** 1.0.0  
**Auto-generated from:** `protocol/cca.yaml`  
**DO NOT EDIT** - regenerate with: `cca codegen`

RF protocol for RadioRA3, Homeworks QSX, Caseta Pro

## Table of Contents

- [RF Parameters](#rf-parameters)
- [Packet Framing](#packet-framing)
- [CRC Configuration](#crc-configuration)
- [Timing](#timing)
- [Enumerations](#enumerations)
- [Packet Types](#packet-types)
- [Transmission Sequences](#transmission-sequences)

## RF Parameters

| Parameter | Value |
|-----------|-------|
| Frequency | 433602844 Hz (433.603 MHz) |
| Deviation | 41200 Hz (41.2 kHz) |
| Baud Rate | 62484.7 bps |
| Modulation | 2-FSK |
| Encoding | N81 |

## Packet Framing

| Parameter | Value |
|-----------|-------|
| Preamble | 32 bits of `0xAAAAAAAA` |
| Sync Byte | `0xFF` |
| Prefix | `FA DE` |
| Trailing | 16 bits |

## CRC Configuration

| Parameter | Value |
|-----------|-------|
| Polynomial | `0xCA0F` |
| Width | 16 bits |
| Initial | `0x0000` |
| Byte Order | big_endian |

## Timing

| Event | Interval |
|-------|----------|
| Button Repeat | 70 ms |
| Beacon | 65 ms |
| Pairing | 75 ms |
| Level Report | 60 ms |
| Unpair | 60 ms |
| LED Config | 75 ms |

### Sequence Numbers

- **Increment:** 6 per transmission
- **Wrap:** at `0x48` (72)

## Enumerations

### Action

Button action codes

| Name | Value | Description |
|------|-------|-------------|
| HOLD | `0x02` | Continuous hold for dimming |
| PRESS | `0x00` | - |
| RELEASE | `0x01` | - |
| SAVE | `0x03` | Save favorite/scene |

### Button

Button code values

| Name | Value | Description |
|------|-------|-------------|
| FAVORITE | `0x03` | 5-button FAV / middle |
| LOWER | `0x06` | 5-button LOWER |
| OFF | `0x04` | 5-button OFF / bottom |
| ON | `0x02` | 5-button ON / top |
| RAISE | `0x05` | 5-button RAISE |
| RESET | `0xFF` | Reset/unpair |
| SCENE1 | `0x0B` | 4-button top |
| SCENE2 | `0x0A` | 4-button second |
| SCENE3 | `0x09` | 4-button third |
| SCENE4 | `0x08` | 4-button bottom |

### Category

Packet categories for filtering

| Name | Value | Description |
|------|-------|-------------|

### Device Class

Device class codes (byte 28 in pairing)

| Name | Value | Description |
|------|-------|-------------|
| DIMMER | `0x04` | - |
| FAN | `0x06` | - |
| KEYPAD | `0x0B` | - |
| SHADE | `0x0A` | - |
| SWITCH | `0x05` | - |

## Packet Types

### Summary

| Type | Code | Length | Category | Description |
|------|------|--------|----------|-------------|
| BEACON | `0x91` | 24 | BEACON | Pairing beacon |
| BEACON_92 | `0x92` | 24 | BEACON | Beacon stop |
| BEACON_93 | `0x93` | 24 | BEACON | Beacon variant |
| BTN_LONG_A | `0x89` | 24 | BUTTON | Button press, long format, group A |
| BTN_LONG_B | `0x8B` | 24 | BUTTON | Button press, long format, group B |
| BTN_SHORT_A | `0x88` | 24 | BUTTON | Button press, short format, group A |
| BTN_SHORT_B | `0x8A` | 24 | BUTTON | Button press, short format, group B |
| LED_CONFIG | `0xF2` | 24 | CONFIG | LED configuration (derived from STATE_RPT format 0x0A) |
| PAIR_B0 | `0xB0` | 53 | PAIRING | Device announcement |
| PAIR_B8 | `0xB8` | 53 | PAIRING | Scene Pico pairing (bridge-only) |
| PAIR_B9 | `0xB9` | 53 | PAIRING | Direct-pair Pico pairing |
| PAIR_BA | `0xBA` | 53 | PAIRING | Scene Pico pairing variant |
| PAIR_BB | `0xBB` | 53 | PAIRING | Direct-pair Pico pairing variant |
| PAIR_RESP_C0 | `0xC0` | 24 | HANDSHAKE | Pairing response |
| PAIR_RESP_C1 | `0xC1` | 24 | HANDSHAKE | Pairing response phase 1 |
| PAIR_RESP_C2 | `0xC2` | 24 | HANDSHAKE | Pairing response phase 2 |
| PAIR_RESP_C8 | `0xC8` | 24 | HANDSHAKE | Pairing acknowledgment |
| SET_LEVEL | `0xA2` | 24 | CONFIG | Set level command |
| STATE_RPT_81 | `0x81` | 24 | STATE | State report (type 81) |
| STATE_RPT_82 | `0x82` | 24 | STATE | State report (type 82) |
| STATE_RPT_83 | `0x83` | 24 | STATE | State report (type 83) |
| UNPAIR | `0xF0` | 24 | CONFIG | Unpair command (derived from STATE_RPT format 0x0C) |
| UNPAIR_PREP | `0xF1` | 24 | CONFIG | Unpair preparation (derived from STATE_RPT format 0x09) |

### BEACON (`0x91`)

Pairing beacon

- **Length:** 24 bytes
- **Category:** BEACON
- **Device ID:** Big-endian

#### Fields

| Offset | Size | Field | Format | Description |
|--------|------|-------|--------|-------------|
| 0 | 1 | type | hex | - |
| 1 | 1 | sequence | decimal | - |
| 2 | 4 | load_id | device_id_be | - |
| 6 | 1 | protocol | hex | - |
| 7 | 1 | format | hex | - |
| 8 | 5 | fixed | hex | - |
| 13 | 9 | broadcast | hex | - |
| 22 | 2 | crc | hex | - |

### BTN_LONG_A (`0x89`)

Button press, long format, group A

- **Length:** 24 bytes
- **Category:** BUTTON
- **Device ID:** Big-endian

#### Fields

| Offset | Size | Field | Format | Description |
|--------|------|-------|--------|-------------|
| 0 | 1 | type | hex | - |
| 1 | 1 | sequence | decimal | - |
| 2 | 4 | device_id | device_id_be | - |
| 6 | 1 | protocol | hex | - |
| 7 | 1 | format | hex | 0x0E for long |
| 8 | 2 | fixed | hex | - |
| 10 | 1 | button | button | - |
| 11 | 1 | action | action | - |
| 12 | 4 | device_repeat | device_id_be | - |
| 16 | 6 | button_data | hex | - |
| 22 | 2 | crc | hex | - |

### BTN_SHORT_A (`0x88`)

Button press, short format, group A

- **Length:** 24 bytes
- **Category:** BUTTON
- **Device ID:** Big-endian

#### Fields

| Offset | Size | Field | Format | Description |
|--------|------|-------|--------|-------------|
| 0 | 1 | type | hex | - |
| 1 | 1 | sequence | decimal | - |
| 2 | 4 | device_id | device_id_be | - |
| 6 | 1 | protocol | hex | Always 0x21 |
| 7 | 1 | format | hex | 0x04 for short |
| 8 | 2 | fixed | hex | - |
| 10 | 1 | button | button | - |
| 11 | 1 | action | action | - |
| 12 | 10 | padding | hex | - |
| 22 | 2 | crc | hex | - |

### PAIR_B0 (`0xB0`)

Device announcement

- **Length:** 53 bytes
- **Category:** PAIRING
- **Device ID:** Big-endian

#### Fields

| Offset | Size | Field | Format | Description |
|--------|------|-------|--------|-------------|
| 0 | 1 | type | hex | - |
| 1 | 1 | sequence | decimal | - |
| 2 | 4 | device_id | device_id_be | - |
| 6 | 1 | protocol | hex | - |
| 7 | 1 | format | hex | - |
| 8 | 43 | data | hex | - |
| 51 | 2 | crc | hex | - |

### PAIR_B8 (`0xB8`)

Scene Pico pairing (bridge-only)

- **Length:** 53 bytes
- **Category:** PAIRING
- **Device ID:** Big-endian

#### Fields

| Offset | Size | Field | Format | Description |
|--------|------|-------|--------|-------------|
| 0 | 1 | type | hex | - |
| 1 | 1 | sequence | decimal | - |
| 2 | 4 | device_id | device_id_be | - |
| 6 | 1 | protocol | hex | - |
| 7 | 1 | format | hex | - |
| 8 | 2 | fixed | hex | - |
| 10 | 1 | btn_scheme | hex | Button scheme byte |
| 11 | 2 | fixed2 | hex | - |
| 13 | 5 | broadcast | hex | - |
| 18 | 2 | fixed3 | hex | - |
| 20 | 4 | device_id2 | device_id_be | - |
| 24 | 4 | device_id3 | device_id_be | - |
| 28 | 1 | device_class | hex | - |
| 29 | 1 | device_sub | hex | - |
| 30 | 11 | caps | hex | - |
| 41 | 4 | broadcast2 | hex | - |
| 45 | 6 | padding | hex | - |
| 51 | 2 | crc | hex | - |

### PAIR_RESP_C0 (`0xC0`)

Pairing response

- **Length:** 24 bytes
- **Category:** HANDSHAKE
- **Device ID:** Big-endian

#### Fields

| Offset | Size | Field | Format | Description |
|--------|------|-------|--------|-------------|
| 0 | 1 | type | hex | - |
| 1 | 1 | sequence | decimal | - |
| 2 | 4 | device_id | device_id_be | - |
| 6 | 1 | protocol | hex | - |
| 7 | 1 | format | hex | - |
| 8 | 14 | data | hex | - |
| 22 | 2 | crc | hex | - |

### SET_LEVEL (`0xA2`)

Set level command

- **Length:** 24 bytes
- **Category:** CONFIG
- **Device ID:** little

#### Fields

| Offset | Size | Field | Format | Description |
|--------|------|-------|--------|-------------|
| 0 | 1 | type | hex | - |
| 1 | 1 | sequence | decimal | - |
| 2 | 4 | source_id | device_id | - |
| 6 | 1 | protocol | hex | - |
| 7 | 1 | format | hex | - |
| 8 | 1 | fixed | hex | - |
| 9 | 4 | target_id | device_id_be | - |
| 13 | 3 | fixed2 | hex | - |
| 16 | 2 | level | level_16bit | - |
| 18 | 4 | padding | hex | - |
| 22 | 2 | crc | hex | - |

### STATE_RPT_81 (`0x81`)

State report (type 81)

- **Length:** 24 bytes
- **Category:** STATE
- **Device ID:** little

#### Fields

| Offset | Size | Field | Format | Description |
|--------|------|-------|--------|-------------|
| 0 | 1 | type | hex | - |
| 1 | 1 | sequence | decimal | - |
| 2 | 4 | device_id | device_id | - |
| 6 | 1 | protocol | hex | - |
| 7 | 1 | format | hex | - |
| 8 | 3 | fixed | hex | - |
| 11 | 1 | level | level_byte | - |
| 12 | 10 | padding | hex | - |
| 22 | 2 | crc | hex | - |

### UNPAIR (`0xF0`)

Unpair command (derived from STATE_RPT format 0x0C)

- **Length:** 24 bytes
- **Category:** CONFIG
- **Device ID:** little

#### Fields

| Offset | Size | Field | Format | Description |
|--------|------|-------|--------|-------------|
| 0 | 1 | type | hex | - |
| 1 | 1 | sequence | decimal | - |
| 2 | 4 | source_id | device_id | - |
| 6 | 1 | protocol | hex | - |
| 7 | 1 | format | hex | 0x0C for unpair |
| 8 | 3 | fixed | hex | - |
| 11 | 5 | command | hex | - |
| 16 | 4 | target_id | device_id_be | - |
| 20 | 2 | padding | hex | - |
| 22 | 2 | crc | hex | - |

## Transmission Sequences

### Button Hold

Dimming hold (raise/lower)

**Parameters:**

- `device_id`: `u32`
- `button`: `button`

**Steps:**

| Step | Packet | Count | Interval |
|------|--------|-------|----------|
| 1 | BTN_SHORT_A | infinite | 65 ms |

**Note:** This sequence runs until explicitly stopped.

### Button Press

Standard 5-button Pico press

**Parameters:**

- `device_id`: `u32`
- `button`: `button`

**Steps:**

| Step | Packet | Count | Interval |
|------|--------|-------|----------|
| 1 | BTN_SHORT_A | 3 | 70 ms |
| 2 | BTN_LONG_A | 1 | 70 ms |

**Total:** 4 packets, ~280 ms

### Button Release

Button release (sent after press)

**Parameters:**

- `device_id`: `u32`
- `button`: `button`

**Steps:**

| Step | Packet | Count | Interval |
|------|--------|-------|----------|
| 1 | BTN_SHORT_B | 3 | 70 ms |
| 2 | BTN_LONG_B | 1 | 70 ms |

**Total:** 4 packets, ~280 ms

### Pairing Beacon

Pairing beacon broadcast

**Parameters:**

- `subnet`: `u16`

**Steps:**

| Step | Packet | Count | Interval |
|------|--------|-------|----------|
| 1 | BEACON | infinite | 65 ms |

**Note:** This sequence runs until explicitly stopped.

### Pico Pairing

Pico pairing announcement

**Parameters:**

- `device_id`: `u32`
- `pico_type`: `str` - 5btn, 4btn-scene, 4btn-rl, 2btn

**Steps:**

| Step | Packet | Count | Interval |
|------|--------|-------|----------|
| 1 | PAIR_B9 | 15 | 75 ms |

**Total:** 15 packets, ~1125 ms

### Set Level

Set dimmer level

**Parameters:**

- `source_id`: `u32`
- `target_id`: `u32`
- `level`: `u8` - 0-100%

**Steps:**

| Step | Packet | Count | Interval |
|------|--------|-------|----------|
| 1 | SET_LEVEL | 20 | 60 ms |

**Total:** 20 packets, ~1200 ms

### Unpair

Unpair device from bridge

**Parameters:**

- `source_id`: `u32`
- `target_id`: `u32`

**Steps:**

| Step | Packet | Count | Interval |
|------|--------|-------|----------|
| 1 | UNPAIR | 20 | 60 ms |

**Total:** 20 packets, ~1200 ms

