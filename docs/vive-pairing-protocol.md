# Vive Pairing Protocol - Reverse Engineering Findings

## Overview

This document describes the Lutron Vive (Clear Connect Type A) pairing protocol as reverse engineered from RTL-SDR captures of real Vive hub traffic (2026-02-05).

## Key Findings

### Packet Types

| Type | Format | Purpose |
|------|--------|---------|
| **B9** | 0x11 | Pairing beacon (broadcast) |
| **BA** | 0x10 | Accept/response to device |
| **B8** | 0x23 | Device pairing request |
| **AB** | 0x28 | Zone assignment config |
| **AB** | 0x12 | Final config with zone ID |
| **89** | - | Device state report (after pairing) |

### Critical Discovery: B9 vs BA

The packet type byte determines the message type:
- **B9** = Beacon packets (format 0x11, broadcast to all devices)
- **BA** = Accept packets (format 0x10, directed to specific device)

Previous implementations incorrectly used BA for beacons.

### Packet Structure

All pairing packets are **53 bytes** (51 data + 2 CRC):

```
[type:1] [seq:1] [hub_id:4] [protocol:1] [format:1] [flags:1] [target:4-5] [data:varies] [cc_padding] [crc:2]
```

### Beacon Packet (B9, format 0x11)

```
b9 [seq] 01 7d 53 63 21 11 00 ff ff ff ff ff 60 00 01 7d 53 63 ff ff ff ff [timer] cc...cc [crc:2]
```

- `timer` = 0x3C (60 seconds active) or 0x00 (stop)
- Sequence increments by 8, wraps at 0x48

### Accept Packet (BA, format 0x10)

```
ba [seq] [hub:4] 21 10 00 [device:4] fe 60 0a [hub:4] [hub:4] cc...cc [crc:2]
```

- Sent when device's B8 request is received
- Contains device ID and hub ID

### Zone Assignment (AB, format 0x28)

```
ab [seq] [hub:4] 28 03 01 [zone] 5b 21 1a 00 [device:4] fe 06 40 00 00 00 01 ef 20 00 03 09 2b ff 00 ff 00 00 b4 00 00 cc...cc [crc:2]
```

- 53 bytes total
- Zone ID at byte 9
- Additional config data: `01 ef 20 00 03 09 2b ff 00 ff 00 00 b4 00 00`

### Final Config (AB/A9/8D/93/9F/B7/BD/C3, format 0x12)

```
[type] [seq] [hub:4] 21 12 00 [device:4] fe 06 6e 01 00 07 00 02 00 00 00 [zone] ef cc...cc [crc:2]
```

- 53 bytes total
- Zone ID at byte 24
- EF suffix at byte 25
- CC padding to fill 53 bytes

## Pairing Sequence

1. **Hub broadcasts B9 beacons** (format 0x11, timer=0x3C)
2. **Device sends B8 request** (format 0x23) when in pairing mode
3. **Hub sends BA accept** (format 0x10) with device ID
4. **Hub sends config retransmissions** (87, 93, 9f, ab - format 0x10)
5. **Hub sends A9 zone assignment** (format 0x28)
6. **Hub sends AA function mapping** (format 0x14)
7. **Hub sends AB zone assignment** (format 0x28, 53 bytes)
8. **Hub sends final config packets** (A9, 8D, 93, 9F, AB, B7, BD, C3 - format 0x12, 53 bytes each)
9. **Device emits 89 state packets** when physically toggled (pairing confirmed)

## Verification Method

RTL-SDR captures were decoded using:
```bash
rtl_sdr -f 433602844 -s 1000000 -g 40 capture.bin
bun run tools/rtlsdr-cca-decode.ts --rate 1000000 capture.bin
```

Comparing ESP32 transmissions against real Vive hub transmissions revealed:
- Beacon type was wrong (BA instead of B9)
- Config packets were too short (26-28 bytes instead of 53)
- Zone assignment packets were missing additional config data

## Reference Captures

- `captures/vive-sessions/real-pairing.bin` - Real Vive hub pairing a device
- `captures/vive-sessions/toggling.bin` - Device state changes after pairing
- `captures/esp-pairing-and-toggling-2.bin` - Working ESP32 pairing

## Known Limitations

- Currently requires using a real hub ID and zone (e.g., yyyyyyyy, zone 0x38)
- Zone calculation for arbitrary hub IDs not yet understood
- Some config bytes (e.g., 0x5b reference counter) may need to vary
