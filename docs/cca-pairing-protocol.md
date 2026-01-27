# CCA Pairing Protocol Reference

## Overview

Lutron Clear Connect Type A (CCA) devices use several pairing mechanisms depending on the device type and system architecture.

## Pairing Types

### 1. Hub-Based Pairing (Vive, RA3 Processor)

Used when pairing devices through a central hub/processor.

**Sequence:**
```
Hub  -> Broadcast:  0xBA (Enter pairing mode)
Device -> Hub:      0xB8 (Pairing request)
Hub  -> Device:     0xBB (Pairing accepted)
Hub  -> Broadcast:  0xBB (Exit pairing mode)
```

### 2. Direct Pairing (Pico to Dimmer)

Used for direct device-to-device pairing without a hub.

**Sequence:**
```
Pico -> Broadcast:  0xB9/0xBB alternating (Pairing advertisement)
Dimmer receives and stores association
```

---

## Packet Type Reference

### 0xBA - Hub Pairing Mode Broadcast

**Direction:** Hub -> All Devices (broadcast)
**Purpose:** Announce hub is in pairing mode, devices should enter pairing-ready state
**Typical Length:** 24-46 bytes (variable due to CC padding)

**Packet Structure:**
```
Offset  Len  Field           Example       Description
------  ---  --------------  ------------  ---------------------------
0       1    Type            0xBA          Packet type
1       1    Sequence        0x00-0x40     Cycles 0,8,16,24,32,40,48,56,64,0...
2       4    Hub ID          01 7D 53 63   Hub device ID (big-endian)
6       1    Protocol        0x21          Protocol version
7       1    Format          0x11          Pairing mode format
8       1    Unknown         0x00
9       5    Target          FF FF FF FF FF  Broadcast (all devices)
14      1    Flags           0x60
15      1    Command         0x00          Enter pairing mode
16      4    Hub ID          01 7D 53 63   Hub ID repeated
20      4    Target          FF FF FF FF   Broadcast target
24      1    Timer?          0x3C          Pairing window (60 = 0x3C seconds?)
25+     N    Padding         CC CC CC...   Variable padding
```

**Notes:**
- Hub broadcasts continuously while in pairing mode
- Sequence increments by 8 each packet (0, 8, 16, 24...)
- Devices flash/indicate when they receive this
- Timer byte (offset 24) may control pairing window duration

---

### 0xB8 - Device Pairing Request

**Direction:** Device -> Hub
**Purpose:** Device requests to pair with the hub
**Typical Length:** 27-46 bytes

**Packet Structure:**
```
Offset  Len  Field           Example       Description
------  ---  --------------  ------------  ---------------------------
0       1    Type            0xB8          Packet type
1       1    Sequence        0x00          Sequence (usually 0 for request)
2       4    Device ID       02 1A D0 C3   Requesting device ID (big-endian)
6       1    Protocol        0x21          Protocol version
7       1    Format          0x23          Device pairing format
8       1    Unknown         0x00
9       5    Target          FF FF FF FF FF  Broadcast
14      1    Flags           0x60
15      1    Command         0x02          Pairing request command
16      4    Target          FF FF FF FF   Broadcast (looking for any hub)
20      4    Device ID       02 1A D0 C3   Device ID repeated
24      3    Device Info     16 0C 01      Device type, capabilities, version
27+     N    Extended        ...           Additional device info (varies)
```

**Device Info Bytes (offset 24-26):**
- Byte 24 (0x16): Device type identifier
- Byte 25 (0x0C): Capability flags
- Byte 26 (0x01): Version/revision

**Captured Device Types:**
| Device | Type Byte | Info Bytes |
|--------|-----------|------------|
| RMJS-5R-DV-B (PowPak relay) | 0x16 | 16 0C 01 |

---

### 0xBB - Hub Pairing Response / Exit Pairing Mode

**Direction:** Hub -> Device (targeted) or Hub -> All (broadcast)
**Purpose:** Accept device pairing OR exit pairing mode
**Typical Length:** 24-46 bytes

**Pairing Accepted (targeted):**
```
Offset  Len  Field           Example       Description
------  ---  --------------  ------------  ---------------------------
0       1    Type            0xBB          Packet type
1       1    Sequence        0x01          Sequence=1 indicates response
2       4    Hub ID          01 7D 53 63   Hub device ID
6       1    Protocol        0x21          Protocol version
7       1    Format          0x10          Acceptance format
8       1    Unknown         0x00
9       4    Target Device   02 1A D0 C3   The device being paired!
13      1    Flags           0xFE          Paired flag (FE vs FF)
14      1    Unknown         0x60
15      1    Command         0x0A          Accept command
16      4    Hub ID          01 7D 53 63   Hub ID
20      4    Hub ID          01 7D 53 63   Hub ID repeated
24+     N    Padding         CC CC CC...   Variable padding
```

**Exit Pairing Mode (broadcast):**
```
Offset  Len  Field           Example       Description
------  ---  --------------  ------------  ---------------------------
0       1    Type            0xBB          Packet type
1       1    Sequence        0x00-0x40     Normal sequence cycling
2       4    Hub ID          01 7D 53 63   Hub device ID
6       1    Protocol        0x21          Protocol version
7       1    Format          0x11          Exit format (same as 0xBA)
8       1    Unknown         0x00
9       5    Target          FF FF FF FF FF  Broadcast
14      1    Flags           0x60
15      1    Command         0x00          Exit pairing mode
...
```

**Key Differences:**
| Field | Accept | Exit |
|-------|--------|------|
| Seq | 0x01 | Cycling (0,8,16...) |
| Format | 0x10 | 0x11 |
| Target | Device ID | FF FF FF FF FF |
| Byte 13 | 0xFE | 0xFF |
| Command | 0x0A | 0x00 |

---

### 0xB9 - Pico Direct Pairing

**Direction:** Pico -> Broadcast (for direct dimmer pairing)
**Purpose:** Advertise Pico for direct pairing to dimmer/switch
**Typical Length:** 53 bytes

**Packet Structure:**
```
Offset  Len  Field           Example       Description
------  ---  --------------  ------------  ---------------------------
0       1    Type            0xB9          Packet type
1       1    Sequence        0x00-0x48     Cycles by 6
2       4    Pico ID         XX XX XX XX   Pico device ID (big-endian)
6       1    Protocol        0x21          Protocol version
7       1    Format          0x25          Direct pairing format
8       1    Unknown         0x04
9       1    Unknown         0x00
10      1    Button Scheme   0x04          Button configuration (5-button)
11      2    Unknown         03 00
13      5    Target          FF FF FF FF FF  Broadcast
18      2    Unknown         0D 05
20      4    Pico ID         XX XX XX XX   Pico ID repeated
24      4    Pico ID         XX XX XX XX   Pico ID repeated again
28-40   13   Capabilities    ...           Button range, function codes
41      4    Padding         FF FF FF FF
45      6    Padding         CC CC CC CC CC CC
51      2    CRC             XX XX         CRC-16
```

**Button Scheme (offset 10):**
- 0x04 = 5-button Pico (ON, FAV, OFF, RAISE, LOWER)
- 0x02 = 2-button Pico
- 0x03 = 3-button Pico

**Notes:**
- Real Picos alternate B9 and BB packets
- Sequence increments by 6 (not 8)
- Contains capability bytes describing button functions

---

## Pairing Protocol Comparison

| Feature | Hub Pairing (BA/B8/BB) | Direct Pairing (B9/BB) |
|---------|------------------------|------------------------|
| Use Case | Vive, RA3 processor | Pico to dimmer |
| Initiator | Hub broadcasts BA | Pico broadcasts B9 |
| Request | Device sends B8 | N/A (dimmer listens) |
| Confirm | Hub sends BB (targeted) | N/A (implicit) |
| Exit | Hub broadcasts BB | Pico stops transmitting |
| Sequence | +8 per packet | +6 per packet |

---

## Captured Pairing Session (Vive Hub + PowPak)

**Devices:**
- Vive Hub: `01 7D 53 63`
- PowPak RMJS-5R-DV-B: `02 1A D0 C3`

**Timeline:**
```
20:01:05.323  Hub   0xBA  Enter pairing mode (seq cycling)
20:01:41.323  Device 0xB8  Pairing request from 021AD0C3
20:01:41.717  Hub   0xBB  Pairing accepted (seq=1, target=021AD0C3)
20:01:41.793  Hub   0x8C  Association confirmation
20:01:41.867  Hub   0x8D  Association details
20:01:42.157  Hub   0xA5  Config exchange
20:01:42.326  Hub   0xA9  Zone assignment
20:01:42.857  Hub   0xAA  Function mapping
20:01:43.033  Hub   0xA9  Final config
20:01:46.534  Device 0x89  Normal button press (pairing complete)
20:01:48.194  Hub   0xBA  Re-enter pairing mode (continue adding)
20:01:49.392  Hub   0xBA  (user waiting)
20:01:51.???  Hub   0xBB  Exit pairing mode (user stopped)
```

---

## Implementation Notes

### To Pair a Device with Vive Hub:

1. **Listen** for 0xBA broadcasts to detect hub in pairing mode
2. **Extract** hub ID from bytes 2-5 of 0xBA packet
3. **Send** 0xB8 pairing request with your device ID
4. **Wait** for 0xBB with your device ID in target field (bytes 9-12)
5. **Respond** to any config packets (0xA5, 0xA9, etc.)

### To Emulate Vive Hub (IMPLEMENTED):

Our CC1101/ESP32 can emulate a Vive hub to pair real devices (PowPaks, etc.):

1. **Start hub emulation** - begins broadcasting 0xBA packets
2. **Devices flash** when they receive 0xBA (pairing mode indication)
3. **Put device in pairing mode** - device sends 0xB8 request
4. **Auto-accept** - ESP32 detects 0xB8 and sends 0xBB acceptance
5. **Stop hub emulation** - broadcasts 0xBB exit to end pairing window

**Code location:** `rf/esphome/custom_components/cc1101_cca/cc1101_cca.cpp`
- `send_vive_beacon()` - Sends 0xBA broadcast
- `send_vive_accept()` - Sends 0xBB acceptance to specific device
- `handle_rx_packet()` - Auto-detects 0xB8 and triggers acceptance

### CRC Calculation

All packets use CRC-16 (CCITT) over bytes 0 to len-2:
```python
import cca
crc = cca.calc_crc(packet[:22])  # For 24-byte packets
packet[22] = (crc >> 8) & 0xFF   # CRC high byte
packet[23] = crc & 0xFF          # CRC low byte
```
