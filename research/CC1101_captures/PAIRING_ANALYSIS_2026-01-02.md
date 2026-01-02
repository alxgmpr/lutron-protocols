# Pico Direct Pairing Protocol Analysis

## CONFIRMED FINDINGS (2026-01-02)

### 5-Button Capability Pairing WORKS!

**Experiment:** Paired device `0xCC110003` with:
- BA packets: 12
- BB packets: 6
- Protocol: new (0x25)
- Pico type: **5-button** (capability bytes [30]=0x03, [34]=0x03, [38]=0x06)

**Result:** All 5-button codes work correctly:
- 0x02 = ON ✓
- 0x03 = FAVORITE ✓
- 0x04 = OFF ✓
- 0x05 = RAISE ✓
- 0x06 = LOWER ✓

**Note:** Some quirky behavior with sequential RAISE/LOWER commands (occasional on/off instead of dim).

### Key Discovery: Capability Bytes Matter!

The original issue was using **Scene Pico capability bytes** while sending **5-button codes**.
When capability bytes match button codes, everything works.

| Pico Type | Capability Bytes | Button Codes |
|-----------|------------------|--------------|
| Scene (4-btn) | [30]=0x04, [34]=0x04, [38]=0x27 | 0x08-0x0B |
| 5-Button | [30]=0x03, [34]=0x03, [38]=0x06 | 0x02-0x06 |

### Minimal Packets Sufficient

**12 BA + 6 BB** packets work fine. No need for 60 + 12.
This reduces pairing time from ~6s to ~1.5s.

---

## Summary of Findings

We have TWO different pairing packet captures that BOTH work, but have different byte values.
This suggests device-type-specific encoding or protocol versioning.

## Capture Comparison

### Capture A: Device 02A24C77 (Original pico_pairrequest.txt)
From older research - unknown Pico model

### Capture B: Devices 084B1EBB & 05851117 (Corrected 2026-01-02)
- 084B1EBB = Scene Pico (4-button: Bright/Entertain/Relax/Off)
- 05851117 = 5-Button Pico (ON/FAV/OFF/RAISE/LOWER)

## Byte-by-Byte Comparison

### 0xBA Capability Announcement

| Byte | Capture A (02A24C77) | Capture B (084B1EBB) | Our Code | Notes |
|------|---------------------|---------------------|----------|-------|
| [7]  | 0x21 | **0x25** | 0x25 | Format marker - different! |
| [10] | 0x07 | **0x0B** | 0x0B | Packet subtype |
| [19] | 0x00 | **0x05** | 0x05 | Pairing mode indicator |
| [30] | 0x03 | 0x04 | 0x04 | Capability field |
| [34] | 0x03 | 0x04 | 0x04 | Capability field |
| [35] | 0x00 | 0x01 | 0x01 | Capability field |
| [37] | 0xFF | 0x02 | 0x02 | Capability field |
| [38] | 0xFF | 0x27 | 0x27 | Capability field |
| [39-40] | 0xFF 0xFF | 0x00 0x00 | 0x00 0x00 | Capability terminator |
| [41-44] | 0xCC | **0xFF** | 0xFF | Critical! Must be FF |

### 0xBB Pair Request

| Byte | Capture A (02A24C77) | Capture B (05851117) | Our Code | Notes |
|------|---------------------|---------------------|----------|-------|
| [7]  | **0x17** | 0x25 | 0x25 | Format - A uses different value! |
| [10] | 0x07 | **0x04** | 0x04 | Packet subtype |
| [19] | **0x01** | 0x05 | 0x05 | Pairing mode indicator |
| [28-40] | Mostly 0xFF | Capability info | Cap info | Different structure |

## Key Observations

### 1. Two Valid Protocol Variants
Both captures work for pairing, but use different byte values. This suggests:
- Protocol versioning (old vs new firmware)
- Device type encoding (Scene Pico vs 5-button Pico)
- Or both captures are valid for different scenarios

### 2. Capture A vs B Key Differences

**Capture A** (02A24C77):
- BA: byte[7]=0x21, byte[19]=0x00
- BB: byte[7]=0x17, byte[19]=0x01
- BA≠BB byte[7] values

**Capture B** (084B1EBB/05851117):
- BA: byte[7]=0x25, byte[19]=0x05
- BB: byte[7]=0x25, byte[19]=0x05
- BA=BB byte[7] values (consistent)

### 3. Capability Info Bytes [28-40]

These appear to describe device capabilities:

**Capture B (Scene Pico 084B1EBB) BA:**
```
00 20 04 00 08 07 04 01 07 02 27 00 00
```

**Capture B (5-Button Pico 05851117) BB:**
```
00 20 03 00 08 07 03 01 07 02 06 00 00
```

Differences at positions [30], [34], [38]:
- Scene Pico: 04, 04, 27
- 5-Button:   03, 03, 06

**Hypothesis**: These encode button configuration (04=4 buttons, 03=5 buttons?)
and possibly button code range (0x27 includes Scene codes, 0x06 is 5-button OFF code).

### 4. Why Bridge-Paired Devices May Reject Us

When a device is paired through a bridge:
1. Bridge sends 0xB0 handshake with device type/capabilities
2. Device stores expected controller capabilities
3. Direct pairing advertises different capabilities
4. Device may reject or partially accept based on capability mismatch

**Evidence**: Our ESP32 pairs to standalone relay, but buttons behave unexpectedly
(OFF → 50%, FAV → 75% - suggesting Scene button mapping).

### 5. Double Acknowledgment on Relay

The relay acknowledged twice during our pairing test. Possible causes:
- We send 60 BA + 12 BB packets - device may ack after each phase
- Sequence wraps around (0x00, 0x06... 0x42, 0x00...) - device sees "new" pairing
- Real Pico might send fewer packets or different timing

**Experiment**: Try sending fewer packets:
- Phase 1: 12-15 BA packets (covers one sequence cycle)
- Phase 2: 6-8 BB packets

## Why Pairing Fails with Bridge-Paired Devices

### Theory 1: Device Rejects Unknown Picos
Bridge-paired devices may maintain a "known device list":
- When bridge pairs a Pico, it tells the device about it
- Direct pairing from unknown device is blocked
- Standalone devices have no such restriction

### Theory 2: Capability Mismatch
Our ESP32 advertises Scene Pico capabilities (bytes [30]=0x04, etc.)
but sends 5-button Pico button codes (0x02-0x06).
- Standalone device: Accepts any valid command
- Bridge-paired: Expects commands matching registered capabilities

### Theory 3: Protocol Version
Capture A uses older protocol (byte[7]=0x21/0x17)
Capture B uses newer protocol (byte[7]=0x25)
- Newer devices may require newer protocol
- Older devices may accept both
- Bridge-paired devices may be locked to version used during pairing

## Recommendations for Investigation

### Immediate Tests
1. **Reduce packet count**: Try 12 BA + 6 BB instead of 60 + 12
2. **Match capability to button codes**: If using 0x02-0x06 buttons, use 5-button capability bytes
3. **Try Capture A protocol**: Use byte[7]=0x21/0x17 variant

### Capture More Data
1. Capture pairing from REAL 5-button Pico to compare capabilities
2. Capture what happens when Pico pairs to bridge-paired device (does bridge intervene?)
3. Capture bridge's 0xB0 handshake to see what capabilities it advertises

### Protocol Experiments
1. Try pairing with device in bridge pairing mode (bridge sending beacons)
2. See if bridge forwards/modifies our pairing packets
3. Compare standalone vs bridge-paired device behavior with same packets

## Implementation Checklist

- [ ] Add option to use Capture A protocol variant
- [ ] Add configurable packet counts (BA/BB)
- [ ] Add capability byte options (Scene vs 5-button)
- [ ] Add logging of pairing acknowledgments
- [ ] Create test mode to send single packets for RTL-SDR capture
