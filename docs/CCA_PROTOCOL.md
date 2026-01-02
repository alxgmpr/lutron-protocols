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

## References

- lutron_hacks repository (partial implementation)
- hackaday.io Lutron projects
- CC1101 datasheet (Texas Instruments)
- Original RTL-SDR captures and analysis
