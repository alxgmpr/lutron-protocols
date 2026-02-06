# Vive Protocol (Clear Connect Type A)

Lutron Vive uses the same CCA radio layer (433.6 MHz, 2-FSK, 62.5 kBaud) as Caseta/RadioRA but with a different addressing model. Pico remotes address devices directly by device ID. Vive hubs address devices by **hub ID + zone ID**, enabling room-level group control.

This document covers the Vive protocol as reverse engineered from RTL-SDR captures and CC1101 hardware logs (2026-02-05 through 2026-02-06).

---

## Universal Dimming Command Class (0x42)

Pico and Vive share a common dimming command class `0x42`, with identical two-phase structure:

### Phase 1: Hold-Start

Initiates a dim operation. Without this, the device ignores subsequent dim steps.

| Field | Pico (format 0x0C) | Vive (format 0x09) |
|-------|--------------------|--------------------|
| Command class | **0x42** | **0x42** |
| Subcommand | **0x00** | **0x00** |
| Next byte | 0x02 | direction |

### Phase 2: Dim Step

The actual dimming command, sent repeatedly for continuous dimming.

| Field | Pico (format 0x0E) | Vive (format 0x0b) |
|-------|--------------------|--------------------|
| Command class | **0x42** | **0x42** |
| Subcommand | **0x02** | **0x02** |
| Next byte | direction | direction |

### Direction Encoding

| Direction | Pico | Vive |
|-----------|------|------|
| Raise | 0x01 | 0x03 |
| Lower | 0x00 | 0x02 |

### Transmission Pattern

| Phase | Pico | Vive |
|-------|------|------|
| Hold-start | 6 packets (format 0x0C) | 6 packets (format 0x09) |
| Dim steps | 10 packets (format 0x0E) | 12 packets (format 0x0b) |

The structural pattern `0x42, 0x00` = "start dim" and `0x42, 0x02` = "step dim" is consistent across both Pico and Vive, suggesting `0x42` is a universal CCA dimming command class. The format bytes and direction values differ, but the two-phase approach is identical.

---

## Vive Addressing

Vive commands use **hub ID** (4 bytes) + **zone ID** (1 byte) instead of device IDs:

```
[type] [seq] [hub_id:4] [proto] [format] ... [zone_id] [0xEF] ...
```

- Hub ID identifies the Vive hub (e.g., `01 7D 53 63`)
- Zone ID identifies the room (e.g., `0x38` = Room 1, `0x46` = Room 2)
- Byte after zone ID is always `0xEF` (constant)

---

## Command Formats

### ON/OFF/Level (format 0x0E)

```
[type] [seq] [hub_id:4] 21 0e 00 00 00 00 [zone] ef 40 02 [level:2] 00 [fade] 00 00 [CRC:2]
```

| Field | Offset | Value |
|-------|--------|-------|
| Protocol | 6 | 0x21 |
| Format | 7 | 0x0E |
| Zone ID | 12 | Room zone |
| Constant | 13 | 0xEF |
| Command class | 14 | 0x40 (on/off/level) |
| Subcommand | 15 | 0x02 |
| Level | 16-17 | 0x0000 (off) to 0xFEFF (100%) |
| Fade time | 19 | Quarter-seconds (0x01=250ms, 0x04=1s, 0x28=10s) |

12 packets per command, type rotates 0x89/0x8A/0x8B, seq increments by 6.

**Arbitrary level setting**: The level field at bytes 16-17 accepts any value in the range `0x0000`-`0xFEFF`, not just the ON/OFF extremes. This enables direct set-level control even though the Vive app only exposes on/off/raise/lower. The level encoding matches the bridge SET_LEVEL format: `level16 = percent * 0xFEFF / 100`.

| Level | Bytes 16-17 |
|-------|-------------|
| OFF (0%) | 0x00 0x00 |
| 25% | 0x3F 0xBF |
| 50% | 0x7F 0x7F |
| 75% | 0xBF 0x3F |
| ON (100%) | 0xFE 0xFF |

**Fade time control**: Byte 19 controls the transition fade time in units of 0.25 seconds (quarter-seconds). Discovered from CC1101 captures of Caseta LEAP commands with different transition times:

| Fade Time | Byte 19 | Notes |
|-----------|---------|-------|
| 250ms | 0x01 | Default (Vive hub default) |
| 1 second | 0x04 | Caseta LEAP `{"CommandType":"GoToLevel","Level":10,"FadeTime":"00:01"}` |
| 5 seconds | 0x14 | |
| 10 seconds | 0x28 | Caseta LEAP `{"CommandType":"GoToLevel","Level":10,"FadeTime":"00:10"}` |

The encoding is: `byte19 = seconds × 4`. This field is shared between Vive and Caseta bridge commands — both use the same format 0x0E with identical fade time encoding at byte 19.

### Hold-Start (format 0x09)

Sent before dim steps to initiate a dimming operation.

```
[type] [seq] [hub_id:4] 21 09 00 00 00 00 [zone] ef 42 00 [dir] cc cc cc cc cc [CRC:2]
```

| Field | Offset | Value |
|-------|--------|-------|
| Format | 7 | 0x09 |
| Zone ID | 12 | Room zone |
| Command class | 14 | 0x42 (dim) |
| Subcommand | 15 | 0x00 (hold-start) |
| Direction | 16 | 0x03=raise, 0x02=lower |

6 packets, type rotates 0x89/0x8A/0x8B.

### Dim Step (format 0x0b)

Sent after hold-start for actual dimming.

```
[type] [seq] [hub_id:4] 21 0b 00 00 00 00 [zone] ef 42 02 [dir] 00 00 cc cc cc [CRC:2]
```

| Field | Offset | Value |
|-------|--------|-------|
| Format | 7 | 0x0B |
| Zone ID | 12 | Room zone |
| Command class | 14 | 0x42 (dim) |
| Subcommand | 15 | 0x02 (step) |
| Direction | 16 | 0x03=raise, 0x02=lower |

12 packets, type rotates 0x89/0x8A/0x8B.

---

## Pairing Protocol

All pairing packets are **53 bytes** (51 data + 2 CRC) with 0xCC padding.

### Packet Flow

| Phase | Packet | Direction | Description |
|-------|--------|-----------|-------------|
| 1 | B9 (fmt 0x11) timer=0x3C | Hub -> All | Beacon: "pairing mode active" |
| 2 | B8 (fmt 0x23) | Device -> Hub | Device requests to pair |
| 3 | BA (fmt 0x10) | Hub -> Device | Accept: hub recognizes device |
| 3b | 87,8D,93,9F,AB,B1 (fmt 0x10) | Hub -> Device | Accept retransmissions (no-seq format) |
| 4 | AB,A9,AA,8D,93 (fmt 0x13) | Hub -> Device | Dimming capability config |
| 5 | A9,9F,AB,B7,BD (fmt 0x28) | Hub -> Device | Zone assignment config |
| - | B8 | Device -> Hub | Device retry (normal during config) |
| 6 | AB,A9,AA,8D,93 (fmt 0x14) | Hub -> Device | Function mapping config |
| 7 | AB,A9,AA,9F,B7 (fmt 0x28) | Hub -> Device | Zone assignment config (repeat) |
| 8 | A9,8D,93,9F,AB,B7,BD,C3 (fmt 0x12) | Hub -> Device | Final config with zone at byte 24 |
| - | B8 | Device -> Hub | Device confirmation (pairing success) |
| 9 | B9 (fmt 0x11) timer=0x00 | Hub -> All | Beacon: "pairing mode ended" |

The device sends B8 retries **throughout** the config phase until it receives all packets. Absence of B8 retries during config = device didn't receive the packets.

### Config Packet Formats

#### Beacon (B9, format 0x11)

```
b9 [seq] [hub:4] 21 11 00 ff ff ff ff ff 60 00 [hub:4] ff ff ff ff [timer] cc...cc [CRC:2]
```

- `timer` = 0x3C (active) or 0x00 (stop)
- Broadcast to all devices (FF FF FF FF FF)
- Seq increments by 8, wraps at 0x48

#### Accept (BA, format 0x10)

```
ba [seq] [hub:4] 21 10 00 [device:4] fe 60 0a [hub:4] [hub:4] cc...cc [CRC:2]
```

Retransmissions use no-seq format (hub ID starts at byte 1 instead of byte 2):

```
87 [hub:4] 21 10 00 [device:4] fe 60 0a [hub:4] [hub:4] cc...cc [CRC:2]
```

Type bytes for accept retransmissions: 87, 8D, 93, 9F, AB, B1.

#### Dimming Config (format 0x13) - Dimmers Only

```
[type] [seq] [hub:4] 21 13 00 [device:4] fe 06 50 00 0d 08 02 0f 03 [device:4] 00 cc...cc [CRC:2]
```

- Device ID appears **twice** (bytes 9-12 and 22-25)
- Required for dimmers; not sent for relay devices
- Without this, device only responds to ON/OFF, not raise/lower

#### Function Mapping (format 0x14)

```
[type] [seq] [hub:4] 21 14 00 [device:4] fe 06 50 00 0b 09 fe ff 00 [cap] 00 cc...cc [CRC:2]
```

- Byte 22 (`cap`): 0x02 for dimmers, 0x00 for relays

#### Zone Assignment (format 0x28)

```
[type] [seq] [hub:4] 28 03 01 [devtype] [ref] 21 1a 00 [device:4] fe 06 40 00 00 00 01 ef 20 00 03 09 2b [varies] ff [varies] 00 00 b4 00 00 cc...cc [CRC:2]
```

| Field | Offset | Description |
|-------|--------|-------------|
| Device type | 9 | 0x50 (dimmer), 0x38 (relay) |
| Zone ref | 10 | `zone_id + 0x23` (non-critical) |
| Device ID | 14-17 | Target device |

#### Final Config (format 0x12)

```
[type] [seq] [hub:4] 21 12 00 [device:4] fe 06 6e 01 00 07 00 02 00 00 00 [zone] ef cc...cc [CRC:2]
```

- **Zone ID at byte 24** - this is the authoritative zone assignment
- Byte 25 always 0xEF
- Retransmitted with types: A9, 8D, 93, 9F, AB, B7, BD, C3

### Retransmission Strategy

Each config format is sent with **5+ different type bytes** (e.g., AB, A9, AA, 8D, 93). This is critical - sending only 1-2 retransmissions results in the device not receiving the config and not sending B8 confirmations.

---

## FCJS-010 Dimmer-Specific Config

The FCJS-010 (0-10V dimmer) requires different config values than relay devices:

| Field | Relay | Dimmer (FCJS-010) | Location |
|-------|-------|-------------------|----------|
| Format 0x28 byte 9 | 0x38 | 0x50 | Device type indicator |
| Format 0x14 byte 22 | 0x00 | 0x02 | Dimmer capability flag |
| Format 0x13 | Not sent | Required (53 bytes) | Dimming capability config |
| ON/OFF byte 19 | 0x00 | 0x01 | Command variant |

---

## Key Protocol Facts

- **B9** = Beacon (format 0x11, broadcast) - NOT BA
- **BA** = Accept (format 0x10, directed to device)
- All pairing packets are **53 bytes** (51 data + 2 CRC) with 0xCC padding
- Zone commands use zone ID in byte 12, constant 0xEF in byte 13
- Command class 0x40 = on/off, 0x42 = dimming (shared with Pico)
- Sequence increments by 8 for beacons, 6 for commands
- Type byte rotates (89/8A/8B for commands, various for config retransmissions)
- Format 0x28 byte 10 (`zone_id + 0x23`) is non-critical; format 0x12 byte 24 is authoritative

---

## RTL-SDR Verification

CC1101 hardware RX logs **truncate packets** in variable-length mode. Always verify protocol with RTL-SDR captures of real hardware to see the true over-the-air packet length.

```bash
# Capture (2 MHz sample rate = 32 samples/bit for best results)
rtl_sdr -f 433602844 -s 2000000 -g 40 capture.bin

# Decode
bun run tools/rtlsdr-cca-decode.ts --rate 2000000 capture.bin
```

The decoder supports multi-retransmission decoding (finds all ~12 retransmissions per burst), deduplication, and CRC verification. Typical result: 50+ CRC OK packets per capture session.

---

## Debugging History

### Issue 1: Zone ID Not Propagated (2026-02-05)

`start_vive_pairing()` didn't accept a `zone_id` parameter. The auto-accept always defaulted to zone 0x38. Fixed by adding `zone_id` param and storing it as `vive_zone_id_` member.

### Issue 2: Config Packets Too Short (2026-02-06)

Multiple config packets were the wrong length:

| Packet | Was | Fixed To |
|--------|-----|----------|
| Format 0x14 (function mapping) | 26 bytes, memset 0x00 | 53 bytes, memset 0xCC |
| No-seq accept retransmissions | 36 bytes | 53 bytes |
| Format 0x13 (dimming config) | 24 bytes | 53 bytes |
| Format 0x28 A9 (zone assignment) | 26 bytes | 53 bytes |

The CC1101 log showed truncated versions that appeared complete. Only RTL-SDR captures at 2 MHz revealed the true 53-byte OTA length.

### Issue 3: Raise/Lower Ignored (2026-02-06)

Two causes:
1. **Missing hold-start (format 0x09)**: Device requires hold-start before it accepts dim step packets. Without it, dim steps are silently ignored.
2. **Incomplete format 0x14**: The 26-byte version didn't register the device's dimming capability.

---

## Usage

```bash
# Pair device to zone (via UDP JSON)
{"cmd": "vive_start", "hub_id": "0xYYYYYYYY", "zone_id": 70}

# Via Home Assistant service
service: esphome.cca_proxy_start_vive_pairing
data:
  hub_id: "0xYYYYYYYY"
  zone_id: 70

# Control
{"cmd": "vive_on",    "hub_id": "0xYYYYYYYY", "zone_id": 70}
{"cmd": "vive_off",   "hub_id": "0xYYYYYYYY", "zone_id": 70}
{"cmd": "vive_raise", "hub_id": "0xYYYYYYYY", "zone_id": 70}
{"cmd": "vive_lower", "hub_id": "0xYYYYYYYY", "zone_id": 70}
{"cmd": "vive_level", "hub_id": "0xYYYYYYYY", "zone_id": 70, "level": 50}
```

---

## Reference Captures

| File | Description |
|------|-------------|
| `captures/vive-sessions/real-pairing.bin` | Real Vive hub pairing Room 1 (zone 0x38) |
| `captures/vive-sessions/toggling.bin` | Real Vive hub zone toggling |
| `captures/2mhz-fcjs-pairing-1.bin` | Real hub pairing FCJS-010 at 2 MHz (54 CRC OK) |
| `captures/esp-pairing-and-toggling-room-2.bin` | ESP32 pairing + control Room 2 |
| `captures/esp-pairing-and-toggling-room-3.bin` | ESP32 pairing + control Room 3 |
| `captures/esp-pairing-and-toggling-room-4.bin` | ESP32 pairing + control Room 4 |
