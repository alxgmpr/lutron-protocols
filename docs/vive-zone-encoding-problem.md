# Vive Pairing & Dimming Protocol - RESOLVED

## Status: FULLY RESOLVED (2026-02-06)

Full Vive device control working: pairing, ON/OFF, and raise/lower (dimming) for arbitrary zones. Tested with FCJS-010 (0-10V dimmer) and relay devices.

---

## Issue 1: Zone ID Not Propagated (2026-02-05)

### Root Cause

The auto-accept code path in `handle_rx_packet()` called:

```cpp
this->send_vive_accept(this->vive_hub_id_, device_id);
```

With `send_vive_accept` defaulting its third parameter to `zone_id = 0x38`. Meanwhile, `start_vive_pairing(hub_id)` took no zone parameter and stored none. So regardless of what zone the user intended, the auto-accept always used 0x38.

### Fix

1. Added `zone_id` parameter to `start_vive_pairing(hub_id, zone_id)`
2. Stored it as `vive_zone_id_` member variable
3. Auto-accept now passes `this->vive_zone_id_` to `send_vive_accept()`
4. Updated UDP handler and HA service to accept and forward `zone_id`

---

## Issue 2: Incomplete Config Packets (2026-02-06)

### Symptom

Device paired (responded to ON/OFF) but did NOT send B8 confirmation bursts during config phase, and raise/lower commands were ignored.

### Root Cause

Multiple config packets were too short. CCA pairing packets must ALL be **53 bytes** (51 data + 2 CRC) with 0xCC padding. The CC1101 hardware RX logs truncate packets (variable-length mode), making shorter packets appear to work. Only RTL-SDR captures reveal the true over-the-air length.

| Packet | Was | Should Be | Impact |
|--------|-----|-----------|--------|
| Format 0x14 (function mapping) | 26 bytes, memset 0x00 | 53 bytes, memset 0xCC | Device didn't register dimming capability |
| No-seq accept retransmissions | 36 bytes | 53 bytes | Device didn't reliably receive accept |
| Format 0x13 (dimming config) | 24 bytes (initially) | 53 bytes | Fixed earlier, same root cause |
| Format 0x28 A9 (zone assignment) | 26 bytes (initially) | 53 bytes | Fixed earlier, same root cause |

### Fix

1. All config packets expanded to 53 bytes with 0xCC padding and CRC at bytes 51-52
2. `build_packet_no_seq` helper updated from 36 to 53 bytes
3. Added more retransmissions per config format (5 type-rotated sends each vs 1-2 before)
4. Added type bytes 0x8D and 0xB1 to accept retransmission sequence

---

## Issue 3: Raise/Lower Not Working (2026-02-06)

### Symptom

ON/OFF commands worked but raise/lower (dimming) did not, even when device was paired to the real Vive hub. Our packets were byte-identical to real hub packets (CRC verified).

### Root Cause

Two issues:

1. **Missing hold-start packet (format 0x09)**: The real hub sends a burst of format 0x09 "hold-start" packets before the format 0x0b "dim step" packets. Without the hold-start, the device ignores the dim steps.

2. **Incomplete pairing config**: Format 0x14 at 26 bytes meant the device never fully registered its dimming capability, even though ON/OFF worked.

### Fix

1. Added format 0x09 hold-start burst (6 packets) before format 0x0b dim step burst (12 packets)
2. Fixed format 0x14 to 53 bytes (see Issue 2 above)

### Dim Command Format

**Hold-start (format 0x09)** - sent first, tells device a dim operation is starting:
```
89 [seq] [hub_id:4] 21 09 00 00 00 00 [zone] ef 42 00 [dir] cc cc cc cc cc [CRC:2]
```
- Byte 14 = 0x42 (command class: dim/level)
- Byte 15 = 0x00 (subcommand: hold-start)
- Byte 16 = direction (0x03=raise, 0x02=lower)

**Dim step (format 0x0b)** - actual dimming command:
```
89 [seq] [hub_id:4] 21 0b 00 00 00 00 [zone] ef 42 02 [dir] 00 00 cc cc cc [CRC:2]
```
- Byte 14 = 0x42 (command class: dim/level)
- Byte 15 = 0x02 (subcommand: single step)
- Byte 16 = direction (0x03=raise, 0x02=lower)

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

## Pairing Packet Flow (Complete, from RTL-SDR + CC1101)

| Phase | Packet | Direction | Size | Description |
|-------|--------|-----------|------|-------------|
| 1 | B9 (fmt 0x11) timer=0x3C | Hub -> All | 53 | Beacon: "pairing mode active" |
| 2 | B8 (fmt 0x23) | Device -> Hub | - | Device requests to pair |
| 3 | BA (fmt 0x10) | Hub -> Device | 53 | Accept: hub recognizes device |
| 3b | 87,8D,93,9F,AB,B1 (fmt 0x10) | Hub -> Device | 53 | Accept retransmissions (no-seq) |
| 4 | AB,A9,AA,8D,93 (fmt 0x13) | Hub -> Device | 53 | Dimming capability config |
| 5 | A9,9F,AB,B7,BD (fmt 0x28) | Hub -> Device | 53 | Zone assignment config #1 |
| - | B8 | Device -> Hub | - | Device retry (normal during config) |
| 6 | AB,A9,AA,8D,93 (fmt 0x14) | Hub -> Device | 53 | Function mapping config |
| 7 | AB,A9,AA,9F,B7 (fmt 0x28) | Hub -> Device | 53 | Zone assignment config #2 |
| 8 | A9,8D,93,9F,AB,B7,BD,C3 (fmt 0x12) | Hub -> Device | 53 | Final config with zone ID at byte 24 |
| - | B8 | Device -> Hub | - | Device confirmation (pairing success) |
| 9 | B9 (fmt 0x11) timer=0x00 | Hub -> All | 53 | Beacon: "pairing mode ended" |

---

## Key Protocol Facts

- **B9** = Beacon (format 0x11, broadcast) - NOT BA
- **BA** = Accept (format 0x10, directed to device)
- All pairing packets are **53 bytes** (51 data + 2 CRC) with 0xCC padding
- Zone commands (format 0x0E) use zone ID in byte 12, constant 0xEF in byte 13
- Dim commands (format 0x09/0x0b) use zone ID in byte 12, command class 0x42 in byte 14
- Sequence bytes increment by 8 for beacons, 6 for commands
- Type byte rotates (89/8A/8B for commands, various for config retransmissions)
- Device sends B8 retries throughout config phase until it receives all packets
- Format 0x28 byte 10 (`zone_id + 0x23`) is non-critical; the zone in format 0x12 byte 24 is authoritative

---

## RTL-SDR Decoder Improvements

The `tools/rtlsdr-cca-decode.ts` decoder was significantly improved during this investigation:

1. **Multi-retransmission decoding**: Each CCA burst contains ~12 retransmissions. Previous decoder only found 1 per burst. New `findAllPreambles()` function finds all preamble correlation peaks.
2. **2 MHz sample rate support**: 32 samples/bit (vs 16 at 1 MHz) for better signal quality.
3. **Aggressive clock tracking**: Recovery factor 0.05 -> 0.15 for faster lock.
4. **Deduplication**: Shows unique packets with retransmission count.
5. **Result**: 3 CRC OK -> 54 CRC OK on same capture data.

Capture command: `rtl_sdr -f 433602844 -s 2000000 -g 40 <output.bin>`
Decode command: `bun run tools/rtlsdr-cca-decode.ts --rate 2000000 <file.bin>`

---

## Usage

```bash
# Start pairing to a specific zone
# Via UDP JSON:
{"cmd": "vive_start", "hub_id": "0xYYYYYYYY", "zone_id": 70}  # 70 = 0x46

# Via HA service:
service: esphome.cca_proxy_start_vive_pairing
data:
  hub_id: "0xYYYYYYYY"
  zone_id: 70

# Control the paired zone
{"cmd": "vive_on", "hub_id": "0xYYYYYYYY", "zone_id": 70}
{"cmd": "vive_off", "hub_id": "0xYYYYYYYY", "zone_id": 70}
{"cmd": "vive_raise", "hub_id": "0xYYYYYYYY", "zone_id": 70}
{"cmd": "vive_lower", "hub_id": "0xYYYYYYYY", "zone_id": 70}
```

---

## Files Changed

| File | Change |
|------|--------|
| `esphome/custom_components/cc1101_cca/cc1101_cca.h` | Added `zone_id` param, `vive_zone_id_` member, `send_vive_dim_command` declaration |
| `esphome/custom_components/cc1101_cca/cc1101_cca.cpp` | Zone propagation, 53-byte config packets, hold-start + dim step, retransmissions |
| `esphome/cca-proxy.yaml` | UDP and HA service accept `zone_id` for all vive commands |
| `tools/rtlsdr-cca-decode.ts` | Multi-retransmission decoding, 2 MHz support, clock tracking |

## Reference Captures

| File | Description |
|------|-------------|
| `captures/vive-sessions/real-pairing.bin` | Real Vive hub pairing Room 1 (zone 0x38) |
| `captures/vive-sessions/toggling.bin` | Real Vive hub zone toggling |
| `captures/2mhz-fcjs-pairing-1.bin` | Real hub pairing FCJS-010 at 2 MHz (54 CRC OK) |
| `captures/esp-pairing-and-toggling-room-2.bin` | ESP32 pairing + control Room 2 |
| `captures/esp-pairing-and-toggling-room-3.bin` | ESP32 pairing + control Room 3 |
| `captures/esp-pairing-and-toggling-room-4.bin` | ESP32 pairing + control Room 4 |
