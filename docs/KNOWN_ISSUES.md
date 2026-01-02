# Known Issues and Protocol Analysis

## Current Status

| Feature | Status | Notes |
|---------|--------|-------|
| Button commands (ON/OFF/RAISE/LOWER/FAVORITE) | ✅ Working | Direct-paired 5-button Pico |
| Scene Pico buttons (BRIGHT/ENTERTAIN/RELAX/OFF) | ⚠️ Partially Working | Bridge-paired, ~70% reliability |
| Level commands (0-100%) | ✅ Working | Bridge-paired devices |
| Bridge-style level commands | ✅ Working | Controls bridge-paired dimmers |
| Fake state reports | ✅ Working | Spoof dimmer level to bridge |
| Pairing new devices | ❌ Not working | Unknown blocker |

---

## Known Issues

### Scene Pico Commands Intermittent (~70% reliability)

**Symptom:** Scene Pico button emulation (BRIGHT, ENTERTAIN, RELAX, OFF) works but not every time. Some button presses are ignored by the bridge.

**Possible causes:**
1. **Timing differences** - Real Pico may have slightly different inter-packet timing
2. **Packet type alternation** - Real Pico uses 0x89 consistently, we alternate 0x88/0x8A
3. **Sequence number tracking** - Bridge may track expected sequence from paired device
4. **Signal quality** - CC1101 transmission may have slight frequency/power differences

**Workaround:** Press button multiple times; usually works within 1-2 attempts.

**Note:** The 4-button Raise/Lower Pico (PJ2-4B-GWH-L01) works flawlessly, suggesting the issue may be specific to bridge pairing configuration rather than our RF transmission.

**Investigation needed:**
- Compare packet timing between real Pico and ESP32
- Check if bridge tracks sequence numbers per device
- Test if using fixed packet type (0x89) improves reliability

---

## Pico Button Code Reference

Different Pico models use different button code ranges:

### 5-Button Pico (PJ2-3BRL-WH-L01)
| Button | Code |
|--------|------|
| ON | 0x02 |
| FAVORITE | 0x03 |
| OFF | 0x04 |
| RAISE | 0x05 |
| LOWER | 0x06 |

### 4-Button Scene Pico (PJ2-4B-GWH-P03)
| Button | Code |
|--------|------|
| BRIGHT | 0x08 |
| ENTERTAIN | 0x09 |
| RELAX | 0x0A |
| OFF | 0x0B |

### 4-Button Raise/Lower Pico (PJ2-4B-GWH-L01)
| Button | Code |
|--------|------|
| ON | 0x08 |
| OFF | 0x0B |
| RAISE | 0x09 |
| LOWER | 0x0A |

**Important:** Always capture real button presses to verify codes for new Pico models!

---

## What We Know (Verified)

### RF Parameters
| Parameter | Value | Source |
|-----------|-------|--------|
| Frequency | 433.602844 MHz | Capture analysis |
| Data rate | 62.5 kBaud | Capture analysis |
| Modulation | 2-FSK (GFSK fails) | Testing |
| Deviation | 41.2 kHz | lutron_hacks |
| Encoding | Async N81 (start + 8 data LSB + stop) | Capture analysis |

### CRC Algorithm
```
Polynomial: 0xCA0F (15-bit)
Initial: 0x0000
Reflect: False
XOR out: 0x0000
```
Verified against captured packets.

### On-Air Packet Structure
```
[32-bit preamble 1010...] [0xFF sync] [0xFA 0xDE prefix] [N81-encoded data] [trailing zeros]
```

### Packet Types and Sizes
| Type Range | Size | Purpose |
|------------|------|---------|
| 0x80-0x8F | 24 bytes | Button commands, level commands |
| 0xB0-0xBF | 53 bytes | Pairing packets |

### Sequence Number Patterns
- **Button short packets**: Alternating +2/+4 (0→2→6→8→C→E)
- **Button long packets**: Consistent +6
- **Level commands**: +6
- **Pairing packets**: +6

---

## Hardcoded Values (Unknown Purpose)

### In All Packets
| Byte | Value | Notes |
|------|-------|-------|
| 6 | `0x21` | Always 0x21 in every packet type. Protocol version? |

### Button Command Short Format (24 bytes)
```
[0]  Type      0x88/0x8A (alternates between presses)
[1]  Sequence
[2-5] Device ID (BIG-ENDIAN - printed ID matches byte order)
[6]  0x21      ← UNKNOWN: Always 0x21
[7]  Format    0x04=standard, 0x0C=dimming, 0x0E=long
[8]  0x03      ← UNKNOWN
[9]  0x00      ← UNKNOWN
[10] Button
[11] 0x00      ← UNKNOWN (0x01 in long format)
[12-21] 0xCC padding (or extended data for dimming)
[22-23] CRC
```

### Button Command Long Format (24 bytes)
```
[0]  Type      0x89/0x8B
[1]  Sequence
[2-5] Device ID
[6]  0x21      ← UNKNOWN
[7]  0x0E      ← Long format indicator
[8]  0x03      ← UNKNOWN
[9]  0x00      ← UNKNOWN
[10] Button
[11] 0x01      ← Extended flag?
[12-15] Device ID repeated ← WHY?
[16] 0x00      ← UNKNOWN
[17-21] Button-specific:
        ON:     40 00 20 00 00
        OFF:    40 00 22 00 00
        FAV:    40 00 21 00 00
        RAISE:  42 02 01 00 16  ← UNKNOWN formula
        LOWER:  42 02 00 00 43  ← UNKNOWN formula
[22-23] CRC
```

### Level Command (24 bytes) - Sent TO dimmer
```
[0]  Type      0x81/0x82/0x83 (cycles)
[1]  Sequence
[2-5] Device ID
[6]  0x21      ← UNKNOWN
[7]  0x0E      ← Long format
[8]  0x00      ← UNKNOWN (different from button!)
[9]  0x07      ← Level command indicator?
[10] 0x03      ← UNKNOWN
[11-14] C3 C6 FE 40  ← TOTALLY UNKNOWN - zone/group/bridge ID?
[15] 0x02      ← UNKNOWN
[16-17] Level (16-bit big-endian, 0x0000-0xFEFF)
[18-21] 00 01 00 00  ← UNKNOWN trailer
[22-23] CRC
```

### Dimmer State Report (24 bytes) - Sent FROM dimmer ✅ WORKING
```
[0]  Type      0x81/0x82/0x83 (cycles)
[1]  Sequence
[2-5] Device ID (dimmer's RF transmit ID, e.g., 8F902C08)
[6]  0x00
[7]  0x08
[8]  0x00
[9]  0x1B
[10] 0x01
[11] LEVEL     (0x00-0xFE = 0-100%)
[12] 0x00
[13] 0x1B
[14] 0x92
[15] LEVEL     (duplicated)
[16-21] 0xCC padding
[22-23] CRC
```
**Note:** The dimmer's RF transmit ID (e.g., `8F902C08`) differs from its paired/label ID (e.g., `06FDEFF4`). The "902c" portion appears common to bridge-paired dimmers in the same zone.

### Dimmer Reset/Unpair Packet (24 bytes)
```
[0]  Type      0x81
[1]  Sequence
[2-5] Device ID (RF transmit ID, e.g., 8F902C08)
[6]  0x21      ← Protocol marker
[7]  0x0C      ← RESET format indicator
[8]  0x00
[9-13] FF FF FF FF FF  ← BROADCAST (tell all to forget)
[14] 0x02
[15] 0x08
[16-19] Paired ID (e.g., 06 FD EF F4)  ← The ID being unregistered
[20-21] 0xCC padding
[22-23] CRC
```

### Bridge Pairing Assignment (0xB0 packet, 24 bytes)
```
[0]  Type      0xB0
[1]  Sequence
[2-5] Bridge zone ID + 0x7F suffix (e.g., AF 90 2C 7F)
[6]  0x21
[7]  0x17      ← Pairing format
[8]  0x00
[9-13] FF FF FF FF FF  ← Broadcast
[14-15] 0x08 0x05
[16-19] Assigned device ID (e.g., 06 FD EF F4)  ← Bridge assigns this!
[20-23] 04 63 02 01  ← Unknown
```

### ID Relationship Discovery
- **Label/Factory ID** (`06FDEFF4`, `07004E8C`): Printed on device, factory-assigned
- **Load ID** (`AF902C00`, `AF902C11`): Assigned by bridge per-device during pairing
- **RF Transmit ID**: Derived from Load ID using `RF_TX = Load_ID XOR 0x20000008`
  - 07004e8c paired first → Load ID af902c00 → RF TX 8f902c08
  - 06fdeff4 re-added later → Load ID af902c11 → RF TX 8f902c19
- **Level commands** work via direct RF - NO bridge routing involved!
  - Dimmer listens for its factory ID in the payload
  - Commands work even with bridge unplugged
  - Dimmer must be paired (has learned what load ID format to accept)
- When unpaired: Dimmer does NOT respond to level commands

**Critical unknown in level command:** Bytes 11-14 (`C3 C6 FE 40`) are **zone/bridge-specific identifiers** assigned during pairing. Cross-referencing with lutron_hacks captures shows their system uses different bytes (`2c 0f 7c fe 06 40`) - confirming these vary per bridge/installation. This explains why level commands only work for bridge-paired devices.

**Bridge address (for reference):** `04 d0 b5 91` - no obvious relationship to `C3 C6 FE 40` found yet.

### Pairing Packet (53 bytes)
```
[0]  Type      0xBB
[1]  Sequence
[2-5] Device ID
[6-7] 21 25    ← Pairing indicator
[8-9] 04 00    ← UNKNOWN
[10] Button
[11-12] 03 00  ← UNKNOWN flags
[13-17] FF FF FF FF FF  ← Broadcast address
[18-19] 0D 05  ← UNKNOWN
[20-23] Device ID (2nd time) ← WHY repeated?
[24-27] Device ID (3rd time) ← WHY repeated?
[28-29] 00 20  ← UNKNOWN
[30] Button (2nd time)
[31] 00        ← UNKNOWN
[32-33] 08 07  ← UNKNOWN
[34] Button (3rd time)
[35-36] 01 07  ← UNKNOWN
[37] 02        ← UNKNOWN
[38] DevType   0x06 for 5-button Pico
[39-40] 00 00  ← UNKNOWN
[41-44] FF FF FF FF  ← Another broadcast
[45-50] CC padding
[51-52] CRC
```

**Pairing mysteries:**
- Device ID appears 3 times - why?
- Button code appears 3 times - why?
- What is device type 0x06? Other values: 0x21, 0x27 seen in captures

---

## Why Pairing Doesn't Work

### What we've tried:
1. ✅ Correct CRC (verified)
2. ✅ Correct packet structure (53 bytes)
3. ✅ Correct sequence increments (+6)
4. ❌ GFSK modulation (broke everything)
5. ❌ Different device types (0x06, 0x21, 0x27)
6. ❌ Exact replay of real Pico captures

### Theories:
1. **Bidirectional handshake** - Receiver may ACK and we're not listening
2. **Cryptographic element** - Some field may be signed/encrypted
3. **RF timing critical** - Our timing between packets may be off
4. **GFSK required for pairing** - Pairing may need GFSK even though buttons work with 2-FSK
5. **Device ID validation** - Receiver may check if device ID is "valid" Lutron format

### What would help:
- [ ] Capture RF during successful real Pico pairing with better resolution
- [ ] Sniff if receiver sends any response during pairing
- [ ] Analyze if device IDs follow a pattern (checksum? serial number encoding?)
- [ ] Try pairing with real Pico device ID but different button

---

## Open Questions

1. **Byte 6 = 0x21**: What does this mean? Protocol version? Message class?

2. **Level command bytes 11-14 (`C3 C6 FE 40`)**: This is hardcoded from a capture. What is it?
   - Zone ID?
   - Bridge address?
   - Session key?

3. **Why does device ID repeat 3 times in pairing?**

4. **What determines button-specific bytes 17-21 in long format?** ✅ PARTIALLY SOLVED
   - ON/OFF/FAV use `40 00 XX 00 00` where XX = 0x1E + button_code
     - ON (0x02): 0x1E + 0x02 = 0x20 ✅
     - FAV (0x03): 0x1E + 0x03 = 0x21 ✅
     - OFF (0x04): 0x1E + 0x04 = 0x22 ✅
   - RAISE uses `42 02 01 00 16` ← Formula still unknown
   - LOWER uses `42 02 00 00 43` ← Formula still unknown

5. **Type alternation**: Real Pico alternates 0x88↔0x8A between presses. Is this required or cosmetic?

6. **GFSK vs 2-FSK**: Why does 2-FSK work for commands but GFSK breaks things?

---

## Cross-Reference Findings (lutron_hacks)

### Lamp Unit Response Packets (Type 0xA1-0xA3)
lutron_hacks captures show lamp units (PD-3PCL) transmit response packets that include BOTH:
- Their own device ID (bytes 2-5)
- The Pico's device ID (bytes 17-20)

This confirms **bidirectional communication** exists in the protocol. Example:
```
a3 01 a1 85 5f 00 21 1a 00 01 2c 0f 7c fe 06 40 02 a2 4c 77 00 20 ...
      └──────────┘                               └──────────┘    └── Command (0x20=ON)
      Lamp unit ID                               Pico ID
```

### Different Systems Have Different Zone Bytes
- lutron_hacks system: `2c 0f 7c fe 06 40`
- Our system: `C3 C6 FE 40`
- Common suffix: `FE 40` may be protocol constants
- Varying prefix is bridge/zone specific

### Byte 6 Values
- `0x21` - Used by Pico remotes and bridge commands
- `0x00` - Used by lamp units (PD-3PCL) in lutron_hacks

### Byte 7 (Format) Values
- `0x04` - Short button command
- `0x0C` - Dimming command (with extended data)
- `0x0E` - Long format (button release, level commands)
- `0x1A` - Lamp unit response format
- `0x10` - Bridge pairing beacon

---

## Test Results Log

| Date | Test | Result | Notes |
|------|------|--------|-------|
| 2024-12-31 | Button sequence fix | ✅ Fixed | Alternating +2/+4 pattern |
| 2024-12-31 | Level command reliability | ✅ Fixed | Reset sequence to 0x00 |
| 2024-12-31 | ON/OFF commands | ✅ Working | 100% reliable now |
| 2024-12-31 | Level commands | ✅ Working | 100% reliable now |
| 2024-12-31 | Pairing | ❌ Failed | Unknown blocker |
| 2024-12-31 | GFSK modulation | ❌ Failed | Reverted to 2-FSK |
| 2024-12-31 | lutron_hacks cross-ref | ✅ Done | Zone bytes differ per bridge |
| 2024-12-31 | Command byte formula | ✅ Solved | ON/OFF/FAV = 0x1E + button |
| 2025-01-01 | Device ID byte order fix | ✅ Fixed | Was little-endian, now big-endian |
| 2025-01-01 | Scene Pico (084b1ebb) | ⚠️ Partial | Works ~70% of time, intermittent |
| 2025-01-01 | Bridge-paired device control | ✅ Working | Via Scene Pico emulation |
| 2025-01-01 | 4-button Pico button codes | ✅ Fixed | Uses 0x08-0x0B, not 0x02-0x06 |
| 2025-01-01 | Pico 08692d70 (PJ2-4B-GWH-L01) | ✅ Working | Both Caseta and RA3 bridges respond |
| 2025-01-01 | Dimmer state report capture | ✅ Done | Discovered packet structure differs from commands |
| 2025-01-01 | Fake state reports (8f902c08) | ✅ Working | Can spoof dimmer level to bridge |
| 2025-01-01 | Dimmer reset capture | ✅ Done | Reset packet uses 0x0C format, broadcasts paired ID |
| 2025-01-01 | Dimmer re-pairing capture | ✅ Done | RF transmit ID is deterministic (same after re-pair) |
| 2025-01-01 | Bridge pairing (0xB0) | ✅ Analyzed | Bridge assigns paired ID via 0xB0 packets |
| 2025-01-01 | Different room pairing test | ✅ Done | RF transmit ID unchanged on same bridge |
| 2025-01-01 | Second dimmer (07004e8c) test | ✅ Done | RF TX = Load_ID XOR 0x20000008 |
| 2025-01-01 | Re-add 06fdeff4 to bridge | ✅ Done | Got new Load ID af902c11, RF TX 8f902c19 |
| 2025-01-01 | Bridge commands after re-pair | ✅ Working | Factory ID in payload, direct RF (no bridge needed) |

---

## Resources

- **lutron_hacks repo:** https://github.com/Entropy512/lutron_hacks
  - CRC algorithm from STM32 firmware
  - Receiver implementation
  - Packet captures

---

## Next Steps

1. ~~Fix button reliability~~ ✅ DONE
2. ~~Clean up code for library use~~ ✅ DONE
3. ~~Research level command bytes 11-14 (C3 C6 FE 40)~~ ✅ DONE - Confirmed bridge/zone-specific
4. Investigate pairing handshake (need RX capability)
5. Try pairing with real Pico ID, different button
6. Document device type codes
7. Implement RX mode to capture bridge/lamp responses
8. Investigate relationship between bridge address and zone bytes
