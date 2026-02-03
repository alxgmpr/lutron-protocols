# CCA Pairing Protocol Reference

## Overview

Lutron Clear Connect Type A (CCA) devices use several pairing mechanisms depending on the device type and system architecture.

## Pairing Types

### 1. Vive Hub Pairing (PowPak, Vive Dimmers) - VERIFIED WORKING

Used when pairing Vive devices (PowPak relays, Vive dimmers) through a Vive hub or emulated hub.

**Verified from real hub capture (2026-01-27):** Real Vive hubs use **0xBA** packets for beacons.

**Beacon Packet Structure (~37-45 bytes):**
```
ba [seq] [hub_id:4] 21 11 00 [bcast:5] 60 00 [hub_id:4] [bcast:4] [timer] [cc...] [crc:2]
```

| Offset | Size | Field | Value | Description |
|--------|------|-------|-------|-------------|
| 0 | 1 | Type | 0xBA | Vive beacon |
| 1 | 1 | Sequence | +8 | Increments by 8, wraps at 0x48 (0,8,16,24,32,40,48,56,64,0...) |
| 2-5 | 4 | Hub ID | BE | Hub device ID (big-endian) |
| 6 | 1 | Protocol | 0x21 | Protocol version |
| 7 | 1 | Format | 0x11 | Pairing mode format |
| 8 | 1 | Unknown | 0x00 | |
| 9-13 | 5 | Broadcast | FF FF FF FF FF | 5-byte broadcast target |
| 14 | 1 | Flags | 0x60 | |
| 15 | 1 | Command | 0x00 | Enter/exit pairing |
| 16-19 | 4 | Hub ID | BE | Hub ID repeated |
| 20-23 | 4 | Broadcast | FF FF FF FF | 4-byte broadcast |
| 24 | 1 | Timer | 0x3C/0x00 | **0x3C=active, 0x00=exit pairing** |
| 25+ | N | Padding | CC | CC padding |
| -2 | 2 | CRC | | CRC-16 |

**Timing (from capture):**
- Beacon bursts: ~9 packets per burst (~100ms apart)
- Burst interval: ~30 seconds (NOT continuous like RA3!)
- Exit: Same BA packet but with timer=0x00

---

## Complete Pairing Sequence (Verified 2026-01-27)

**Captured from real Vive Hub (YYYYYYYY) pairing PowPak (021AD0C3):**

```
Time        Direction  Type  Description
─────────────────────────────────────────────────────────────────
23:54:07.3  Hub→All    BA    Beacon burst (timer=0x3C, seq cycling)
   ...14 seconds of beacons...
23:54:21.3  Device→Hub B8    Pairing request from 021AD0C3
23:54:21.5  Device→Hub B8    (retry)
23:54:21.8  Hub→Device BB    Accept (seq=1, target=021AD0C3)
23:54:21.9  Hub→Device 87    Config packet 1
23:54:22.3  Hub→Device 99    Config packet 2
23:54:22.3  Hub→Device A5    Config packet 3
23:54:22.5  Hub→Device A9    Zone assignment (format=0x28)
23:54:23.0  Hub→Device AA    Function mapping
23:54:23.1  Hub→Device AB    Additional config
23:54:23.2  Hub→Device A9    Zone finalize (format=0x12)
23:54:23.3  Hub→Device 8D    Config
23:54:23.4  Hub→Device 93    Config
23:54:23.5  Hub→Device 9F    Config
23:54:23.9  Hub→Device B7    Config
23:54:23.9  Hub→Device BD    Config
23:54:24.0  Hub→Device C3    Config (final)
   ...device still retrying B8 during config...
23:54:26.3  Hub→All    BA    Exit beacon (timer=0x00)
23:54:27.2  Device→Hub 89    Button press (ON) - PAIRING COMPLETE!
```

**Key Discovery:** Device keeps sending B8 retries until it receives the config packets. The BB accept alone is NOT sufficient - the config sequence (87, 99, A5, A9, AA, AB, 8D, 93, 9F, B7, BD, C3) is required!

---

## Packet Type Reference

### 0xBA - Vive Pairing Beacon

**Direction:** Hub → All Devices (broadcast)
**Purpose:** Announce hub is in pairing mode; devices flash to indicate ready
**Length:** ~37-45 bytes

**Real capture example:**
```
ba 00 01 7d 53 63 21 11 00 ff ff ff ff ff 60 00 01 7d 53 63 ff ff ff ff 3c cc cc cc cc cc cc cc cc cc cc cc cc
```

**Exit pairing (same packet, timer=0x00):**
```
ba 00 01 7d 53 63 21 11 00 ff ff ff ff ff 60 00 01 7d 53 63 ff ff ff ff 00 cc cc cc cc cc cc cc cc cc cc cc cc
```

---

### 0xB8 - Device Pairing Request

**Direction:** Device → Hub (broadcast, looking for any hub)
**Purpose:** Device requests to pair
**Length:** ~45 bytes

**Real capture example (PowPak RMJS-5R-DV-B):**
```
b8 00 02 1a d0 c3 21 23 00 ff ff ff ff ff 60 02 ff ff ff ff 02 1a d0 c3 16 0c 01 01 00 0c 05 04 01 00 ff ff ff ff ff ff ff ff 02 cc cc
```

| Offset | Field | Value | Description |
|--------|-------|-------|-------------|
| 0 | Type | 0xB8 | Pairing request |
| 1 | Sequence | 0x00 | Usually 0 |
| 2-5 | Device ID | 02 1A D0 C3 | Requesting device (BE) |
| 6 | Protocol | 0x21 | |
| 7 | Format | 0x23 | Device request format |
| 8 | Unknown | 0x00 | |
| 9-13 | Target | FF FF FF FF FF | Broadcast |
| 14 | Flags | 0x60 | |
| 15 | Command | 0x02 | Request to pair |
| 16-19 | Target | FF FF FF FF | Broadcast |
| 20-23 | Device ID | 02 1A D0 C3 | Repeated |
| 24-26 | Device Info | 16 0C 01 | Type, capabilities, version |
| 27+ | Extended | 01 00 0c 05... | Additional device info |

**Device Info (bytes 24-26):**
- 0x16 = PowPak relay (RMJS-5R-DV-B)
- 0x0C = Capability flags
- 0x01 = Version

---

### 0xBB - Hub Accept Response

**Direction:** Hub → Device (targeted)
**Purpose:** Accept device into pairing
**Length:** 37 bytes

**Real capture example:**
```
bb 01 01 7d 53 63 21 10 00 02 1a d0 c3 fe 60 0a 01 7d 53 63 01 7d 53 63 cc cc cc cc cc cc cc cc cc cc cc cc cc
```

| Offset | Field | Value | Description |
|--------|-------|-------|-------------|
| 0 | Type | 0xBB | Accept |
| 1 | Sequence | 0x01 | Always 1 for response |
| 2-5 | Hub ID | 01 7D 53 63 | Hub (BE) |
| 6 | Protocol | 0x21 | |
| 7 | Format | 0x10 | Accept format (not 0x11!) |
| 8 | Unknown | 0x00 | |
| 9-12 | Target | 02 1A D0 C3 | **Device being paired** |
| 13 | Paired Flag | 0xFE | (0xFE, not 0xFF) |
| 14 | Flags | 0x60 | |
| 15 | Command | 0x0A | Accept command |
| 16-19 | Hub ID | 01 7D 53 63 | Hub repeated |
| 20-23 | Hub ID | 01 7D 53 63 | Hub repeated again |
| 24+ | Padding | CC... | |

---

### Config Packets (Post-Accept Sequence)

After BB accept, hub sends a rapid sequence of config packets. Device continues B8 retries until these are received.

**Config packet types (in order):**
| Type | Purpose | Format Byte |
|------|---------|-------------|
| 0x87 | Config 1 | 0x10 |
| 0x99 | Config 2 | 0x10 |
| 0xA5 | Config 3 | 0x10 |
| 0xA9 | Zone assignment | 0x28, then 0x12 |
| 0xAA | Function mapping | 0x14 |
| 0xAB | Additional config | 0x28 |
| 0x8D | Finalize 1 | 0x12 |
| 0x93 | Finalize 2 | 0x12 |
| 0x9F | Finalize 3 | 0x12 |
| 0xB7 | Finalize 4 | 0x12 |
| 0xBD | Finalize 5 | 0x12 |
| 0xC3 | Finalize 6 | 0x12 |

**A9 Zone Assignment (format=0x28):**
```
a9 01 01 7d 53 63 28 03 01 38 7d 21 1a 00 02 1a d0 c3 fe 06 40 00 00 00
```

**AA Function Mapping:**
```
aa 01 01 7d 53 63 21 14 00 02 1a d0 c3 fe 06 50 00 0b 09 fe ff 00 00 00
```

**A9 Final (format=0x12):**
```
a9 01 01 7d 53 63 21 12 00 02 1a d0 c3 fe 06 6e 01 00 07 00 02 00 00 00
```

---

## Implementation (ESP32/CC1101)

### Emulating Vive Hub

**Code location:** `esphome/custom_components/cc1101_cca/cc1101_cca.cpp`

**Functions:**
- `start_vive_pairing(hub_id)` - Start beacon broadcasts
- `stop_vive_pairing()` - Send exit beacon (timer=0x00)
- `send_vive_beacon_burst()` - Send BA beacon burst
- `send_vive_accept(hub_id, device_id)` - Send BB + config sequence
- `handle_rx_packet()` - Auto-detect B8 requests and trigger accept

**Pairing flow:**
1. Call `start_vive_pairing(0xYYYYYYYY)` - devices flash
2. User holds device button 5-10 seconds
3. ESP32 receives B8 packet, auto-calls `send_vive_accept()`
4. Accept sends: BB (x3) → 87 → 99 → A5 → A9 → AA → A9 → 8D → 93 → 9F → B7 → BD → C3
5. Device confirms with 0x89 button press
6. Call `stop_vive_pairing()` to exit

### API Endpoints

```bash
# Start pairing mode
curl -X POST http://localhost:5001/api/vive/start -d '{"hub_id":"0xYYYYYYYY"}'

# Stop pairing mode
curl -X POST http://localhost:5001/api/vive/stop

# Manual beacon burst
curl -X POST http://localhost:5001/api/vive/beacon -d '{"hub_id":"0xYYYYYYYY","count":9}'

# Manual accept (if auto-accept disabled)
curl -X POST http://localhost:5001/api/vive/accept -d '{"hub_id":"0xYYYYYYYY","device_id":"0x021AD0C3"}'
```

---

## Comparison: Vive vs RA3/Caseta Pairing

| Feature | Vive Hub | RA3/Caseta Bridge |
|---------|----------|-------------------|
| Beacon Type | 0xBA | 0x91/0x92/0x93 |
| Beacon Timing | Burst every 30s | Continuous |
| Device Request | 0xB8 | 0xB0 |
| Accept | 0xBB + config sequence | 0xC1-0xE0 handshake |
| Sequence Increment | +8 | +6 |
| Exit | BA with timer=0x00 | Stop beacons |

---

## Resend Settings Sequence (Captured 2026-01-28)

When using "Resend Settings" from Vive app troubleshooting menu, the hub sends a different sequence than pairing:

```
Time        Type  Format  Description
────────────────────────────────────────────────────────────────
00:01:17.5  8A    0x09    Attention/ping to device (hub→device)
00:01:17.5  87    0x09    Device acknowledgment
00:01:17.6  8A    0x09    More attention (seq cycling: 141,153,171...)
00:01:17.7  93    0x09    Device ack
00:01:17.8  9F    0x09    Device ack
00:01:22.4  AB    0x11    Settings packet 1
00:01:22.4  A9    0x14    Settings packet 2
00:01:22.5  AA    0x15    Settings packet 3
00:01:22.8  AB    0x28    Zone assignment
00:01:22.8  87    0x12    Final config
00:01:23.2  A5    0x12    Final config
00:01:23.3  B1    0x12    Final config
00:01:23.5  C3    0x12    Final config (complete)
```

**Key packets:**

**0x8A - Attention/Ping (format=0x09):**
```
8a 01 01 7d 53 63 21 09 00 02 1a d0 c3 fe 02 02 01 cc cc cc cc cc [crc]
```
- Used to wake up device before sending settings
- Device responds with 87, 93, 9F echoes

**Settings packets use different format bytes than pairing:**
| Packet | Pairing Format | Resend Format |
|--------|---------------|---------------|
| AB | 0x28 | 0x11, 0x28 |
| A9 | 0x28, 0x12 | 0x14 |
| AA | 0x14 | 0x15 |

**Difference from pairing:**
- No BA beacon needed (device already known)
- No BB accept needed (already paired)
- Uses 0x8A attention packets instead
- Same final config packets (87, A5, B1, C3 with format=0x12)

---

---

## Final Config Packets (0x8D, 0x93, 0x9F, 0xB7, 0xBD, 0xC3) - Captured 2026-01-28

From real hub capture pairing 3 devices to 3 different rooms:

**Devices tested:**
- 020AE675: Relay/PowerPack with CCO output (RMJS-5R-DV-B)
- 09626657: 0-10V FCJS-010 dimmer (measures wattage, 12V sensor input)
- 021AD0C3: Simple relay module

### 0x8D Packet Format (24 bytes data)

```
8d 01 7d 53 63 21 12 00 02 0a e6 75 fe 06 6e 01 00 07 00 02 00 00 00 38
0  1  2  3  4  5  6  7  8  9  10 11 12 13 14 15 16 17 18 19 20 21 22 23
```

| Offset | Size | Field | Example | Description |
|--------|------|-------|---------|-------------|
| 0 | 1 | Type | 0x8D | Packet type |
| 1-4 | 4 | Hub ID | 01 7D 53 63 | Big-endian hub ID |
| 5 | 1 | Protocol | 0x21 | Protocol version |
| 6 | 1 | Format | 0x12 | Final config format |
| 7 | 1 | Unknown | 0x00 | Always 0x00 |
| 8-11 | 4 | Device ID | 02 0A E6 75 | Big-endian device ID |
| 12 | 1 | Paired Flag | 0xFE | (not 0xFF) |
| 13 | 1 | Unknown | 0x06 | |
| 14 | 1 | Config | 0x6E | |
| 15-22 | 8 | Config Data | 01 00 07 00 02 00 00 00 | |
| 23 | 1 | **Room Byte** | 0x38 | Zone/room assignment |

### Room Byte Values (Byte 23)

From capture with 3 devices assigned to 3 different rooms:

| Device | Room | Byte 23 |
|--------|------|---------|
| 020AE675 | Room 1 | 0x38 |
| 09626657 | Room 2 | 0x47 |
| 021AD0C3 | Room 3 | 0x4B |

**Note:** Room bytes are NOT simple 1,2,3 values. They appear to be computed zone IDs.

### 0xB7/0xBD Packet Format (25 bytes data)

Same as 8D but with 0xEF suffix:

```
b7 01 7d 53 63 21 12 00 02 1a d0 c3 fe 06 6e 01 00 07 00 02 00 00 00 4b ef
0  1  2  3  4  5  6  7  8  9  10 11 12 13 14 15 16 17 18 19 20 21 22 23 24
```

| Packet | Data Length | Total with CRC |
|--------|-------------|----------------|
| 8D, 93, 9F, C3 | 24 bytes | 26 bytes |
| B7, BD | 25 bytes (has 0xEF) | 27 bytes |

### Device B8 Request - Device Type Info

The B8 pairing request contains device type info at bytes 24-26+:

**Relay/PowerPack (020AE675):**
```
b8 ... 02 0a e6 75 16 12 01 01 00 12 03 02 01 00 ...
                   |__|__|__|
                   type info: 16 12 01
```

**0-10V Dimmer (09626657):**
```
b8 ... 09 62 66 57 16 0f 02 01 00 00 08 02 01 00 00 ...
                   |__|__|__|
                   type info: 16 0f 02
```

**Simple Relay (021AD0C3):**
```
b8 ... 02 1a d0 c3 16 0c 01 01 00 0c 05 04 01 00 ...
                   |__|__|__|
                   type info: 16 0c 01
```

| Byte 24 | Byte 25 | Byte 26 | Device Type |
|---------|---------|---------|-------------|
| 0x16 | 0x12 | 0x01 | Relay/PowerPack with CCO |
| 0x16 | 0x0F | 0x02 | 0-10V Dimmer (FCJS-010) |
| 0x16 | 0x0C | 0x01 | Simple Relay |

---

## Future Work

- [ ] Decode room byte calculation (0x38, 0x47, 0x4B for rooms 1,2,3)
- [ ] Test pairing other device types (Vive dimmers, sensors)
- [ ] Implement device-side pairing (ESP32 as PowPak)
- [ ] Implement "Resend Settings" command
