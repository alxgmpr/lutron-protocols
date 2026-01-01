# Lutron Clear Connect Type A Protocol

## RF Parameters
- **Frequency**: 433.602844 MHz
- **Modulation**: 2-FSK
- **Data Rate**: 62.5 kBaud
- **Deviation**: ~50 kHz
- **Encoding**: N81 serial (start=0, 8 data bits LSB first, stop=1)
- **Sync Pattern**: `FA DE` prefix after preamble
- **CRC**: CRC-16 with polynomial 0xCA0F

## Device Architecture

### Caseta System (Bridge-Mediated)
```
┌─────────┐         ┌────────────┐         ┌─────────┐
│  Pico   │ ──RF──► │   Bridge   │ ──RF──► │ Dimmer/ │
│ Remote  │         │ (L-BDG2-WH)│         │ Switch  │
└─────────┘         └────────────┘         └─────────┘
                          │
                          ▼
                    Lutron App
                   (Assignment)
```

### Pairing Process (Bridge-Mediated)

**IMPORTANT**: The BRIDGE initiates and coordinates all pairing. Devices do NOT pair directly to each other in a bridge-based system.

#### Pairing a Dimmer/Switch to Bridge:
1. Put the **Bridge** into pairing mode (via Lutron app)
2. On the dimmer/switch: **press and hold the DOWN button for 10+ seconds**
3. Dimmer sends pairing packets (0xB9 type)
4. Bridge receives and registers the dimmer

#### Pairing a Pico to Bridge:
1. Put the **Bridge** into pairing mode (via Lutron app)
2. On the Pico: **press and hold the OFF button for 10+ seconds**
3. Pico sends pairing packets (0x88 button presses, then 0xB9 pairing)
4. Bridge receives and registers the Pico

#### Assigning Pico to Control Dimmer:
1. In Lutron app, assign which Pico controls which dimmer(s)
2. This is software configuration - no RF pairing occurs
3. When Pico is pressed, Bridge hears the command and relays to assigned dimmer(s)

### Direct Pairing (No Bridge)
Some devices can pair directly without a bridge:
- Pico directly to dimmer (dimmer in pairing mode, Pico long-press)
- This creates a direct RF link, no bridge involved

## Packet Types

| Type | Name | Description |
|------|------|-------------|
| 0x88 | BTN_SHORT_A | Button press, short format, variant A |
| 0x89 | BTN_LONG_A | Button press, long format, variant A |
| 0x8A | BTN_SHORT_B | Button press, short format, variant B |
| 0x8B | BTN_LONG_B | Button press, long format, variant B |
| 0x81-0x83 | LEVEL | Level report from dimmer |
| 0x91-0x93 | BEACON | Bridge pairing mode beacon |
| 0x9B, 0x9F | RESPONSE | Bridge/dimmer response to Pico commands |
| 0xA1-0xA3 | PAIR_ACK | Pairing acknowledgment |
| 0xB0 | PAIR_HANDSHAKE | Pairing handshake (contains target device ID) |
| 0xB9 | PAIR_REQUEST | Pairing request from Pico/dimmer |
| 0xC1-0xE0 | BRIDGE_CMD | Bridge configuration/command packets |

## Button Codes

### 5-Button Dimmer Pico (PJ2-3BRL)
| Button | Code |
|--------|------|
| ON | 0x02 |
| FAVORITE | 0x03 |
| OFF | 0x04 |
| RAISE | 0x05 |
| LOWER | 0x06 |

### 4-Button Scene Pico (PJ2-4B)
| Button | Code |
|--------|------|
| Scene 1 (Bright) | 0x08 |
| Scene 2 (Entertain) | 0x09 |
| Scene 3 (Relax) | 0x0A |
| Scene 4 (Off) | 0x0B |

## Packet Structure

### Button Packet (0x88-0x8B)
```
Byte  0: Packet type (0x88-0x8B)
Byte  1: Sequence number
Byte 2-5: Device ID (big-endian)
Byte  6: 0x21 (protocol marker)
Byte  7: Format (0x04=short, 0x0E=long)
Byte  8: 0x03
Byte  9: 0x00
Byte 10: Button code
Byte 11: 0x00 (short) or 0x01 (long)
Byte 12-21: Additional data (long format) or 0xCC padding
Byte 22-23: CRC-16
```

### Level Report (0x81-0x83) - Dimmer Status
```
Byte  0: Packet type (0x81-0x83)
Byte  1: Sequence number
Byte 2-5: Dimmer zone ID
Byte  6: 0x21 or 0x00
Byte  7: 0x08
...
Byte 16-17: Level value (0x0000-0xFEFF = 0-100%)
...
Byte 22-23: CRC-16
```

### Level Command (0x81-0x83) - Bridge to Dimmer
**KEY DISCOVERY**: Bridge uses SAME packet type but with TARGET device ID embedded!
```
Byte  0: Packet type (0x81-0x83)
Byte  1: Sequence number
Byte 2-5: BRIDGE zone ID (e.g., AF 90 2C 00)
Byte  6: 0x21
Byte  7: 0x0E
Byte  8: 0x00
Byte 9-12: TARGET DIMMER ID (e.g., 06 FD EF F4)
Byte 13-14: FE 40
Byte 15: 0x02
Byte 16-17: Level value (0x0000-0xFEFF = 0-100%)
Byte 18-21: 00 01 00 00
Byte 22-23: CRC-16
```

**Example** (Bridge sets dimmer 06fdeff4 to 100%):
```
83 02 af 90 2c 00 21 0e 00 06 fd ef f4 fe 40 02 fe ff 00 01 00 00 89 7f
```

### Pairing Beacon (0x91-0x93)
Bridge broadcasts these when in pairing mode.
```
Byte  0: Packet type (0x91-0x93)
Byte  1: Sequence number
Byte 2-5: Bridge zone ID (e.g., AF 90 2C 00)
Byte  6: 0x21
Byte  7: 0x08
Byte  8: 0x00
Byte 9-13: Broadcast (FF FF FF FF FF)
Byte 14-15: 0x08 0x01
...
```

### Pairing Handshake (0xB0)
Sent by bridge during pairing to register a new device. ~30 packets burst over 1 second.
```
Byte  0: 0xB0 (type)
Byte  1: Sequence number (0, 2, 6, 7, 8, 12...)
Byte 2-5: Bridge pairing zone (A0/A2/AF 90 2C 7F - varies slightly)
Byte  6: 0x21 (protocol marker)
Byte  7: 0x17 (format/length indicator)
Byte  8: 0x00
Byte 9-13: FF FF FF FF FF (broadcast address)
Byte 14-15: 08 05 (pairing command marker)
Byte 16-19: TARGET DEVICE LABEL ID (e.g., 06 FD EF F4)
Byte 20-23: 04 63 02 01 (unknown - possibly device type/capabilities)
Byte 24-26: FF 00 00 (unknown)
Byte 27-30: varies (01 03 15 00 typical, some packets differ: 40 50 00 DC)
Byte 31+: CC padding
```

**Key Discovery**: The dimmer's printed label ID (e.g., 06fdeff4) appears in bytes 16-19 of the 0xB0 pairing packet. This confirms the bridge knows the target device during pairing.

**Pairing Hypothesis**: The bridge listens for devices broadcasting their label IDs, then sends 0xB0 packets with that ID to complete the handshake. The ESP32 could potentially:
1. Listen for bridge beacons (0x91-0x93) to detect pairing mode
2. Broadcast its own ID (similar to what a real Pico/dimmer does)
3. Wait for bridge to send 0xB0 with ESP32's ID to confirm registration

### Bridge Configuration Packets (0xC1-0xE0)
After pairing handshake, bridge sends configuration packets.
```
Types observed: 0xC1, 0xC2, 0xC5, 0xC7, 0xC8, 0xCB, 0xCD, 0xCE,
                0xD1, 0xD3, 0xD4, 0xD9, 0xDA, 0xDF, 0xE0

Device IDs use 902c prefix (e.g., 902cfffc, 902c5f9e, 902cff7f)
These appear to be sub-channels or configuration endpoints.
```

## Pairing Timeline (Observed from Capture)

Complete dimmer-to-bridge pairing sequence:

```
Time (s)   Phase              Details
─────────────────────────────────────────────────────────────
0-26       BEACON (0x92)      Bridge advertises pairing mode
                              ~1Hz cycle, device ID af902c00

26-27      HANDSHAKE (0xB0)   Burst of ~30 packets in 1 second
                              Device ID af902c7f
                              Contains target label ID in bytes 16-19

28-52      BEACON (0x91)      Bridge continues beaconing
                              Different beacon type than initial

52+        CONFIG (0xC1-0xE0) Bridge sends configuration
                              Multiple sub-device IDs (902cXXXX)
                              Interleaved packet types
```

### Key Zone IDs Observed During Pairing
| Zone ID    | Role |
|------------|------|
| af902c00   | Bridge main zone (beacons, ACKs, levels) |
| af902c7f   | Bridge pairing zone (0xB0 handshake) |
| 902cXXXX   | Configuration sub-channels |

## Communication Flow (Bridge-Mediated)

When a Pico button is pressed:
1. **Pico** sends button packets (0x88/0x89/0x8A/0x8B) with its device ID
2. **Bridge** receives the packets
3. **Bridge** looks up which dimmer(s) are assigned to this Pico+button
4. **Bridge** sends command to dimmer(s) using the bridge's authority
5. **Dimmer** receives command and adjusts level
6. **Dimmer** may send level report (0x81-0x83) back to bridge

## Open Questions
- What packet types does the bridge use to command dimmers? (0x9B/0x9F seen)
- How does the bridge authenticate/validate Pico commands?
- Is there rolling code or session state that prevents replay?
- Why do spoofed Pico commands not work through the bridge?
- What triggers the 0xB0 handshake? The dimmer's pairing request (0xB9?) was not captured
- Why does the beacon type change from 0x92 to 0x93 during pairing?

## Working Features

### Bridge-Style Level Commands (WORKING!)
**Discovery:** The bridge sends LEVEL packets (0x81-0x83) with the TARGET device ID embedded in the payload!

**Key insight:** Instead of using the dimmer's ID as the source, the bridge:
- Uses its own zone ID (`AF902C00`) as source (bytes 2-5)
- Puts the target dimmer's printed label ID in the payload (bytes 9-12)

**Implementation:** `send_bridge_level(bridge_zone_id, target_device_id, level_percent)`

**Tested working:** ESP32 can control bridge-paired dimmer 06fdeff4 using this format!

## Known Issues / Failed Experiments

### ESP32 Beacon Transmission (Not Working)
**Attempted:** Sending 0x92 pairing beacon packets from ESP32 to make dimmers flash.

**Result:** No effect on dimmers or Picos, even when using real bridge zone ID.

**Possible causes:**
1. **Missing authentication** - Beacons may require cryptographic element
2. **Timing/cadence** - May need exact burst patterns
3. **Missing setup packets** - Bridge may send something before beacons start

## Observations from Captures

### Missing Dimmer Pairing Request
In our capture, the expected 0xB9 pairing request from the dimmer was NOT captured. The bridge transitions directly from 0x92 beacons to 0xB0 handshake at t=26.5s. Possible explanations:
1. Dimmer pairing uses different RF parameters (frequency offset, data rate)
2. Dimmer signal was too weak for RTL-SDR
3. Dimmer uses a very short burst that was missed
4. Pairing request uses packet type other than 0xB9

### Beacon Type Transition
The bridge changes beacon types during pairing:
- **0x92**: Initial pairing mode (t=0-25s)
- **0x93**: After detecting device (t=25.7s+)
- **0x91**: After handshake (t=28s+)

This suggests the beacon type indicates pairing state/progress.

### Visual Confirmation: Device LED Behavior
When bridge enters pairing mode:
- **Paired devices** (Picos, dimmers): Flash at normal rate
- **Unpaired devices**: Flash at slightly slower rate

This confirms:
1. Beacons are broadcast to ALL devices in RF range
2. Devices interpret their pairing status locally
3. Unpaired devices enter "ready to pair" state, waiting for their ID in a 0xB0 handshake
4. The beacon content/type signals pairing mode to nearby devices
