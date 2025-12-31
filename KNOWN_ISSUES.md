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

## Ideas to Try

1. **Replay exact captured packet** - Use `send_raw_packet()` with exact bytes from real Pico capture to test if the issue is packet content vs RF.

2. **Increase repetitions** - Send more than 5+5 packets per button press.

3. **Match exact timing** - Analyze real Pico inter-packet timing more precisely.

4. **Try GFSK modulation** - We use 2-FSK; real Pico uses GFSK. May matter for receiver.

5. **Sequence number experiments** - Try using captured sequence numbers exactly.
