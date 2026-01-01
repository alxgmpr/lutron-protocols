# Known Issues and Protocol Analysis

## Current Status

| Feature | Status | Notes |
|---------|--------|-------|
| Button commands (ON/OFF/RAISE/LOWER/FAVORITE) | ✅ Working | Using real Pico device ID |
| Level commands (0-100%) | ✅ Working | Bridge-paired devices |
| Pairing new devices | ❌ Not working | Unknown blocker |

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
[2-5] Device ID (little-endian)
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

### Level Command (24 bytes)
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
