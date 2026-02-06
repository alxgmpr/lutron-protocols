# Vive Zone Encoding Problem - RESOLVED

## Status: RESOLVED (2026-02-05)

Arbitrary zone pairing and control is now working. The root cause was that `start_vive_pairing()` did not accept or propagate a `zone_id` parameter, so the auto-accept handler always paired devices to the default zone 0x38.

---

## Root Cause

The auto-accept code path in `handle_rx_packet()` called:

```cpp
this->send_vive_accept(this->vive_hub_id_, device_id);
```

With `send_vive_accept` defaulting its third parameter to `zone_id = 0x38`. Meanwhile, `start_vive_pairing(hub_id)` took no zone parameter and stored none. So regardless of what zone the user intended, the auto-accept always used 0x38.

## Fix

1. Added `zone_id` parameter to `start_vive_pairing(hub_id, zone_id)`
2. Stored it as `vive_zone_id_` member variable
3. Auto-accept now passes `this->vive_zone_id_` to `send_vive_accept()`
4. Updated UDP handler and HA service to accept and forward `zone_id`

## Findings Along the Way

### Format 0x28 Byte 10

The `zone_id + 0x23` formula for byte 10 in format 0x28 packets only matches the real hub for Room 1 (zone 0x38). The real hub values for other rooms don't follow this formula:

| Room | Zone ID | Code byte 10 | Real hub byte 10 |
|------|---------|---------------|-------------------|
| 1    | 0x38    | 0x5b          | 0x5b              |
| 2    | 0x46    | 0x69          | 0x66              |
| 3    | 0x61    | 0x84          | 0x7e              |
| 4    | 0x4b    | 0x6e          | 0x8c              |

Despite the mismatch, arbitrary zone pairing works. This means byte 10 is either ignored by the device or is non-critical for zone assignment. The zone ID in format 0x12 byte 24 is what actually determines the zone.

### Format 0x28 Byte 9

Always `0x38` in real hub captures across all rooms. This is a constant (possibly the hub's "base zone" or network identifier), not a zone ID.

### Pairing Packet Flow (from real hub RTL-SDR capture)

| Phase | Packet | Direction | Description |
|-------|--------|-----------|-------------|
| 1 | B9 (fmt 0x11) timer=0x3C | Hub -> All | Beacon: "pairing mode active" |
| 2 | BA (fmt 0x10) | Hub -> Device | Accept: hub recognizes device |
| 3 | B8 (fmt 0x23) | Device -> Hub | Device requests to pair |
| 4 | AB (fmt 0x28) | Hub -> Device | Zone assignment config |
| 5 | AB (fmt 0x12) | Hub -> Device | Final config with zone ID at byte 24 |
| 6 | 89 | Device -> All | Button state report (pairing confirmed) |
| 7 | B9 (fmt 0x11) timer=0x00 | Hub -> All | Beacon: "pairing mode ended" |

### Key Protocol Facts

- **B9** = Beacon (format 0x11, broadcast) - NOT BA
- **BA** = Accept (format 0x10, directed to device)
- All pairing packets are **53 bytes** (51 data + 2 CRC) with CC padding
- Zone commands (format 0x0E) use zone ID in byte 12, constant 0xEF in byte 13
- Sequence bytes increment by 8 for beacons, 6 for accepts/commands

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
```

---

## Files Changed

| File | Change |
|------|--------|
| `esphome/custom_components/cc1101_cca/cc1101_cca.h` | Added `zone_id` param to `start_vive_pairing()`, added `vive_zone_id_` member |
| `esphome/custom_components/cc1101_cca/cc1101_cca.cpp` | Store and propagate `zone_id` through auto-accept |
| `esphome/cca-proxy.yaml` | UDP and HA service accept `zone_id` for `vive_start` |

## Reference Captures

| File | Description |
|------|-------------|
| `captures/vive-sessions/real-pairing.bin` | Real Vive hub pairing Room 1 (zone 0x38) |
| `captures/vive-sessions/toggling.bin` | Real Vive hub zone toggling |
| `captures/esp-pairing-and-toggling-room-2.bin` | ESP32 pairing + control Room 2 |
| `captures/esp-pairing-and-toggling-room-3.bin` | ESP32 pairing + control Room 3 |
| `captures/esp-pairing-and-toggling-room-4.bin` | ESP32 pairing + control Room 4 |
