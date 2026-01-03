# Lutron Clear Connect Type A (CCA) Protocol Documentation

This document describes the Lutron Clear Connect Type A (CCA) RF protocol used by Pico remotes and other 433 MHz Lutron devices. Based on original research and captures from real Pico remotes.

## RF Parameters

| Parameter | Value |
|-----------|-------|
| Frequency | 433.602844 MHz |
| Modulation | GFSK (Gaussian Frequency Shift Keying) |
| Data Rate | 62.4847 kBaud |
| Deviation | ~41.2 kHz |

### CC1101 Register Configuration

```
FREQ2/1/0: 0x10 0xAD 0x52  (433.602844 MHz)
MDMCFG4/3: 0x0B 0x3B       (62.4847 kBaud)
MDMCFG2:   0x30            (GFSK, no sync word - we handle sync in bitstream)
DEVIATN:   0x45            (41.2 kHz deviation)
PKTCTRL0:  0x00            (Fixed length, no hardware CRC)
```

## Bit-Level Encoding

The protocol uses **async serial N81 format** for each byte:

```
+-------+-------------------+------+
| Start |    8 Data Bits    | Stop |
|   0   |    LSB first      |  1   |
+-------+-------------------+------+
```

Each byte becomes 10 bits:
- 1 start bit (always 0)
- 8 data bits, transmitted LSB first
- 1 stop bit (always 1)

### Encoding Example

Byte 0xFA (binary: 11111010):
```
LSB first: 0 1 0 1 1 1 1 1
With framing: 0 + 01011111 + 1 = 0010111111
```

Byte 0xFF (binary: 11111111):
```
LSB first: 1 1 1 1 1 1 1 1
With framing: 0 + 11111111 + 1 = 0111111111
```

## Packet Structure

A complete transmission consists of:

```
[Preamble][Sync 0xFF][Prefix 0xFA 0xDE][Payload][CRC-16][Trailing]
```

### 1. Preamble (32 bits)
Alternating bits for clock synchronization:
```
10101010101010101010101010101010
```

### 2. Sync Byte (10 bits)
0xFF encoded with N81 framing:
```
0111111111
```

### 3. Prefix (20 bits)
0xFA 0xDE encoded with N81 framing - marks start of data

### 4. Payload (variable, typically 22 bytes = 220 bits)
Button press packets are 24 bytes total (22 payload + 2 CRC)

### 5. CRC-16 (20 bits)
16-bit CRC encoded as 2 bytes with N81 framing

### 6. Trailing (16 bits)
Zero padding for clean transmission end

## Button Press Packet Format (24 bytes)

| Offset | Length | Field | Description |
|--------|--------|-------|-------------|
| 0 | 1 | Type | 0x88 for button press |
| 1 | 1 | Sequence | Increments by 6 each transmission |
| 2-5 | 4 | Device ID | Big-endian (matches printed label), e.g., `08 4B 1E BB` for Pico 084b1ebb |
| 6 | 1 | Unknown | 0x21 |
| 7 | 1 | Unknown | 0x04 |
| 8 | 1 | Unknown | 0x03 |
| 9 | 1 | Unknown | 0x00 |
| 10 | 1 | Button | Button number (see below) |
| 11 | 1 | Action | 0x00 = press, 0x01 = release |
| 12-21 | 10 | Padding | 0xCC broadcast padding |
| 22-23 | 2 | CRC | CRC-16, big-endian |

### Button Codes (5-button Pico)

| Button | Code |
|--------|------|
| Top (On) | 0x02 or 0x04 |
| Raise | 0x05 |
| Favorite (Middle) | 0x03 |
| Lower | 0x06 |
| Bottom (Off) | 0x04 or 0x08 |

Note: Button codes may vary by Pico model and pairing configuration.

### Button Codes (4-button Scene Pico)

| Button | Code | Label |
|--------|------|-------|
| Top | 0x08 | Bright/On |
| Second | 0x09 | Entertain/Up |
| Third | 0x0A | Relax/Down |
| Bottom | 0x0B | Off |

### Button Codes (4-button Raise/Lower Pico)

| Button | Code | Label |
|--------|------|-------|
| Top | 0x08 | On |
| Second | 0x09 | Raise |
| Third | 0x0A | Lower |
| Bottom | 0x0B | Off |

### Special Button Codes

| Code | Meaning |
|------|---------|
| 0xFF | Reset/Unpair broadcast ("forget me") |

### Device ID Format

The Device ID printed on the Pico is transmitted in **big-endian** byte order (matching the printed label):
- Printed: `084b1ebb`
- In packet: `08 4B 1E BB`
- As uint32_t: `0x084B1EBB`

**Note:** Earlier documentation incorrectly stated little-endian. Analysis of real Pico captures confirmed big-endian encoding.

## CRC-16 Calculation

Uses polynomial **0x1CA0F** (non-standard):

```cpp
uint16_t calc_crc(const uint8_t *data, size_t len) {
    static uint16_t crc_table[256];
    static bool table_init = false;

    if (!table_init) {
        for (int i = 0; i < 256; i++) {
            uint16_t crc = i << 8;
            for (int j = 0; j < 8; j++) {
                if (crc & 0x8000) {
                    crc = ((crc << 1) ^ 0xCA0F) & 0xFFFF;
                } else {
                    crc = (crc << 1) & 0xFFFF;
                }
            }
            crc_table[i] = crc;
        }
        table_init = true;
    }

    uint16_t crc_reg = 0;
    for (size_t i = 0; i < len; i++) {
        uint8_t crc_upper = crc_reg >> 8;
        crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ crc_table[crc_upper];
    }
    return crc_reg;
}
```

CRC is calculated over bytes 0-21 and stored big-endian in bytes 22-23.

## Transmission Timing

Real Pico remotes transmit:
- 6 repetitions per button press
- ~75ms gap between repetitions
- Sequence number increments by 6 each repetition

## Save Favorite/Scene Sequence

To save a new favorite or scene level on a paired dimmer, the Pico performs an extended button hold sequence:

### Phase 1: SHORT Format (Hold Signal)

Hold the button for ~5-6 seconds, continuously transmitting SHORT format packets:

```
8A 00 05 85 11 17 21 04 03 00 03 00 CC CC CC CC CC CC CC CC CC CC [CRC]
```

| Byte | Value | Description |
|------|-------|-------------|
| 0 | 0x88/0x8A | Type (SHORT_A or SHORT_B) |
| 1 | Seq | Sequence, +6 each packet |
| 2-5 | Device ID | Big-endian Pico ID |
| 6 | 0x21 | Protocol marker |
| 7 | 0x04 | SHORT format indicator |
| 8 | 0x03 | Unknown |
| 9 | 0x00 | Unknown |
| 10 | Button | Button code (0x03=FAV, 0x08-0x0B for scene) |
| 11 | 0x00 | Action = PRESS |
| 12-21 | 0xCC | Padding |
| 22-23 | CRC | CRC-16 |

### Phase 2: LONG Format (Release/Save)

After holding ~5 seconds, release and send LONG format packets:

```
8B 00 05 85 11 17 21 0E 03 00 03 01 05 85 11 17 00 40 00 21 00 00 [CRC]
```

| Byte | Value | Description |
|------|-------|-------------|
| 0 | 0x89/0x8B | Type (LONG_A or LONG_B) |
| 1 | Seq | Sequence |
| 2-5 | Device ID | Big-endian Pico ID |
| 6 | 0x21 | Protocol marker |
| 7 | 0x0E | LONG format indicator |
| 8-9 | 0x03 0x00 | Unknown |
| 10 | Button | Button code |
| 11 | 0x01 | Action = RELEASE |
| 12-15 | Device ID | Pico ID repeated |
| 16 | 0x00 | Unknown |
| 17 | 0x40 | Save indicator |
| 18 | 0x00 | Unknown |
| 19 | 0x1E + button | Save target (0x21 for FAV, 0x26 for btn 0x08, etc.) |
| 20-21 | 0x00 0x00 | Padding |
| 22-23 | CRC | CRC-16 |

**Key timing:** The dimmer enters save mode after receiving ~5 seconds of continuous PRESS packets. The RELEASE packets with byte[17]=0x40 and byte[19]=0x1E+button confirm the save.

## Receiving (RX) with RTL-SDR

### Capture Command
```bash
rtl_fm -f 433602844 -s 200000 -g 40 - | sox -t raw -r 200000 -e signed -b 16 -c 1 - capture.wav
```

### GFSK Demodulation
The raw capture needs GFSK demodulation at 62.5 kBaud. Tools:
- GNU Radio with GFSK demod block
- Universal Radio Hacker (URH)
- Custom Python with scipy for FM demod

### Decoding Process
1. FM demodulate the GFSK signal
2. Sample at ~3.2x symbol rate (200 kHz / 62.5 kBaud)
3. Find preamble pattern (101010...)
4. Locate 0xFF sync byte (0111111111 in bitstream)
5. Find 0xFADE prefix
6. Extract 10-bit chunks, decode N81 format
7. Verify CRC-16

## Transmitting (TX) with CC1101

### Hardware
- ESP32 + CC1101 module (e.g., EBYTE E07-M1101D-SMA)
- SPI connection: CLK=GPIO18, MOSI=GPIO23, MISO=GPIO19, CS=GPIO21, GDO0=GPIO2

### Transmission Process
1. Build payload with device ID, button, sequence
2. Calculate CRC-16 over bytes 0-21
3. Encode entire packet with N81 framing
4. Prepend preamble and sync
5. Load into CC1101 TX FIFO
6. Strobe STX to transmit
7. Wait for completion, repeat 6 times

### ESPHome Integration
See `custom_components/lutron_cc1101/` for complete ESPHome external component.

## Known Device IDs (from captures)

| Device | ID (printed) | ID (little-endian) |
|--------|--------------|-------------------|
| ESP-connected Pico | 0595e68d | 0x8DE69505 |
| Handheld Pico | 08692d70 | 0x702D6908 |

## Pairing Packets

Pairing packets advertise the Pico's capabilities and allow it to be registered with dimmers, switches, or bridges.

### Pairing Packet Types

| Type | Name | Capability |
|------|------|------------|
| 0xB9 | PAIR_B9 | Direct-pair capable |
| 0xBB | PAIR_BB | Direct-pair capable |
| 0xB8 | PAIR_B8 | Bridge-only |
| 0xBA | PAIR_BA | Bridge-only |
| 0xB0 | PAIR_B0 | Unknown/legacy |

### Pairing Capability Categories

**Direct-Pair Capable (B9/BB):**
- 2-button Pico (PJ2-2B)
- 5-button Pico (PJ2-3BRL)
- 4-button Raise/Lower Pico (PJ2-4B)
- 4-button Scene Pico with custom engraving

These remotes can pair directly to Caseta/RA2 dimmers and switches without requiring a bridge. They use packet types B9 and BB, alternating between them during the pairing sequence.

**Bridge-Only (BA/B8):**
- 4-button Scene Pico (standard, PJ2-4B-S)

Standard scene picos can only pair through a RadioRA3 or Homeworks QSX bridge. They advertise scenes rather than direct on/off/dim commands. They use packet types BA and B8, alternating between them during the pairing sequence.

**Note:** Custom-engraved scene picos appear to have different firmware that enables direct-pairing (B9/BB packets) despite being scene picos. This may be intentional or a side effect of the customization process.

### Pairing Packet Structure (Full 45 bytes)

Pairing packets are 45 bytes (excluding CRC) with extended capability information:

```
Offset:  0  1  2-5         6  7  8  9  10 11 12 13-17          18 19 20-23       24-27       28 29 30 31 32 33 34 35 36 37 38 39 40 41-44
Field:   TY SQ [Device ID] 21 25 04 00 BS 03 00 [BROADCAST   ] 0D 05 [Device ID] [Device ID] ?? ?? ?? DT ?? ?? ?? ?? FC B1 B2 00 00 [PADDING]
```

| Offset | Field | Description |
|--------|-------|-------------|
| 0 | Type | Packet type (B8, B9, BA, BB) |
| 1 | Sequence | Increments each packet |
| 2-5 | Device ID | Pico ID, big-endian |
| 6-7 | Protocol | Always `21 25` |
| 8-9 | Unknown | Always `04 00` |
| 10 | **Button Scheme** | Tells receiver what button codes to expect |
| 11-12 | Unknown | Always `03 00` |
| 13-17 | Broadcast | `FF FF FF FF FF` |
| 18-19 | Unknown | Always `0D 05` |
| 20-23 | Device ID | Pico ID repeated (2nd occurrence) |
| 24-27 | Device ID | Pico ID repeated (3rd occurrence) |
| 28-30 | Unknown | Always `00 20 03` |
| 31 | **Unknown** | `0x00` or `0x08` (model-specific, see below) |
| 32-35 | Unknown | Always `08 07 03 01` |
| 36 | **Function Count?** | `0x07` for 5-button, `0x2A` for 2-button paddle |
| 37 | **Capability B1** | First button code or capability value |
| 38 | **Capability B2** | Last button code or capability value (see below) |
| 39-40 | Padding | `00 00` |
| 41-44 | Padding | `FF FF FF FF` |

### Button Range Advertisement (Bytes 37-38)

**Key discovery:** Bytes 37-38 advertise capability information. For 5-button scheme picos, these represent the range of valid button codes. For 4-button scheme picos, byte 38 has different meaning (values like 0x21, 0x27 are too large to be button codes).

| Remote Type | Pkt Type | Byte 10 | Byte 30 | Byte 37 | Byte 38 | Notes |
|-------------|----------|---------|---------|---------|---------|-------|
| 5-button Pico | B9/BB | `0x04` | `0x03` | `0x02` | `0x06` | Button range 0x02-0x06 |
| 2-button Paddle | B9/BB | `0x04` | `0x03` | `0x01` | `0x01` | Invalid range → FAV=ON |
| 4-btn Raise/Lower | B9/BB | `0x0B` | `0x02` | `0x02` | `0x21` | Direct-pair capable |
| 4-btn Scene (std) | B8/BA | `0x0B` | `0x04` | `0x02` | `0x27` | Bridge-only |
| 4-btn Scene (custom) | B9/BB | `0x0B` | `0x04` | `0x02` | `0x28` | Direct-pair! Custom engraving |

**5-button scheme (byte 10 = 0x04):** Bytes 37-38 define button code range. Button 0x03 (FAV) works as favorite only if it falls within [B1, B2].

**4-button scheme (byte 10 = 0x0B):** Bytes 37-38 meaning differs - values 0x21, 0x27 suggest these encode something other than a simple button range.

### Byte 31 (Unknown Purpose)

Observed values by Pico model (all are handheld remotes, same form factor):

| Pico Model | Byte 31 | Notes |
|------------|---------|-------|
| 5-button Pico | `0x00` | Standard Pico with ON/FAV/OFF/RAISE/LOWER |
| 4-button Raise/Lower | `0x00` | ON/RAISE/LOWER/OFF |
| 4-button Scene | `0x00` | Scene presets (Bright/Entertain/Relax/Off) |
| 2-button Paddle | `0x08` | Simple ON/OFF only |

The meaning of this byte is not yet understood. It does NOT indicate physical form factor.

### Button Scheme (Byte 10)

**Key discovery:** Byte 10 in pairing packets tells the receiver what button codes this remote will send.

| Byte 10 | Button Scheme | Button Codes | Pico Types |
|---------|---------------|--------------|------------|
| `0x04` | 5-button | 0x02-0x06 (ON, FAV, OFF, RAISE, LOWER) | 2-button, 5-button |
| `0x0B` | 4-button | 0x08-0x0B (ON, UP, DOWN, OFF) | 4-button raise/lower, 4-button scene |

This allows the dimmer/switch to know which button codes to expect from the paired remote.

### Pairing Sequence Behavior

When a Pico enters pairing mode (triple-tap or hold depending on model):
1. It transmits alternating packet types for its category
2. Direct-pair: B9 → BB → B9 → BB...
3. Bridge-only: BA → B8 → BA → B8...
4. Sequence numbers increment by 6 per packet (sometimes by 2 for 4-button picos)
5. Device ID is transmitted in big-endian format (matching printed label)

### Device ID in Pairing Packets

Like button press packets, pairing packets use **big-endian** device IDs:
- Printed on Pico: `084B1EBB`
- In packet bytes: `08 4B 1E BB`

## References

- lutron_hacks repository (partial implementation)
- hackaday.io Lutron projects
- CC1101 datasheet (Texas Instruments)
- Original RTL-SDR captures and analysis
