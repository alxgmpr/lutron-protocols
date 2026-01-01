# Lutron Clear Connect Type A - Pairing Analysis

## Current Status: NOT WORKING

Button presses work perfectly. Pairing does not elicit any response from the Lutron relay.

---

## What We KNOW (Confirmed)

### RF Parameters
| Parameter | Value | Status |
|-----------|-------|--------|
| Frequency | 433.602844 MHz | ✅ Confirmed from FCC filings |
| Modulation | 2-FSK | ✅ Working (button presses work) |
| Data Rate | 62.5 kBaud | ✅ Working |
| Deviation | 41.2 kHz | ✅ Working |
| CRC Polynomial | 0xCA0F | ✅ Confirmed from lutron_hacks |

### Packet Encoding
| Element | Format | Status |
|---------|--------|--------|
| Preamble | Alternating 1010... (32+ bits) | ✅ Confirmed |
| Sync | 0xFF encoded as N81 | ✅ Confirmed |
| Prefix | 0xFA 0xDE | ✅ Confirmed |
| Data | N81 serial (start=0, 8 data LSB first, stop=1) | ✅ Working |
| CRC | 2 bytes, big-endian | ✅ Working for button presses |

### Device Information
- **Real Pico Device ID**: `0x17118505`
- **Device IP**: `10.1.4.59`

### Button Press Packets (WORKING)
- **Type 0x88/0x89**: Short/long format, alternates with 0x8A/0x8B
- **Size**: 24 bytes (22 data + 2 CRC)
- **Behavior**: 6 short packets, then 10 long packets
- **Inter-packet delay**: ~70ms

### Pairing Packets from Real Pico Capture

From analyzing `real_pico_ACTUAL_pairing.cu8`:

| Field | Byte Position | Value | Notes |
|-------|---------------|-------|-------|
| Type | 0 | 0xB9 | NOT 0xBA/0xBB as documented |
| Sequence | 1 | 00,06,0C,12,18,1E,24,2A,30,36,3C,42... | Increments by 6 |
| Device ID | 2-5 | Little-endian | First instance |
| Protocol | 6 | 0x21 | Constant |
| Format | 7 | 0x25 | Different from button (0x04/0x0E) |
| Unknown | 8-12 | 04 00 04 03 00 | |
| Broadcast | 13-17 | FF FF FF FF FF | 5-byte broadcast |
| Unknown | 18-19 | 0D 05 | |
| Device ID | 20-23 | Little-endian | Second instance |
| Device ID | 24-27 | Little-endian | Third instance |
| Unknown | 28-31 | 00 20 03 00 | |
| Unknown | 32-39 | 08 07 03 01 07 02 06 00 | |
| Broadcast | 40-43 | FF FF FF FF | 4-byte broadcast |
| Padding | 44 | 0xCC | |
| CRC | 45-46 | Calculated | |

**Total**: 47 bytes

---

## What We DON'T KNOW

### 1. CRC Calculation Issue
- **Problem**: Our calculated CRC doesn't match captured CRC from real Pico
- **Possible causes**:
  - Wrong init value (tried 0x0000, 0xFFFF, 0xCA0F - none matched)
  - Wrong byte range being CRC'd
  - Different CRC algorithm variant
  - Post-processing step we're missing

### 2. Packet Content Meaning
- Bytes 8-12: `04 00 04 03 00` - unknown purpose
- Bytes 18-19: `0D 05` - unknown purpose
- Bytes 28-39: Unknown command/button data
- Why are there THREE copies of the device ID?

### 3. Transmission Differences
From RF comparison (`diagnose_bit_errors.py`):

| Metric | Real Pico | ESP32 | Difference |
|--------|-----------|-------|------------|
| Center Offset | -3.0 kHz | -16.2 kHz | 13 kHz |
| Deviation | ~41 kHz | ~41 kHz | OK |

We applied a +13 kHz correction via FREQ0 (0x52 → 0x73), but this may not be exact.

### 4. FIFO Handling for Large Packets
- Button presses: 24 bytes → ~40 encoded bytes → fits in 64-byte FIFO ✅
- Pairing: 47 bytes → ~69 encoded bytes → **exceeds 64-byte FIFO** ❌
- Current mitigation: Shortened preamble to 16 bits, trailing to 8 bits
- **Unknown**: Is our FIFO refill causing timing glitches that corrupt the packet?

### 5. Receiver Behavior
- Does the relay require specific signal strength?
- Is there a minimum preamble length for pairing?
- Does pairing require a specific sequence of packet types?
- Is there a handshake/ACK we're missing?

---

## Discrepancies from lutron_hacks Documentation

The `lutron_hacks` repository suggested:
- Pairing uses types 0xBA and 0xBB in two phases
- 0xBA: 60 packets over ~5 seconds with byte[7]=0x21
- 0xBB: 12 packets over ~1 second with byte[7]=0x17

**BUT** our capture of a REAL working Pico shows:
- Only type 0xB9 (not 0xBA or 0xBB)
- Byte[7] = 0x25
- Different packet structure (47 bytes vs 53 bytes)

**Hypothesis**: The 0xBA/0xBB format may be for a different device model, or our Pico uses a different protocol version.

---

## Debug Approach

### Phase 1: Verify RF Signal Quality (DONE)
- [x] Capture ESP32 transmission
- [x] Compare frequency to real Pico
- [x] Apply frequency correction (+13 kHz → FREQ0=0x73)
- [ ] Verify correction with new capture

### Phase 2: Verify Packet Content
- [ ] Capture BOTH ESP32 and real Pico pairing back-to-back
- [ ] Decode both bit-by-bit
- [ ] Compare every byte including CRC
- [ ] Identify any differences

### Phase 3: Isolate FIFO Issue
- [ ] Test if short (single FIFO load) pairing works
  - Create 24-byte "mini pairing" packet using 0xB9 type
  - See if relay responds at all
- [ ] Test if the FIFO refill is causing gaps
  - Monitor with SDR for amplitude drops mid-transmission

### Phase 4: CRC Deep Dive
- [ ] Extract multiple pairing packets from capture
- [ ] Document data and CRC for each
- [ ] Try brute-force init values
- [ ] Check if CRC covers header or just payload

### Phase 5: Protocol Variations
- [ ] Try sending exact 0xBA/0xBB format from lutron_hacks
- [ ] Try 0xB9 format from our capture
- [ ] Try hybrid approaches

---

## Test Matrix

| Test | Packet Type | Size | FIFO | Result |
|------|-------------|------|------|--------|
| Button press | 0x88/89 | 24 bytes | Single | ✅ WORKS |
| Pairing (0xBA/0xBB) | 0xBA, 0xBB | 53 bytes | Refill | ❌ No response |
| Pairing (0xB9) | 0xB9 | 47 bytes | Refill | ❌ No response |
| Mini pairing test | 0xB9 | 24 bytes | Single | ❓ Not tested |

---

## Next Steps (Priority Order)

1. **Capture new ESP32 transmission after frequency fix**
   - Verify the +13 kHz correction is correct
   - Decode and compare to real Pico

2. **Create mini pairing test**
   - Send short 0xB9 packet (24 bytes) to fit in single FIFO
   - Eliminates FIFO refill as a variable

3. **Deep CRC analysis**
   - Extract 5+ pairing packets from real Pico capture
   - Tabulate data[0:44] and CRC for each
   - Try all possible init values and byte ranges

4. **Bit-perfect packet replay**
   - If all else fails: capture the raw bitstream from real Pico
   - Replay it directly without re-encoding
   - If that works → encoding/timing issue
   - If that fails → RF signal quality issue

---

## File Inventory

### Analysis Scripts
- `diagnose_bit_errors.py` - RF parameter comparison
- `compare_transmissions.py` - Packet structure comparison
- `compare_rf_shape.py` - Raw RF signal analysis
- `compare_button_press.py` - Working button comparison
- `final_pairing_analysis.py` - Consensus pairing structure

### RF Captures
- `real_pico_ACTUAL_pairing.cu8` - Real Pico pairing (GROUND TRUTH)
- `esp32_pairing_capture.cu8` - ESP32 pairing attempt
- `esp32_button_test.cu8` - ESP32 button press (working reference)

### Source Code
- `esphome/custom_components/lutron_cc1101/lutron_cc1101.cpp` - Main driver
- `esphome/custom_components/lutron_cc1101/lutron_cc1101.h` - Header

---

## Open Questions

1. Why does button press work but not pairing?
2. Is the FIFO refill causing transmission gaps?
3. Is our CRC calculation wrong?
4. Is the 0xB9 vs 0xBA/0xBB difference significant?
5. Does the relay require something beyond just packet recognition?
