# Lutron Clear Connect Type A (CCA) Protocol

## RF Parameters

| Parameter | Value |
|-----------|-------|
| Frequency | 433.602844 MHz (default) |
| RF Channel | 26 (default, as shown in Lutron Designer) |
| Modulation | 2-FSK |
| Data Rate | 62.5 kBaud |
| Deviation | 41.2 kHz |
| Encoding | Async serial N81 (start=0, 8 data LSB first, stop=1) |

### RF Channel Table

Lutron Designer allows selecting from 15 RF channels.

**Formula:** `Frequency (MHz) = 431.0 + (channel × 0.1)`

| Channel | Frequency (MHz) |
|---------|-----------------|
| 5 | 431.5 |
| 14 | 432.4 |
| 17 | 432.7 |
| 20 | 433.0 |
| 23 | 433.3 |
| **26** | **433.6** (default) |
| 29 | 433.9 |
| 32 | 434.2 |
| 38 | 434.8 |
| 41 | 435.1 |
| 44 | 435.4 |
| 47 | 435.7 |
| 50 | 436.0 |
| 53 | 436.3 |
| 56 | 436.6 |

### Multi-Processor Channel Assignment

When using two main repeaters (RadioRA 2) or two processors (RadioRA 3) in the same system:
- Each processor operates on a **different RF channel** to avoid interference
- The first processor activated retains the **default channel 26**
- The second processor is assigned a different channel

**Device types:**
- **Two-way devices** (dimmers, switches) receive programming wirelessly and automatically switch to match their processor's RF channel
- **One-Way Transmitters (OWTs)** like Picos and occupancy sensors only transmit - they cannot receive channel settings and must be **manually configured** to match their assigned processor's channel

OWT channel change procedures involve putting the device into channel selection mode and cycling through channels until the processor acknowledges (beep in RR2, popup in RR3 Designer).

### CC1101 Register Configuration

```
FREQ2/1/0: 0x10 0xAD 0x52  (433.602844 MHz)
MDMCFG4/3: 0x0B 0x3B       (62.4847 kBaud)
MDMCFG2:   0x30            (2-FSK, no sync word - we handle sync in bitstream)
DEVIATN:   0x45            (41.2 kHz deviation)
PKTCTRL0:  0x00            (Fixed length, no hardware CRC)
```

## Bit-Level Encoding

Each byte becomes 10 bits using async serial N81 format:
- 1 start bit (always 0)
- 8 data bits, transmitted LSB first
- 1 stop bit (always 1)

Example - byte 0xFA (binary: 11111010):
```
LSB first: 0 1 0 1 1 1 1 1
With framing: 0 + 01011111 + 1 = 0010111111
```

## On-Air Packet Structure

```
[Preamble 32 bits][Sync 0xFF][Prefix 0xFA 0xDE][N81-encoded payload][Trailing zeros]
```

| Component | Bits | Content |
|-----------|------|---------|
| Preamble | 32 | Alternating 10101010... |
| Sync | 10 | 0xFF encoded as N81 |
| Prefix | 20 | 0xFA 0xDE encoded as N81 |
| Payload | variable | Packet data encoded as N81 |
| Trailing | 16 | Zero padding |

## CRC-16 Calculation

Polynomial: 0xCA0F (non-standard)

```cpp
uint16_t calc_crc(const uint8_t *data, size_t len) {
    static uint16_t crc_table[256];
    static bool table_init = false;

    if (!table_init) {
        for (int i = 0; i < 256; i++) {
            uint16_t crc = i << 8;
            for (int j = 0; j < 8; j++) {
                if (crc & 0x8000) {
                    crc = ((crc << 1) ^ 0xCA0F) & 0xFFFF;
                } else {
                    crc = (crc << 1) & 0xFFFF;
                }
            }
            crc_table[i] = crc;
        }
        table_init = true;
    }

    uint16_t crc_reg = 0;
    for (size_t i = 0; i < len; i++) {
        uint8_t crc_upper = crc_reg >> 8;
        crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ crc_table[crc_upper];
    }
    return crc_reg;
}
```

CRC is calculated over payload bytes (excluding CRC) and stored big-endian.

## Packet Types

| Type | Name | Size | Description |
|------|------|------|-------------|
| 0x88 | BTN_SHORT_A | 24 | Button press, short format, group A |
| 0x89 | BTN_LONG_A | 24 | Button press, long format, group A |
| 0x8A | BTN_SHORT_B | 24 | Button press, short format, group B |
| 0x8B | BTN_LONG_B | 24 | Button press, long format, group B |
| 0x81-0x83 | LEVEL | 24 | Level command or dimmer state report |
| 0x91-0x93 | BEACON | 24 | Bridge pairing mode beacon |
| 0xA1-0xA7 | CONFIG | 24+ | Configuration/extended commands |
| 0xB0 | DEVICE_ANNOUNCE | 46 | Device announcement during bridge pairing |
| 0xB8 | PAIR_B8 | 53 | Bridge-only pairing (scene pico) |
| 0xB9 | PAIR_B9 | 53 | Direct-pair capable |
| 0xBA | PAIR_BA | 53 | Bridge-only pairing (scene pico) |
| 0xBB | PAIR_BB | 53 | Direct-pair capable |

Type bit pattern for 0x88-0x8B:
- Bit 0: Format (0=Short, 1=Long)
- Bit 1: Group (0=A, 1=B) - alternates between button presses

## Button Codes

### 5-Button Pico (PJ2-3BRL)

| Button | Code |
|--------|------|
| ON | 0x02 |
| FAVORITE | 0x03 |
| OFF | 0x04 |
| RAISE | 0x05 |
| LOWER | 0x06 |

### 4-Button Scene Pico (PJ2-4B-S)

| Button | Code |
|--------|------|
| BRIGHT | 0x08 |
| ENTERTAIN | 0x09 |
| RELAX | 0x0A |
| OFF | 0x0B |

### 4-Button Raise/Lower Pico (PJ2-4B-L)

| Button | Code |
|--------|------|
| ON | 0x08 |
| RAISE | 0x09 |
| LOWER | 0x0A |
| OFF | 0x0B |

### Special Codes

| Code | Meaning |
|------|---------|
| 0xFF | Reset/Unpair broadcast |

## Device ID Format

Device IDs are 32-bit values printed on device labels in hex.
In packets, they appear in big-endian byte order matching the printed label.

Example:
- Printed: `084b1ebb`
- In packet: `08 4B 1E BB`

### Device ID Structure

Device IDs contain an embedded **Subnet Address** that identifies which processor/bridge owns the device:

```
Device ID: [Zone][SubnetLo][SubnetHi][Endpoint]
           Byte0   Byte1     Byte2    Byte3
```

| Component | Size | Description |
|-----------|------|-------------|
| Zone | 1 byte | Device/zone number within subnet (0x00-0xFF) |
| Subnet | 2 bytes | RF subnet address (little-endian in packet) |
| Endpoint | 1 byte | Target endpoint indicator |

Example device ID `062C908C`:
- Zone: 0x06
- Subnet: 902C (displayed big-endian as in Lutron Designer)
- Endpoint: 0x8C

### Endpoint Patterns

The endpoint byte indicates the target/type of communication:

| Endpoint | Meaning |
|----------|---------|
| 0x80 | Specific/unicast (e.g., bridge control endpoint) |
| 0x8F | Broadcast/all listeners (0xF = all) |
| 0x8C, 0x8D | Device-specific endpoints |

Dimmers send state reports to both 0x80 (unicast) and 0x8F (broadcast) endpoints.

The subnet appears in Lutron Designer under CCA device configuration as "Subnet Address".

### RF Subnets

The RF subnet is **not** an IP network subnet - it's a wireless address space that determines which processor/bridge controls devices.

Key facts from Lutron documentation:
- Each Main Repeater/processor owns one "device link" with up to 100 devices
- The subnet address identifies which repeater owns the device
- Devices on different subnets cannot communicate directly via RF
- Multiple repeaters in range must use different subnet addresses
- Repeaters communicate with each other over LAN, not RF

Common subnet patterns observed:
- 902C - Caseta Pro bridge
- 82D7 - RadioRA3 processor

When devices appear with the same subnet but different Zone bytes, they belong to the same processor.

## Button Press Packet (24 bytes)

### Short Format (byte 7 = 0x04)

```
Byte  0: Type (0x88 or 0x8A)
Byte  1: Sequence
Byte 2-5: Device ID (big-endian)
Byte  6: 0x21 (protocol marker)
Byte  7: 0x04 (short format)
Byte  8: 0x03
Byte  9: 0x00
Byte 10: Button code
Byte 11: Action (0x00=press, 0x01=release)
Byte 12-21: 0xCC padding
Byte 22-23: CRC-16
```

### Long Format (byte 7 = 0x0E)

```
Byte  0: Type (0x89 or 0x8B)
Byte  1: Sequence
Byte 2-5: Device ID (big-endian)
Byte  6: 0x21
Byte  7: 0x0E (long format)
Byte  8: 0x03
Byte  9: 0x00
Byte 10: Button code
Byte 11: 0x01
Byte 12-15: Device ID (repeated)
Byte 16: 0x00
Byte 17-21: Button-specific data
Byte 22-23: CRC-16
```

Long format bytes 17-21 by button:

| Button | Bytes 17-21 |
|--------|-------------|
| ON | 40 00 20 00 00 |
| FAVORITE | 40 00 21 00 00 |
| OFF | 40 00 22 00 00 |
| RAISE | 42 02 01 00 16 |
| LOWER | 42 02 00 00 43 |

Formula for ON/OFF/FAV: byte 19 = 0x1E + button_code

### Dimming Format (byte 7 = 0x0C)

RAISE/LOWER buttons use this format for continuous dimming:

```
Byte  7: 0x0C
Byte 12-15: Device ID (repeated)
Byte 16: 0x00
Byte 17-19: 42 00 02
Byte 20-21: 0xCC padding
```

## Transmission Timing

Button press sequence:
1. 6 short format packets (type 0x88/0x8A)
2. 10 long format packets (type 0x89/0x8B)
3. ~70ms gap between packets
4. Sequence increments: +2/+4 alternating for short, +6 for long

### Pico Burst Characteristics

Observed via CC1101 receiver (ESP32 @ 1MHz SPI):

| Action | Packets Observed |
|--------|------------------|
| Quick tap (press+release) | 8-12 packets |
| Maximum hold (press, hold, release) | Up to 24 packets |

The maximum of 12 packets per button action (press OR release) represents the full burst:
- 6 short format + 6 long format = 12 packets per action
- A complete press-hold-release cycle sends two bursts (press burst + release burst)

Packet loss is normal due to:
- Sync word detection timing vs continuous preamble
- FIFO read latency between packets in burst
- Radio state transitions (IDLE->RX restart)

Receiving 8-12 packets per action indicates good RF reception. The redundancy in Lutron's
protocol means even 2-3 packets are sufficient for reliable command detection.

### Bridge/Dimmer Command Reception

| Source | Packets Observed | Notes |
|--------|------------------|-------|
| Pico button | 8-12 | Excellent |
| Dimmer STATE_REPORT | 8-12 | Excellent |
| Bridge SET_LEVEL | 1-6 | Needs tuning |

Bridge SET_LEVEL commands are less reliably captured. Possible causes:
- Bridge may transmit fewer redundant packets than Picos/dimmers
- Different TX power characteristics (bridge is mains-powered, may use higher power)
- AGC settling time issues when signal is stronger than expected

**TODO:** Investigate bridge SET_LEVEL packet timing and burst count.

## Level Command (24 bytes)

Bridge sends level commands to dimmers:

```
Byte  0: Type (0x81-0x83, cycles)
Byte  1: Sequence
Byte 2-5: Bridge zone ID (little-endian for level commands only)
Byte  6: 0x21
Byte  7: 0x0E
Byte  8: 0x00
Byte  9-12: Target device ID (big-endian)
Byte 13: 0xFE
Byte 14: 0x40
Byte 15: 0x02
Byte 16-17: Level value (big-endian, 0x0000-0xFEFF = 0-100%)
Byte 18-21: 00 01 00 00
Byte 22-23: CRC-16
```

Level encoding: 100% = 0xFEFF (not 0xFFFF which is reserved/invalid)

## Dimmer State Report (24 bytes)

Dimmers broadcast their current level using two endpoint addresses:

```
Byte  0: Type (0x81-0x83, cycles)
Byte  1: Sequence
Byte 2-5: Dimmer RF TX ID (little-endian)
Byte  6: 0x00
Byte  7: 0x08
Byte  8: 0x00
Byte  9: 0x1B
Byte 10: 0x01
Byte 11: Level (0x00-0xFE = 0-100%)
Byte 12: 0x00
Byte 13: 0x1B
Byte 14: 0x92
Byte 15: Unknown (observed: 0x03)
Byte 16-21: 0xCC padding
Byte 22-23: CRC-16
```

### State Report Transmission Pattern

When a dimmer's state changes, it sends reports to TWO different endpoint addresses:

1. **First packet** - Specific endpoint (0x80): Unicast to bridge
2. **Remaining packets** - Broadcast endpoint (0x8F): For all listeners

Example observed sequence:
```
Seq 0:  222C9080  (endpoint 0x80 - unicast)
Seq 5:  222C908F  (endpoint 0x8F - broadcast)
Seq 12: 222C908F  (endpoint 0x8F - broadcast)
...repeats with 0x8F...
```

The endpoint byte (byte 2 in little-endian storage) changes:
- **0x80**: Specific/unicast address for the bridge
- **0x8F**: Broadcast address (0xF = all listeners)

This ensures the bridge receives the state update directly, while other paired devices (Picos displaying state, etc.) receive the broadcast.

## ID Relationships

- **Factory/Label ID**: Printed on device, factory-assigned (e.g., 06FDEFF4)
- **Load ID**: Assigned by bridge during pairing (e.g., AF902C00)
- **RF Transmit ID**: Derived from Load ID: `RF_TX = Load_ID XOR 0x20000008`

Example:
- 07004e8c paired -> Load ID af902c00 -> RF TX 8f902c08
- 06fdeff4 re-added -> Load ID af902c11 -> RF TX 8f902c19

## Reset/Unpair Packet (24 bytes)

Pico broadcasts "forget me" to all paired devices:

```
Byte  0: 0x89
Byte  1: Sequence (+6 per packet)
Byte 2-5: Pico ID (big-endian)
Byte  6: 0x21
Byte  7: 0x0C (reset format)
Byte  8: 0x00
Byte 9-13: FF FF FF FF FF (broadcast)
Byte 14: 0x02
Byte 15: 0x08
Byte 16-19: Pico ID (repeated)
Byte 20-21: 0xCC padding
Byte 22-23: CRC-16
```

## Bridge Pairing Protocol

Bridge pairing (Caseta, RadioRA 2/3) differs from direct Pico pairing. The bridge/processor
beacons to invite devices into pairing mode, then completes a handshake sequence.

### Pairing Command (cmd=0x08) Subtypes

| Subtype | Name | Direction | Description |
|---------|------|-----------|-------------|
| 0x01 | BEACON_INIT | Bridge->Broadcast | Initial "ready to pair" beacon |
| 0x02 | BEACON_SLOT | Bridge->Broadcast | Advertises link ID slot |
| 0x04 | CONFIRM | Bridge->Broadcast | Confirms pairing succeeded |
| 0x05 | ANNOUNCE | Device->Bridge | Device announces itself (long packet) |
| 0x06 | ACK | Bridge->Device | Acknowledges device, assigns link ID |

### Bridge Pairing Sequence

Observed from RadioRA 3 processor pairing a lamp dimmer:

**Phase 1: Initial Beacon (08 01)** ~4 seconds
```
91 01 A1 82 D7 00 21 08 00 FF FF FF FF FF 08 01 CC CC CC CC CC CC [CRC]
     |___________|                         |_____|
     Processor ID                          Cmd=08 Sub=01
```
- Bridge broadcasts "I'm in pairing mode"
- Target: FF FF FF FF FF (broadcast)
- Payload: CC padding

**Phase 2: Device Slot Beacon (08 02)** ~8 seconds
```
92 01 A1 82 D7 00 21 0C 00 FF FF FF FF FF 08 02 82 D7 1A 01 CC CC [CRC]
                 |_____|                   |_____|___________|
                 Length=12                 Cmd=08 Sub=02 + Link ID
```
- Bridge advertises the link ID to assign: `82 D7 1A 01`
- Link ID format: `[SubnetHi][SubnetLo][Zone][Type?]`
- This becomes the device's address in the system

**Phase 3: Device Announcement (08 05)** - Long Packet (0xB0 protocol)
```
B0 01 A1 82 D7 7F 21 13 00 FF FF FF FF FF 08 05 01 D4 F2 1B 04 14 02 01 FF 00 00 CC...
|__|    |_____|_____|                     |_____|___________|_____________|
Proto   Source Flag=7F                    Cmd    Device ID   Type Info
0xB0    (46 bytes)                        08 05  (dimmer)
```
- Device responds with its serial number: `01 D4 F2 1B`
- Flag byte 0x7F indicates extended packet mode
- Device type info bytes: `04 14 02 01 FF 00 00`
  - 0x04 = Device class (dimmer)
  - 0x14 = Subtype (lamp dimmer)
  - 0x02 0x01 = Firmware version?
  - 0xFF 0x00 0x00 = Capabilities/reserved

**Phase 4: Pairing Acknowledgment (08 06)**
```
93 01 A1 82 D7 00 21 0D 00 01 D4 F2 1B FE 08 06 82 D7 1A 01 0D CC [CRC]
                          |_____________|      |___________|
                          Target: Dimmer       Link ID + Zone
```
- Bridge targets device directly by its serial number
- Assigns the link ID `82 D7 1A 01`
- Byte 0x0D may indicate zone/group assignment

**Phase 5: Confirmation Beacon (08 04)**
```
92 01 A1 82 D7 00 21 0C 00 FF FF FF FF FF 08 04 82 D7 1A 01 CC CC [CRC]
```
- Bridge broadcasts that pairing succeeded
- Contains the assigned link ID

**Phase 6: Final Handshake (02 02)**
```
83 01 A1 82 D7 00 21 09 00 01 D4 F2 1B FE 02 02 01 CC CC CC CC CC [CRC]
                          |_____________|    |____|
                          Target: Dimmer     Cmd=02 Sub=02 + "01"
```
- Direct message to dimmer confirming link established
- Cmd 0x02 subtype 0x02 = "You are paired"

### Post-Pairing Configuration

After pairing, the bridge sends configuration commands:

**State Request (06 50)**
```
A1 01 A1 82 D7 00 21 15 00 01 D4 F2 1B FE 06 50 00 02 08 01 19 29 03 0B
```
- Cmd 0x06 subtype 0x50 = configuration/query
- Contains device settings (LED, dimmer type, etc.)

**State Report (06 00)**
```
81 01 21 82 D7 00 21 0E 00 FF FF FF FF FF 06 00 00 60 06 00 00 D2 [CRC]
```
- Dimmer broadcasts its current state
- Level byte 0x60 = 96 decimal

### Device IDs in Bridge Pairing

Three different IDs are involved:

| ID | Example | Description |
|----|---------|-------------|
| Processor ID | A1 82 D7 00 | Bridge/processor source address |
| Device Serial | 01 D4 F2 1B | Factory-assigned device ID (on label) |
| Link ID | 82 D7 1A 01 | Assigned by bridge during pairing |

The Link ID format appears to embed the subnet:
- `82 D7` matches the processor's subnet (from A1 **82 D7** 00)
- `1A 01` is the zone/device slot assignment

### Device Announcement Packet (46 bytes) - 0xB0 Protocol

When a device responds to bridge pairing beacons, it sends a long-format announcement:

```
Byte  0: 0xB0 (device announcement protocol)
Byte  1: Sequence
Byte 2-5: Bridge source ID (echoed from beacon)
Byte  6: 0x7F (extended packet flag)
Byte  7: 0x13 (length = 19 bytes payload)
Byte  8: 0x00
Byte 9-13: FF FF FF FF FF (broadcast target)
Byte 14: 0x08 (pairing command)
Byte 15: 0x05 (announce subtype)
Byte 16-19: Device serial number (factory ID)
Byte 20: Device class (0x04 = dimmer)
Byte 21: Device subtype (0x14 = lamp dimmer, 0x20 = wall dimmer, etc.)
Byte 22: Firmware major version
Byte 23: Firmware minor version
Byte 24: 0xFF (capabilities byte 1)
Byte 25-26: 0x00 0x00 (reserved)
Byte 27-43: 0xCC padding
Byte 44-45: CRC-16
```

**Device Class Codes (byte 20):**

| Class | Device Type |
|-------|-------------|
| 0x04 | Dimmer |
| 0x05 | Switch |
| 0x06 | Fan controller |
| 0x0A | Shade |

**Device Subtype Codes (byte 21) - for Dimmers:**

| Subtype | Description |
|---------|-------------|
| 0x14 | Lamp dimmer (plug-in) |
| 0x20 | In-wall dimmer |
| 0x22 | ELV dimmer |

The flag byte 0x7F (vs standard 0x21) indicates extended packet mode with
larger payload. RX systems must handle variable packet lengths.

### Beacon Packet (24 bytes) - Legacy Format

Simple beacon format (also used by Caseta):

```
Byte  0: Type (0x91-0x93)
Byte  1: Sequence
Byte 2-5: Load ID (big-endian)
Byte  6: 0x21
Byte  7: 0x0C (beacon format)
Byte  8: 0x00
Byte 9-13: FF FF FF FF FF (broadcast)
Byte 14: 0x08
Byte 15: 0x02
Byte 16-17: Middle bytes of Load ID
Byte 18-19: 1A 04
Byte 20-21: 0xCC padding
Byte 22-23: CRC-16
```

## Pairing Packet (53 bytes)

Picos send pairing packets to register with devices.

### Pairing Packet Types

| Category | Types | Pico Models |
|----------|-------|-------------|
| Direct-pair | B9/BB | 2-button, 5-button, 4-button R/L |
| Bridge-only | B8/BA | 4-button scene (standard) |

Direct-pair picos can pair to dimmers without a bridge.
Bridge-only picos require RadioRA3/Homeworks bridge.

During pairing, picos alternate between their two packet types:
- Direct-pair: B9 -> BB -> B9 -> BB...
- Bridge-only: B8 -> BA -> B8 -> BA...

### Pairing Packet Structure

```
Byte  0: Type (B8/B9/BA/BB)
Byte  1: Sequence (+6 per packet)
Byte 2-5: Device ID (big-endian)
Byte  6: 0x21
Byte  7: 0x25 (pairing format)
Byte 8-9: 04 00
Byte 10: Button scheme (0x04=5-button, 0x0B=4-button)
Byte 11-12: 03 00
Byte 13-17: FF FF FF FF FF (broadcast)
Byte 18-19: 0D 05
Byte 20-23: Device ID (2nd instance)
Byte 24-27: Device ID (3rd instance)
Byte 28-40: Capability bytes
Byte 41-44: FF FF FF FF
Byte 45-50: CC padding
Byte 51-52: CRC-16
```

### Capability Bytes (28-40)

| Pico Type | Pkt Types | byte10 | byte30 | byte31 | byte37 | byte38 |
|-----------|-----------|--------|--------|--------|--------|--------|
| 2-button paddle | B9/BB | 0x04 | 0x03 | 0x08 | 0x01 | 0x01 |
| 5-button | B9/BB | 0x04 | 0x03 | 0x00 | 0x02 | 0x06 |
| 4-button R/L | B9/BB | 0x0B | 0x02 | 0x00 | 0x02 | 0x21 |
| 4-button scene (std) | B8/BA | 0x0B | 0x04 | 0x00 | 0x02 | 0x27 |
| 4-button scene (custom) | B9/BB | 0x0B | 0x04 | 0x00 | 0x02 | 0x28 |

Byte 10 (button scheme) tells receiver what button codes to expect:
- 0x04: 5-button scheme (codes 0x02-0x06)
- 0x0B: 4-button scheme (codes 0x08-0x0B)

Bytes 37-38 advertise button range for 5-button scheme picos.

### Pairing Timing

- ~75ms between packets
- Sequence increments by 6, wraps at 0x48
- Minimal working: 12 packets (alternating types)
- Full sequence: ~10 seconds continuous

## Save Favorite/Scene Sequence

To save current dimmer level to a button:

### Phase 1: Hold Signal (SHORT format)

Transmit SHORT format packets continuously for ~5-6 seconds:

```
Byte  0: 0x88 or 0x8A
Byte  7: 0x04 (short format)
Byte 10: Button code
Byte 11: 0x00 (PRESS)
```

### Phase 2: Save Command (LONG format)

After holding, release with LONG format save packet:

```
Byte  0: 0x89 or 0x8B
Byte  7: 0x0D (save format)
Byte 10: Button code
Byte 11: 0x03 (SAVE action)
Byte 17: 0x00
Byte 18: 0x40 (save indicator)
Byte 19: 0x04
Byte 20: 0x1E + button_code (save target)
```

The dimmer enters save mode after ~5 seconds of continuous PRESS packets.

## ESPHome Integration

The `rf/esphome/custom_components/lutron_cc1101/` directory contains a complete ESPHome component for CC1101-based transmission and reception.

### Hardware

- ESP32 + CC1101 module
- SPI connection: CLK=GPIO18, MOSI=GPIO23, MISO=GPIO19, CS=GPIO21, GDO0=GPIO2

### Available Functions

| Function | Description |
|----------|-------------|
| send_button_press | Send button command |
| send_level | Send level command |
| send_bridge_level | Send bridge-style level with target ID |
| send_save_favorite | Save current level to button |
| send_beacon | Send pairing beacon |
| send_pairing_5button | Pair as 5-button Pico |
| send_pairing_advanced | Pair with custom capability bytes |
| send_reset | Unpair/reset device |
| send_state_report | Fake dimmer state to bridge |
| start_rx / stop_rx | Control RX mode |



