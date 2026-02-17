# CCA Protocol Reference

Clear Connect Type A (CCA) is Lutron's proprietary 433 MHz radio protocol used by Picos, dimmers, switches, sensors, and hubs. This doc is organized by topic — see [lutron-rf-overview.md](lutron-rf-overview.md) for the conceptual big picture.

## 1. RF Parameters

| Parameter | Value |
|-----------|-------|
| Frequency | 433.602844 MHz (channel 26, default) |
| Modulation | 2-FSK |
| Data Rate | 62.5 kBaud |
| Deviation | 41.2 kHz |
| Encoding | Async serial N81 (start=0, 8 data LSB first, stop=1) |

### Channel Table

**Formula:** `Frequency (MHz) = 431.0 + (channel × 0.1)`

15 channels available: 5, 14, 17, 20, 23, **26** (default), 29, 32, 38, 41, 44, 47, 50, 53, 56.

Multi-processor systems use different channels per processor. Two-way devices (dimmers, switches) auto-switch channels. One-way transmitters (Picos, sensors) must be manually re-channeled.

### CC1101 Register Configuration

```
FREQ2/1/0: 0x10 0xAD 0x52  (433.602844 MHz)
MDMCFG4/3: 0x0B 0x3B       (62.4847 kBaud)
MDMCFG2:   0x30            (2-FSK, no sync word)
DEVIATN:   0x45            (41.2 kHz deviation)
PKTCTRL0:  0x00            (Fixed length, no hardware CRC)
```

## 2. Packet Framing

### On-Air Structure

```
[Preamble 32 bits][Sync 0xFF][Prefix 0xFA 0xDE][N81-encoded payload][Trailing zeros]
```

Each byte becomes 10 bits: 1 start bit (0) + 8 data bits (LSB first) + 1 stop bit (1).

### CRC-16

Polynomial: **0xCA0F** (non-standard). Computed over all payload bytes excluding the CRC itself, stored big-endian.

```cpp
uint16_t calc_crc(const uint8_t *data, size_t len) {
    static uint16_t crc_table[256];
    static bool table_init = false;
    if (!table_init) {
        for (int i = 0; i < 256; i++) {
            uint16_t crc = i << 8;
            for (int j = 0; j < 8; j++)
                crc = (crc & 0x8000) ? ((crc << 1) ^ 0xCA0F) & 0xFFFF : (crc << 1) & 0xFFFF;
            crc_table[i] = crc;
        }
        table_init = true;
    }
    uint16_t crc_reg = 0;
    for (size_t i = 0; i < len; i++) {
        uint8_t upper = crc_reg >> 8;
        crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ crc_table[upper];
    }
    return crc_reg;
}
```

## 3. Packet Types

| Type | Name | Size | Description |
|------|------|------|-------------|
| 0x81-0x83 | LEVEL | 24 | Level command or dimmer state report |
| 0x88 | BTN_PRESS_A | 24 | Button press, group A |
| 0x89 | BTN_RELEASE_A | 24 | Button release, group A |
| 0x8A | BTN_PRESS_B | 24 | Button press, group B |
| 0x8B | BTN_RELEASE_B | 24 | Button release, group B |
| 0x91-0x93 | BEACON | 24 | Bridge pairing mode beacon |
| 0xA1-0xA3 | CONFIG | 53 | Configuration commands (53 bytes with 0x00 padding + CRC) |
| 0xB0/0xB2 | DEVICE_ANNOUNCE | 53 | Device announcement during bridge pairing |
| 0xB8 | PAIR_REQ | 53 | Device pairing request (Vive) / bridge-only pairing (pico) |
| 0xB9 | PAIR_BEACON | 53 | Direct-pair capable / Vive beacon |
| 0xBA | PAIR_ACCEPT | 53 | Bridge-only pairing (pico) / Vive accept |
| 0xBB | PAIR_DIRECT | 53 | Direct-pair capable |
| 0xC1-0xE0 | HANDSHAKE | 24 | Bridge pairing handshake (challenge-response) |

### Size Rules

- **0x80-0x9F**: 24 bytes (22 data + 2 CRC)
- **0xA0-0xBF**: 53 bytes (51 data + 2 CRC) — must use 0x00 padding
- **0xC0-0xEF**: 24 bytes (handshake)

### Button A/B Alternation

Base 0x88 with two flag bits: bit 0 = action (0=press, 1=release), bit 1 = group (0=A, 1=B). Picos alternate A→B on successive events for double-tap detection.

## 4. Addressing

### Device ID Structure (4 bytes)

```
[Zone][SubnetLo][SubnetHi][Endpoint]
```

- **Zone** (byte 0): device number within subnet
- **Subnet** (bytes 1-2): RF subnet, little-endian in packet
- **Endpoint** (byte 3): 0x80=unicast, 0x8F=broadcast, 0x8C/0x8D=device-specific

### ID Relationships

| ID Type | Example | Description |
|---------|---------|-------------|
| Factory/Label ID | 06FDEFF4 | Printed on device, factory-assigned |
| Load ID | AF902C00 | Assigned by bridge during pairing |
| RF Transmit ID | 8F902C08 | `Load_ID XOR 0x20000008` |

### Vive Addressing

Vive uses **hub ID** (4 bytes) + **zone ID** (1 byte) instead of device IDs. Zone byte position varies by format (byte 12 for commands, byte 24 for format 0x12 config). Constant `0xEF` always follows the zone byte.

## 5. Commands

### Button Codes

**5-Button Pico (PJ2-3BRL):** ON=0x02, FAVORITE=0x03, OFF=0x04, RAISE=0x05, LOWER=0x06

**4-Button Pico (PJ2-4B):** Top=0x08, Up=0x09, Down=0x0A, Bottom=0x0B

**Special:** 0xFF = Reset/Unpair broadcast

### Button Press Packet (24 bytes)

**Short format** (byte 7 = 0x04): Bytes 0-11 are header + button code + action.

**Long format** (byte 7 = 0x0E): Includes repeated device ID at bytes 12-15 and command payload at bytes 17-21.

Long format bytes 17-21 by button:

| Button | Bytes 17-21 | Command Class |
|--------|-------------|---------------|
| ON | 40 00 20 00 00 | 0x40 (level) |
| FAVORITE | 40 00 21 00 00 | 0x40 (level) |
| OFF | 40 00 22 00 00 | 0x40 (level) |
| RAISE | 42 02 01 00 16 | 0x42 (dim) |
| LOWER | 42 02 00 00 43 | 0x42 (dim) |

### Command Class 0x40: Level Control

Used by bridge SET_LEVEL, Vive ON/OFF/level, and pico set-level.

**Bridge SET_LEVEL (format 0x0E, byte 8 = 0x00):**

```
Byte 9-12: Target device ID
Byte 14:   0x40 (command class)
Byte 15:   0x02 (SET_LEVEL subcommand)
Byte 16-17: Level (BE, 0x0000-0xFEFF)
Byte 18:   0x00
Byte 19:   Fade time (quarter-seconds: 0x01=250ms, 0x04=1s, 0x28=10s)
Byte 20-21: 0x00 0x00
```

**Vive SET_LEVEL (format 0x0E, byte 8 = 0x00):**

```
Byte 12:   Zone ID
Byte 13:   0xEF
Byte 14:   0x40 (command class)
Byte 15:   0x02 (SET_LEVEL)
Byte 16-17: Level (BE, 0x0000-0xFEFF)
Byte 19:   Fade time (quarter-seconds)
```

**Pico SET_LEVEL (format 0x0E, byte 8 = 0x03):**

```
Byte 8:    0x03 (MUST be 0x03 — pico framing)
Byte 12-15: Pico device ID (repeated, REQUIRED)
Byte 17:   0x40 (command class)
Byte 18:   0x02 (SET_LEVEL)
Byte 19-20: Level (BE, 0x0000-0xFEFF)
Byte 21:   Must be non-zero (0x00 causes rejection)
```

Pico set-level works but fade is always slow (~1-2 min) because the 5-byte pico payload has no room for a fade field. The dimmer applies its default ramp rate. See [lutron-rf-overview.md](lutron-rf-overview.md) for the OUTPUT vs DEVICE explanation.

**Fade encoding:** `byte19 = seconds × 4` (quarter-seconds). Shared between Vive and bridge.

**Level encoding:** `level16 = percent * 0xFEFF / 100`

### Command Class 0x42: Dimming

Two-phase dimming shared between Pico and Vive:

| Phase | Purpose | Pico Format | Vive Format |
|-------|---------|-------------|-------------|
| Hold-start | Initiate dim | 0x0C | 0x09 |
| Dim step | Actual dimming | 0x0E | 0x0B |

Both use `0x42, 0x00` for hold-start and `0x42, 0x02` for dim step. Direction encoding differs: Pico 0x01/0x00 (raise/lower), Vive 0x03/0x02.

Hold-start is **required** — without it, dim steps are silently ignored.

Transmission: 6 hold-start packets, then 10-12 dim step packets.

### Button Action Patterns

| Action | Method |
|--------|--------|
| Press | 6 short + 10 long format packets, ~70ms gaps |
| Hold-to-dim | 14 HOLD packets → wait → 14 RELEASE packets |
| Save favorite | 12 packets with format 0x0D, action byte 0x03 |
| Double-tap | Two press/release cycles with A→B type alternation |

### Dimmer State Report (24 bytes)

```
Byte 7:  0x08 (state report format)
Byte 11: Level (0x00-0xFE = 0-100%)
```

Dimmers send to both unicast (0x80) and broadcast (0x8F) endpoints.

## 6. Vive Variant

Vive uses the same CCA radio but addresses devices by hub ID + zone ID for room-level group control.

### Command Formats

| Command | Format | Key Fields |
|---------|--------|------------|
| ON/OFF/Level | 0x0E | zone@12, 0xEF@13, level@16-17, fade@19 |
| Hold-start | 0x09 | zone@12, 0x42@14, direction@16 |
| Dim step | 0x0B | zone@12, 0x42@14, direction@16 |

12 packets per command, type rotates 0x89/0x8A/0x8B, seq increments by 6.

### FCJS-010 Dimmer Specifics

| Field | Relay | Dimmer |
|-------|-------|--------|
| Format 0x28 byte 9 | 0x38 | 0x50 |
| Format 0x14 byte 22 | 0x00 | 0x02 |
| Format 0x13 | Not sent | Required |
| ON/OFF byte 19 | 0x00 | 0x01 |

## 7. Pairing

### Bridge Pairing (Caseta/RA3)

9-phase sequence (~60-70 seconds):

| Phase | Description |
|-------|-------------|
| 0 | Idle beacons (format 0x08, subcmd 0x01) |
| 1 | Active beacons (format 0x0C, subcmd 0x02) with load ID |
| 2 | Device announces (B0/B2, format 0x17, 53 bytes) |
| 3 | Bridge acknowledges: targeted beacon + config + unpair (0x82) |
| 4 | Brief beacon resume |
| 5 | Full config: 4 integration IDs + capabilities |
| 6 | Post-pairing beacons (subcmd 0x04 = "committed") |
| 7 | LED configuration (0x81, format 0x0A) |
| 8 | Handshake (C1-E0, 6 rounds challenge-response) |

**Critical implementation details:**

- **Handshake echo**: Bridge must echo device's exact challenge bytes with `type+1`, `seq+5`, `byte[5]=0xF0` (round 1 only), recalculated CRC. Hardcoded data = guaranteed failure.
- **Phase 3b field inversion**: Initial binding has `integ_id[0]` at bytes 9-12 and `device_id` at bytes 17-20 (opposite of all other phases).
- **Zone binding**: Byte 21 is always 0x20 regardless of round.
- **Retransmissions**: 6-12 per config packet, 500ms delays between phases.
- **Half-duplex timing**: Long RX windows (5s+) during handshake, minimal TX (3 packets max) between rounds.

**Switch vs dimmer**: Type 0x82/0x81 for switch, 0x83/0x83 for dimmer (unpair/LED). Dimmer needs format 0x15 config + multiple handshake cycles.

**Arbitrary subnets**: Any 16-bit subnet value works — devices don't validate.

### Vive Pairing

All packets are **53 bytes** (51 data + 2 CRC) with 0x00 padding.

| Phase | Packet | Direction | Description |
|-------|--------|-----------|-------------|
| 1 | B9 (format 0x11, timer=0x3C) | Hub → All | Beacon: pairing active |
| 2 | B8 (format 0x23) | Device → Hub | Device requests to pair |
| 3 | BA (format 0x10) | Hub → Device | Accept |
| 4-8 | A-type (formats 0x13, 0x28, 0x14, 0x12) | Hub → Device | Config sequence |
| 9 | B9 (format 0x11, timer=0x00) | Hub → All | Pairing ended |

**Key facts:**
- **B9** = Beacon (format 0x11, broadcast) — NOT BA
- **BA** = Accept (format 0x10, directed to device)
- Each config format needs **5+ retransmissions** with varying type bytes
- Device sends B8 retries throughout config — absence = config not received
- Format 0x12 byte 24 is the authoritative zone assignment

### Pico Direct Pairing

53-byte packets alternating B9/BB (direct-pair) or B8/BA (bridge-only). Contains device ID (3 instances), button scheme byte (0x04=5-button, 0x0B=4-button), and capability/engraving bytes.

| Pico Type | Pair Types | Engraving (byte 38) |
|-----------|------------|---------------------|
| 5-button | B9/BB | 0x06 |
| 4-button R/L | B9/BB | 0x21 |
| 4-button Scene (Relax) | B8/BA | 0x27 |
| 2-button ON/OFF | B9/BB | 0x01 |

## 8. Device Configuration

All config packets use **type bytes A1-A3** and must be **53 bytes** with 0x00 padding. Type byte rotates A1→A2→A3 across separate config calls (constant within a burst). Zone alternation: first packet on primary zone, rest on alternate (low byte +2).

### Format 0x11: LED Mode

Bytes 23-24 control status LED behavior:

| Mode | Byte 23 (load OFF) | Byte 24 (load ON) |
|------|-------------------|-------------------|
| Off | 0x00 | 0x00 |
| Always on | 0xFF | 0xDF |
| On when load off | 0xFF | 0x00 |
| On when load on | 0x00 | 0xDF |

### Format 0x1C: Default Fade Rate

Bytes 23-26 set fade-on and fade-off times:
- Bytes 23-24: fade_on (uint16 **little-endian**, quarter-seconds)
- Bytes 25-26: fade_off (uint16 **little-endian**, quarter-seconds)

### Format 0x15: Trim

High/low trim levels for dimmers. Wrapped in a 3-phase sandwich: 0x82 (OFF) → 0xA3 (config) → 0x81 (save).

| Byte | Value | Notes |
|------|-------|-------|
| 0 | 0xA3 | Always A3 (does NOT rotate) |
| 20 | high trim | `percent * 254 / 100` |
| 21 | low trim | `percent * 254 / 100` |
| 22-26 | `23 0B 60 00 00` | Constants |
| **27-28** | **`00 FE`** | **Data, NOT padding. Keep fixed values.** |
| 29-50 | 0x00 | Actual padding starts here |

Only 2 config packets (seq 0x01 on primary zone, seq 0x02 on alternate). Phase (forward/reverse) encoding is **unsolved**.

### Format 0x1A: Scene Config

Programs per-device fade and delay times for scene recall.

| Byte | Value | Notes |
|------|-------|-------|
| 15 | 0x40 | Scene component (not 0x50 dimmer) |
| 23 | 0x02/0x03 | Packet number |
| **28-29** | uint16 **BE** | Fade time (quarter-seconds) |
| **30-31** | uint16 **BE** | Delay time (quarter-seconds) |

Note the **big-endian** encoding — unlike format 0x1C which uses little-endian. Only 2 retransmissions (not 20 like LED/fade).

Programming sequence: A3 format 0x1A → 0x81 format 0x0A → C/D status → format 0x0D (scene definition, static) → format 0x0B (scene trigger).

### Format 0x0A: Pairing-Time LED

LED config during pairing uses format 0x0A with type 0x81 (broadcast). Different from runtime format 0x11.

## 9. Hardware Notes

### CC1101 RX Limitations

The CC1101 in variable-length mode **truncates 53-byte config packets to 24 bytes**. Root causes:
1. N81 decoder stops on first framing error (single bit corruption at ~byte 24 kills remaining bytes)
2. CRC scanner returns shortest match (spurious CRC at 24 bytes steals the result)

**Always verify with RTL-SDR** for config packet analysis. CC1101 is reliable for 24-byte button/level packets.

```bash
# RTL-SDR capture (2 MHz = 32 samples/bit)
rtl_sdr -f 433602844 -s 2000000 -g 40 capture.bin

# Decode
bun run tools/rtlsdr-cca-decode.ts --rate 2000000 capture.bin
```

### 0x0B ACK Packets

Dimmers send **5-byte ACK packets** (type 0x0B) in response to bridge commands — NOT standard 24-byte CCA.

```
Format: 0B [seq] [response_class] [seq^0x26] [response_subtype]
```

- Byte 2: 0x00 for set-level ACK, 0xD0 for config ACK
- Byte 3: byte 1 XOR 0x26 (integrity check, no CRC)
- Byte 4: 0x55 for set-level ACK, 0x85 for config ACK
- CC1101 decodes bytes 2,4 with systematic 0xFE XOR error — RTL-SDR confirms correct values
- 3 ACKs at ~25ms intervals per command

## 10. Known Unknowns

- **Pico fast fade**: Pico payload is 5 bytes (no room for fade). Extended packets and alternative framings all failed. Likely requires solving the DEVICE→OUTPUT path.
- **Trim phase encoding**: Forward/reverse phase location unknown — byte 22 (0x23) is constant across captures.
- **Format 0x0E bytes 20-21**: Always 0x00 in captures. Could be delay field (untested).
- **Component byte 0x40 vs 0x50**: May unlock different parameter spaces (scene vs dimmer config).
