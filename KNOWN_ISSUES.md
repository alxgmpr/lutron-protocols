# Known Issues and Open Questions

## Reliability Issues

### Commands only work every ~2nd or ~3rd press
**Status:** Under investigation

**Symptom:** RF TX commands work approximately every 2nd or 3rd button press. Something in our rotation/alternation pattern causes intermediate presses to fail.

**Observed behavior:**
- ON/OFF/RAISE/LOWER/FAVORITE all exhibit this pattern
- Suggests a systematic issue rather than random RF problems
- The "rotating" element (type alternation? sequence?) seems to be the culprit

**Possible causes:**
1. **Type alternation mismatch** - We alternate A/B types (0x88/89 vs 0x8A/8B) between button presses, but the receiver may expect a specific pattern or may track state differently.

2. **Sequence number rejection** - The receiver may validate sequence numbers and reject packets with "invalid" sequences. Real Picos use a complex sequence pattern (possibly rolling code or LFSR), while we use simple incrementing.

3. **Timing differences** - Our packet timing (70ms between packets) may not match exactly what the receiver expects.

4. **RF signal quality** - CC1101 output power or modulation characteristics may differ from real Pico.

5. **State synchronization** - The receiver may track which "slot" it expects next and reject out-of-sequence transmissions.

**Next steps:**
- [ ] Capture CC1101 transmission and compare to real Pico side-by-side
- [ ] Analyze sequence number pattern more deeply
- [ ] Test with fixed sequence numbers
- [ ] Measure RF signal characteristics

---

## Protocol Understanding Gaps

### Sequence number pattern unknown
**Status:** Partially understood

The sequence number in byte 1 does NOT follow a simple increment pattern. Observed deltas include 2, 4, 6, 12, 130, 132 - suggesting either:
- Rolling code system
- LFSR-based counter
- Time-dependent component

**Impact:** May cause receiver to reject packets as replays or invalid.

---

## Pairing Protocol Discovery (2024-12-31)

### Key Findings (Updated)

**CORRECTION: Pairing uses NORMAL baud rate (62.5 kbaud)**
- Initial analysis incorrectly suggested 4x slower baud
- The longer burst duration (~10ms vs ~5ms) is due to LONGER PACKETS, not slower baud
- Real Pico pairing packets are 37+ bytes, not 24

**Pairing packet types: 0xBB (5-button Pico) and 0x8A (short button)**
- During pairing, Pico sends both long 0xBB packets and short 0x8A packets
- ~150 long packets + ~36 short packets in a ~14 second pairing sequence

**Full pairing packet structure (37 bytes decoded):**
```
BB SS DD DD DD DD 21 25 04 00 Bt 03 00 FF FF FF FF FF 0D 05 DD DD DD DD DD DD DD DD 00 20 03 00 TT TT TT TT TT
```
Where:
- BB: Packet type (0xBB for pairing)
- SS: Sequence number (complex pattern, not simple increment)
- DD DD DD DD: Device ID (little-endian) - appears 3 times!
- 21 25: Pairing format indicator
- 04 00: Unknown constants
- Bt: Button code (e.g., 0x04 = OFF, 0x02 = ON)
- 03 00: Pairing flags
- FF FF FF FF FF: Broadcast address (5 bytes)
- 0D 05: Constants
- Device ID repeated 2nd time (bytes 20-23)
- Device ID repeated 3rd time (bytes 24-27)
- 00 20 03 00: Unknown constants
- TT TT TT TT TT: Trailing bytes (08 07 03 01 07) - NOT standard CRC!

**Captured pairing example (device 0x17118505):**
```
BB 00 05 85 11 17 21 25 04 00 04 03 00 FF FF FF FF FF 0D 05 05 85 11 17 05 85 11 17 00 20 03 00 08 07 03 01 07
```

**Sequence number pattern during pairing:**
NOT a simple +2 increment! Observed pattern: 00, 01, 02, 06, 07, 08, 0C, 0D, 12, 13...
Deltas: [1, 1, 4, 1, 1, 4, 1, 5, 1, 1, 4, ...]

**Trailing bytes mystery:**
The last 5 bytes (08 07 03 01 07) do NOT match any standard CRC polynomial tested.
May be protocol markers, version info, or device capability flags.

### Factory reset behavior unknown
**Status:** Not investigated

Real Picos can be factory reset (triple-tap, hold, triple-tap on OFF button). Questions:
- Does this reset the sequence counter?
- Does it change the device ID?
- Does it affect pairing state?

### LOWER and FAVORITE button structure
**Status:** Need captures

We have captures for ON, OFF, and RAISE. Need to capture:
- [ ] LOWER button
- [ ] FAVORITE/STOP button (middle button)
- [ ] Press-and-hold behavior

---

## Hardware Notes

### CC1101 module differences
Using E07-M1101D module. May have different RF characteristics than original Lutron hardware.

### ESP32 timing
ESPHome/Arduino framework may introduce timing jitter in packet transmission.

---

### ~~100% level command fails~~ SOLVED
**Status:** ✅ Fixed

**Solution:** Bridge uses **0xFEFF** for 100%, not 0xFFFF. Captured actual bridge traffic and confirmed 0xFFFF is reserved/invalid.

---

## Test Results Log

| Date | Test | Result | Notes |
|------|------|--------|-------|
| 2024-12-31 | ON/OFF for 05851117 | Partial | Works ~30-50% of time |
| 2024-12-31 | Dual format (short+long) | Improved | Better than short-only |
| 2024-12-31 | Level 0/25/50/75% (AF902C00) | ✅ Working | Bridge-style commands |
| 2024-12-31 | Level 100% (AF902C00) | ✅ Fixed | Use 0xFEFF not 0xFFFF |

---

## Confirmed Limitations

### Set-level commands require bridge pairing
**Status:** Confirmed 2024-12-31

Set-level commands (`send_level()`) only work for devices that are paired to a RadioRA3 bridge. Sending level commands directly to an unpaired dimmer (e.g., factory-reset DVRF-6L) does NOT work.

**Implication:** The bridge appears to sign or authenticate level commands. Without this authentication, unpaired devices ignore the commands.

**What DOES work:**
- Pico button commands (ON/OFF/RAISE/LOWER) to devices paired with that Pico's MAC
- Level commands to devices paired through a bridge (using bridge's credentials from capture)

**What does NOT work:**
- Level commands to unpaired/factory-reset devices
- Creating a "virtual bridge" without captured bridge credentials

---

## Ideas to Try

1. **Replay exact captured packet** - Use `send_raw_packet()` with exact bytes from real Pico capture to test if the issue is packet content vs RF.

2. **Increase repetitions** - Send more than 5+5 packets per button press.

3. **Match exact timing** - Analyze real Pico inter-packet timing more precisely.

4. **Try GFSK modulation** - We use 2-FSK; real Pico uses GFSK. May matter for receiver.

5. **Sequence number experiments** - Try using captured sequence numbers exactly.
