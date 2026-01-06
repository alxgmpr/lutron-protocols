# Lutron CCA Packet Decode System - Planning Document

## Problem Statement

The current ESP32 decoder frequently logs "not enough bits" errors, missing valid packets during:
- Pico button press/release sequences (rapid packets)
- Bridge configuration traffic (potentially different packet formats)
- Any scenario with back-to-back transmissions

Root causes:
1. **Fixed-length assumptions**: Decoder assumes 24-byte packets, but CCA uses variable lengths
2. **Threshold mismatch**: `MIN_PACKET_LEN=28` but decoder search needs 270+ bits (34+ bytes)
3. **Aggressive flushing**: FIFO flush after read may discard start of next packet
4. **No true sync detection**: We sync on 0xAAAA preamble, not the actual 0xFA 0xDE marker

## Lutron CCA Packet Structure

```
[Preamble]  [Sync]      [N81 Data Bytes]           [CRC]
0xAAAA...   FA DE       XX XX XX ... XX            CC CC
            ^           ^                          ^
            |           |                          |
            Marker      Variable length            16-bit CRC
            (20 bits)   (10 bits per byte)
```

### Known Packet Lengths (N81 data bytes, excluding sync)
| Type | Length | Description |
|------|--------|-------------|
| Button (0x88-0x8B) | 24 bytes | Pico button press/release |
| State Report (0x80-0x83) | 24 bytes | Dimmer level reports, bridge commands |
| Beacon (0x91-0x93) | 24 bytes | Pairing beacon |
| Pairing (0xB0-0xBB) | 53 bytes | Pico pairing announcement |
| Pairing Response (0xC0-0xCF) | ~24 bytes | Device pairing response |
| Unknown config | ? | Bridge configuration traffic |

### Bit Math
- N81 encoding: 1 start + 8 data + 1 stop = **10 bits per byte**
- 24-byte packet = 240 protocol bits
- 53-byte packet = 530 protocol bits
- CC1101 captures raw bits, 8 per byte: 240 protocol bits = 30 CC1101 bytes

## Current Architecture

```
CC1101 (sync on 0xAAAA)
    |
    v
FIFO (64 bytes max)
    |
    v  [check_rx polls, reads when >= 28 bytes]
    |
Raw bytes buffer
    |
    v  [decoder searches for 0xFA 0xDE, decodes N81]
    |
DecodedPacket struct
    |
    v  [callback to lutron_cc1101.cpp]
    |
JSON log output --> Python backend --> Web UI
```

### Current Issues

1. **MIN_PACKET_LEN = 28**: Only 224 bits available
2. **Decoder loop**: `bit_pos + 270 < total_bits` requires 270+ bits minimum
3. **Result**: When FIFO has 28-33 bytes, decode fails silently
4. **Flush behavior**: After reading, remaining FIFO data is flushed

## Proposed Architecture

### Phase 1: Immediate Fixes (Low Risk)

#### 1.1 Adjust Thresholds
```cpp
// In cc1101_radio.cpp check_rx()
const uint8_t MIN_PACKET_LEN = 35;  // 280 bits > 270 needed for search

// In lutron_decoder.cpp decode()
// Lower early-exit threshold but keep search loop intact
if (total_bits < 200) {  // Was 240
    ESP_LOGD(TAG, "Not enough bits: %d", total_bits);
    return false;
}
```

**Rationale**: 35 bytes = 280 bits, sufficient for 270-bit search loop. Lower early-exit allows more attempts.

#### 1.2 Smarter FIFO Read Timing
```cpp
// Don't read until we have enough for a full short packet decode
// OR FIFO is getting full (pressure situation)
if (rx_bytes < MIN_PACKET_LEN && rx_bytes < 50) {
    return false;  // Wait for more data
}
```

### Phase 2: Variable Length Support (Medium Risk)

#### 2.1 Two-Pass Decode Strategy

**Pass 1: Quick Type Detection**
- Read first 35-40 bytes from FIFO
- Find 0xFA 0xDE sync marker
- Decode first 2 bytes after sync (type + sequence)
- Determine expected packet length from type byte

**Pass 2: Full Decode**
- If short packet (24 bytes): decode immediately
- If long packet (53 bytes): wait for more FIFO data or read in chunks

```cpp
struct PacketTypeInfo {
    uint8_t type_byte;
    uint8_t expected_length;  // N81 bytes
    uint8_t min_cc1101_bytes; // Minimum raw bytes needed
};

const PacketTypeInfo PACKET_TYPES[] = {
    {0x88, 24, 35},  // BTN_SHORT_A
    {0x89, 24, 35},  // BTN_LONG_A
    // ... etc
    {0xB9, 53, 70},  // PAIR_B9
    {0xBA, 53, 70},  // PAIR_BA
};
```

#### 2.2 Sync Word Detection Options

**Option A: Hardware Sync on 0xFADE (Preferred)**
```cpp
// Configure CC1101 to sync on actual Lutron marker
// Requires bit-level sync word (0xFA 0xDE in N81 = specific bit pattern)
// Challenge: N81 encoding makes this complex
```

**Option B: Dual-Sync Software Search**
```cpp
// Keep hardware sync on 0xAAAA (preamble)
// Software searches for 0xFA 0xDE in captured data
// Current approach, but optimized
```

**Option C: Infinite Packet Mode**
```cpp
// CC1101 PKTCTRL0 = 0x02 (INFINITE mode)
// No packet length limit, continuous FIFO fill
// Software handles all framing
// Pro: Maximum flexibility
// Con: More CPU overhead, FIFO overflow risk
```

### Phase 3: Hardware-Optimized RX (Higher Risk)

#### 3.1 GDO Pin Utilization

Currently unused for RX. Could configure:
- **GDO0**: Assert on sync word detect
- **GDO2**: Assert when FIFO above threshold

```cpp
// IOCFG0 = 0x06: Asserts when sync word detected
// IOCFG2 = 0x00: Assert when RX FIFO >= threshold

// Use interrupt or fast polling on GDO0 to know exactly when packet starts
// This gives precise timing for FIFO reads
```

#### 3.2 Continuous RX with Circular Buffer

```cpp
class RxBuffer {
    uint8_t buffer[256];  // Circular buffer, 4x FIFO size
    size_t write_pos;
    size_t read_pos;

    // FIFO data appended here continuously
    // Decoder processes from read_pos, looking for 0xFA 0xDE
    // Handles packet boundaries spanning FIFO reads
};
```

**Benefits**:
- No data loss between FIFO reads
- Handles rapid packet sequences
- Decoder can work on stable buffer while FIFO fills

### Phase 4: TX/RX Transition Optimization

#### 4.1 Current TX Flow
```
IDLE -> flush_rx -> configure TX -> write FIFO -> STX -> wait done -> IDLE
```

#### 4.2 Optimized Flow
```
RX -> IDLE -> STX (auto-calibration) -> TX complete -> SRX (fast return to RX)
```

Key improvements:
- Use MCSM1 register for automatic RX-after-TX
- Minimize time in IDLE state
- Pre-configure TX packet while still in RX

```cpp
// MCSM1 configuration
// Bits 1:0 = RXOFF_MODE: 00 = IDLE after RX (current)
// Bits 3:2 = TXOFF_MODE: 11 = RX after TX (desired)
this->write_register(CC1101_MCSM1, 0x0C);  // Auto-RX after TX
```

### Phase 5: Post-Processing Pipeline

#### 5.1 Lightweight ESP32 Processing
ESP32 responsibilities (time-critical):
- Raw FIFO reads
- Sync word detection (0xFA 0xDE)
- N81 decode to bytes
- Basic type/length classification
- JSON output with raw bytes

#### 5.2 Python Backend Processing
Backend responsibilities (not time-critical):
- Full field parsing (already implemented)
- CRC validation
- Device ID resolution
- State tracking
- Database storage
- Protocol analysis

#### 5.3 Data Flow
```
ESP32                          Python Backend
  |                                  |
  | RX: {"bytes":"83 01 AF...",     |
  |      "rssi":-43,"len":24}       |
  |--------------------------------->|
  |                                  | parse_packet_bytes()
  |                                  | parse_packet_fields()
  |                                  | insert_decoded_packet()
  |                                  |
  |                                  | SSE: {type, fields, ...}
  |                                  |-----------------------> Web UI
```

## Implementation Phases

### Phase 1: Safe Threshold Adjustments (Do First)
- [x] Increase MIN_PACKET_LEN to 35
- [x] Reduce decoder early-exit threshold to 200 bits (Rust decoder handles this)
- [x] Test thoroughly before proceeding

### Phase 2: Variable Length Detection
- [x] Add packet type -> length mapping (Rust: get_packet_length())
- [x] Implement two-pass decode (Rust decoder handles variable lengths)
- [x] Handle 53-byte pairing packets properly

### Phase 3: Circular Buffer RX
- [ ] Implement RxBuffer class
- [ ] Continuous FIFO reads into buffer
- [ ] Decoder operates on buffer, not raw FIFO

### Phase 4: Hardware Optimization
- [ ] Configure GDO pins for sync detection
- [x] Implement auto-RX after TX (MCSM1) - configured TXOFF_MODE=11
- [ ] Profile and optimize hot paths

### Phase 5: Unknown Packet Discovery
- [x] Log all 0xFA 0xDE packets regardless of type byte
- [ ] Capture unknown formats during bridge configuration
- [ ] Analyze and document new packet types

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Threshold adjustment | Low | Small change, easy to revert |
| Variable length | Medium | Test with known packet types first |
| Circular buffer | Medium | Keep old path as fallback |
| GDO interrupts | High | Extensive testing, may affect timing |
| Auto-RX after TX | Medium | Test TX reliability |

## Success Metrics

1. **Zero "not enough bits" for valid packets**: All 0xFA 0xDE marked data should decode
2. **No packet loss during button sequences**: Press-hold-release fully captured
3. **Bridge config capture**: New packet types logged for analysis
4. **TX reliability maintained**: No regression in transmission success
5. **Sub-10ms TX/RX turnaround**: Fast enough for protocol timing

## Open Questions

1. What packet types does the bridge send during configuration?
2. Are there packet types longer than 53 bytes?
3. What's the minimum inter-packet gap in rapid sequences?
4. Should we implement packet deduplication in ESP32 or backend?

## Next Steps

1. Review this plan
2. Start with Phase 1 (threshold adjustments only)
3. Capture sample traffic during "not enough bits" scenarios
4. Analyze captured data to understand what's being missed
5. Iterate based on findings
