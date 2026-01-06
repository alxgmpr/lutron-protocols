# Pico Direct Pairing Protocol Analysis

## CONFIRMED FINDINGS (2026-01-02)

### 5-Button Capability Pairing WORKS - INCLUDING BRIDGE-PAIRED DEVICES!

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

**CRITICAL:** This works with **BRIDGE-PAIRED devices** too! The earlier failures were NOT
due to bridge interference - they were purely due to capability byte mismatch.

**Note:** Some quirky behavior with sequential RAISE/LOWER commands (occasional on/off instead of dim).

### Key Discovery: Capability Bytes Are Everything!

The original issue was using **Scene Pico capability bytes** while sending **5-button codes**.
When capability bytes match button codes, everything works - even on bridge-paired devices.

| Pico Type | Capability Bytes | Button Codes | Works? |
|-----------|------------------|--------------|--------|
| Scene (4-btn) | [30]=0x04, [34]=0x04, [38]=0x27 | 0x08-0x0B | Untested |
| **5-Button** | **[30]=0x03, [34]=0x03, [38]=0x06** | **0x02-0x06** | **YES** |

### Bridge-Paired Devices: NOT a Blocker!

Earlier hypothesis was wrong. Bridge-paired devices DO accept direct Pico pairing.
The issue was purely the capability bytes not matching the button codes we sent.

### Scene Picos: CANNOT Pair Directly!

**MAJOR FINDING (2026-01-02):** Scene Picos fundamentally cannot pair directly to dimmers.

**Discovery:** Even the REAL Scene Pico (084B1EBB) fails to pair directly to a dimmer!
This is not a bug in our implementation - it's a protocol limitation.

**Why Scene Picos Require a Bridge:**
- Scene buttons (Bright/Entertain/Relax/Off) represent specific brightness levels
- These levels must be programmed via the bridge
- Without a bridge, the dimmer has no idea what brightness "Entertain" means
- The bridge tells the dimmer: "Scene 1 from this Pico = 100%, Scene 2 = 75%", etc.

**Scene Pico RF Behavior (for reference):**
- Button hold: ~0.8s of 0x89 packets (btn=0x0B)
- BA packets: ~135 packets over 4.4 seconds
- BB packets: None
- But even with perfect packets, direct pairing is rejected

| Pico Type | Direct Pairing | Bridge Required |
|-----------|---------------|-----------------|
| 5-Button (ON/FAV/OFF/RAISE/LOWER) | ✅ Works | Optional |
| Scene (Bright/Entertain/Relax/Off) | ❌ Not possible | **Required** |

**Conclusion:** For direct Pico emulation without a bridge, use 5-button capability only.

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

- [x] Add option to use Capture A protocol variant (old=0x21/0x17)
- [x] Add configurable packet counts (BA/BB) - supports BA-only (BB=0)
- [x] Add capability byte options (Scene vs 5-button)
- [x] Fix BA/BB capability mismatch in standard pairing (now consistent 5-button)
- [x] Verify Scene Picos cannot pair directly (confirmed - requires bridge)
- [ ] Add logging of pairing acknowledgments
- [ ] Create test mode to send single packets for RTL-SDR capture

## Working Configuration

For direct Pico pairing without a bridge:
- **Capability:** 5-button (0x03/0x03/0x06)
- **Packets:** 12 BA + 6 BB minimum
- **Protocol:** New (0x25)
- **Button codes:** 0x02-0x06 (ON/FAV/OFF/RAISE/LOWER)

---

## Bridge Pairing Protocol Analysis (2026-01-06)

### RadioRA 3 Lamp Dimmer Pairing Capture

Captured RR3 processor pairing a lamp dimmer to understand bridge pairing flow.

**Key Device IDs:**
- RR3 Processor: `A1 82 D7 00`
- Lamp Dimmer Serial: `01 D4 F2 1B`
- Assigned Link ID: `82 D7 1A 01`

### Bridge Pairing Sequence (cmd=0x08)

| Phase | Subtype | Direction | Packet Structure |
|-------|---------|-----------|------------------|
| 1 | 0x01 | Bridge->Broadcast | Initial beacon, CC padding |
| 2 | 0x02 | Bridge->Broadcast | Beacon with link ID slot |
| 3 | 0x05 | Device->Broadcast | Device announcement (0xB0 protocol, 46 bytes) |
| 4 | 0x06 | Bridge->Device | Acknowledgment with link ID assignment |
| 5 | 0x04 | Bridge->Broadcast | Confirmation beacon |
| 6 | 0x02/0x02 | Bridge->Device | Final handshake (cmd=0x02 sub=0x02) |

### Device Announcement Packet (0xB0 Protocol)

The device responds with a long 46-byte packet:
```
B0 01 A1 82 D7 7F 21 13 00 FF FF FF FF FF 08 05 01 D4 F2 1B 04 14 02 01 FF 00 00
                                               |_____|___________|_____________|
                                               Cmd    Device ID   Type Info
```

**Device Type Info Bytes:**
- Byte 20: Device class (0x04 = dimmer)
- Byte 21: Subtype (0x14 = lamp dimmer)
- Byte 22-23: Firmware version (0x02 0x01)
- Byte 24-26: Capabilities (0xFF 0x00 0x00)

**Flag Byte 0x7F:**
The flag byte changes from 0x21 (standard) to 0x7F for extended packet mode.
This indicates the receiver should expect a larger payload.

### RR3 vs Caseta Comparison

Both systems use identical cmd=0x08 subtypes:
- 0x01, 0x02 for beacons
- 0x04 for confirmation
- 0x05 for device announcement
- 0x06 for acknowledgment

**Caseta Smart Bridge source IDs:** `AD 90 2C 00`, `AF 90 2C 00`
**RR3 Processor source ID:** `A1 82 D7 00`

### Link ID Structure

The assigned link ID `82 D7 1A 01` appears to encode:
- `82 D7` - Subnet (matches processor's A1 **82 D7** 00)
- `1A` - Zone assignment
- `01` - Device type or endpoint

### Implementation Requirements for Bridge Emulation

1. **TX: Beacon Generation**
   - Send 08 01 for ~4 seconds (initial beacon)
   - Send 08 02 with chosen link ID for ~8 seconds

2. **RX: Handle 0xB0 Packets**
   - Must receive 46-byte device announcements
   - Parse device serial, class, subtype, firmware

3. **TX: Complete Handshake**
   - Send 08 06 targeting device by serial, with link ID
   - Send 08 04 broadcast confirmation
   - Send 02 02 direct to device

4. **Post-Pairing**
   - Send configuration via 06 50 commands
   - Handle 06 00 state reports from device
