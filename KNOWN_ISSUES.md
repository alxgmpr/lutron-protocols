# Known Issues and Open Questions

## Reliability Issues

### Commands only work every ~3rd press
**Status:** Under investigation

**Symptom:** RF TX commands work approximately every 3rd button press. Never takes more than 3 presses to work, but rarely works on the first press.

**Observed behavior:**
- ON/OFF/RAISE/LOWER/FAVORITE all exhibit this pattern
- Suggests a systematic issue rather than random RF problems
- Level commands to bridge-paired devices work more reliably

**Possible causes:**
1. **Sequence number rejection** - The receiver may validate sequence numbers. Real Picos use sequence increments of +6 for long packets, +2 for short packets. We now use +6 for pairing but may need to adjust button commands.

2. **Type alternation mismatch** - We alternate A/B types (0x88/89 vs 0x8A/8B) between button presses, but the receiver may expect a specific pattern.

3. **CRC validation** - Button commands include CRC (polynomial 0xCA0F). If our CRC calculation is slightly off for some packets, they'd be rejected.

4. **RF signal characteristics** - 2-FSK vs GFSK modulation differences. We use 2-FSK; real Picos use GFSK but switching to GFSK broke commands entirely.

**Next steps:**
- [ ] Capture our CC1101 transmission and compare to real Pico
- [ ] Analyze why ~1 in 3 packets work - is there a pattern?
- [ ] Test with different sequence increment values

---

## CRC Algorithm Discovery (2024-12-31)

**Status:** ✅ SOLVED

The CRC algorithm was extracted from the STM32 firmware of a Caseta bridge (credit: lutron_hacks repo):

```
Polynomial: 0xCA0F (15-bit)
Initial value: 0x0000
Reflect: False
XOR out: 0x0000
```

**Implementation:**
```c
uint16_t calc_crc(const uint8_t *data, size_t len) {
    uint16_t crc_reg = 0;
    for (size_t i = 0; i < len; i++) {
        uint8_t crc_upper = crc_reg >> 8;
        crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ crc_table[crc_upper];
    }
    return crc_reg;
}
```

**Note:** This is a non-standard implementation. Per the lutron_hacks analysis, the algorithm should feed trailing zeros but doesn't - possibly intentional to prevent easy reverse engineering.

**Verified with captured packets:**
- `8A 00 05 85 11 17 21 04 03 00 04 00 CC...CC` → CRC: `0xAE2B` ✅
- `BB 00 05 85 11 17 21 25 04 00 04 03 00 FF...` → CRC: `0x3E95` ✅

---

## Packet Structure (Updated 2024-12-31)

### Packet Length Rules (from STM32 firmware)
```c
if (type & 0xC0 == 0x00) return 5;       // Legacy packets (never seen)
if (type & 0xE0 == 0xA0) return 0x35;    // Pairing packets (53 bytes)
else return 0x18;                         // All other packets (24 bytes)
```

### Button Command Packets (24 bytes)
Types: `0x88`, `0x89`, `0x8A`, `0x8B`
```
[Type] [Seq] [DevID x4] [0x21] [Len] [03 00] [Btn] [00] [CC padding] [CRC x2]
```

### Pairing Packets (53 bytes)
Types: `0xB8`, `0xB9`, `0xBA`, `0xBB` (type & 0xE0 == 0xA0)
```
[Type] [Seq] [DevID x4] [21 25] [04 00] [Btn] [03 00] [FF FF FF FF FF]
[0D 05] [DevID x4] [DevID x4] [00 20] [Btn] [00] [08 07] [Btn]
[01 07] [02] [DevType] [00 00] [FF FF FF FF] [CC padding] [CRC x2]
```

### Sequence Number Patterns
- **Button commands:** Short packets +2, Long packets +6
- **Pairing:** Increments by +6 for each packet
- **Bridge pairing:** Uses 0xB1, 0xB2, 0xB3 types with +6 increment

---

## Pairing: Still Not Working

**Status:** Under investigation

### What we've tried:
1. **Exact replay** of captured Pico packets with correct CRCs - FAILED
2. **Dynamic CRC generation** with correct 0xCA0F polynomial - FAILED
3. **Different packet types** (0xB9, 0xBA, 0xBB) - FAILED
4. **Different device types** (0x06, 0x21, 0x27) - FAILED
5. **Short + Long format** (0x8A + 0xBB phases) - FAILED
6. **GFSK modulation** - Broke button commands, reverted to 2-FSK

### What works:
- Button commands to devices paired with the REAL Pico (device ID 0x17118505)
- Level commands to bridge-paired devices

### What doesn't work:
- Pairing our CC1101 as a new device
- Making the relay recognize any new device ID

### Theories:
1. **RF modulation mismatch** - Real Picos use GFSK, we use 2-FSK. But GFSK broke everything.
2. **Hidden handshake** - Maybe pairing requires the receiver to acknowledge and we're not listening.
3. **Crypto signature** - Some packets may be signed with a key stored in the device.
4. **Frequency offset** - Our CC1101 may be slightly off-frequency.

---

## Modulation Discovery

**Status:** Confirmed 2-FSK works, GFSK breaks commands

The lutron_hacks receiver code configures CC1101 with `MDMCFG2 = 0x10` (GFSK). However, when we switched our transmitter to GFSK:
- Button commands completely stopped working
- Level commands still worked (different packet format?)

**Current setting:** `MDMCFG2 = 0x00` (2-FSK, no sync word)

This suggests either:
- Real devices accept 2-FSK
- Our GFSK implementation was wrong
- Different packet types use different modulation

---

## Hardware Configuration

### CC1101 Settings (Working)
```
Frequency: 433.602844 MHz (FREQ = 0x10AD52)
Data rate: 62.5 kbaud (MDMCFG4=0x0B, MDMCFG3=0x3B)
Modulation: 2-FSK (MDMCFG2=0x00)
Deviation: 41.2 kHz (DEVIATN=0x45)
TX Power: +10 dBm (PA_TABLE=0xC0)
```

### Async Serial Encoding
All bytes are transmitted as 10-bit N81 async serial:
- Start bit (0)
- 8 data bits (LSB first)
- Stop bit (1)

Packet structure on-air:
- 32-bit preamble (alternating 10101010...)
- Sync byte 0xFF
- Prefix 0xFA 0xDE
- Data bytes (N81 encoded)
- Trailing zeros

---

## Test Results Log

| Date | Test | Result | Notes |
|------|------|--------|-------|
| 2024-12-31 | ON/OFF for 05851117 | Partial | Works ~1 in 3 presses |
| 2024-12-31 | Level commands (AF902C00) | ✅ Working | Bridge-paired device |
| 2024-12-31 | Pairing DEADBEEF | ❌ Failed | With correct CRC |
| 2024-12-31 | Pairing exact replay | ❌ Failed | Real Pico packets |
| 2024-12-31 | GFSK modulation | ❌ Broke commands | Reverted to 2-FSK |

---

## Resources

- **lutron_hacks repo:** https://github.com/Entropy512/lutron_hacks
  - Contains CRC algorithm from STM32 firmware
  - Receiver implementation for Raspberry Pi
  - Packet captures and analysis

---

## Next Steps

1. **Improve button reliability** - Investigate the ~1 in 3 success rate
2. **Capture our transmissions** - Compare CC1101 output to real Pico with RTL-SDR
3. **Try listening during pairing** - Maybe there's a handshake
4. **Frequency calibration** - Verify our CC1101 is exactly on frequency
5. **Document for library** - Make code more modular and less hardcoded
