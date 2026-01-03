# Known Issues

## Current Status

| Feature | Status | Notes |
|---------|--------|-------|
| Button commands (ON/OFF/RAISE/LOWER/FAVORITE) | Working | Direct-paired 5-button Pico |
| Scene Pico buttons | Partial | ~70% reliability |
| Level commands (0-100%) | Working | Bridge-paired devices |
| Fake state reports | Working | Spoof dimmer level to bridge |
| Beacon mode | Working | Use AF902C01 as load ID |
| Pico reset (unpair) | Working | Broadcasts "forget me" |
| Pairing as 5-button Pico | Working | Direct pair to dimmers |
| Pairing as 2-button paddle | Working | FAV acts as ON |
| Pairing as 4-button R/L | Working | Direct pair |
| Pairing as 4-button scene | Not working | See below |

## Open Issues

### Scene Pico Pairing

Pairing as a 4-button scene Pico does not work. The dimmer does not accept the pairing even though packets match captured real Pico data.

Working configs:
- 5-button: B9/BB, byte10=0x04, bytes37-38=0x02-0x06
- 2-button paddle: B9/BB, byte10=0x04, byte31=0x08, bytes37-38=0x01-0x01
- 4-button R/L: B9/BB, byte10=0x0B, byte30=0x02, bytes37-38=0x02-0x21

Not working:
- 4-button scene standard: B8/BA, byte10=0x0B, byte30=0x04, bytes37-38=0x02-0x27
- 4-button scene custom: B9/BB, byte10=0x0B, byte30=0x04, bytes37-38=0x02-0x28

### Scene Pico Commands Intermittent

Scene Pico button emulation works ~70% of time. Some presses are ignored by the bridge.

Workaround: Press multiple times.

The 4-button Raise/Lower Pico works flawlessly, suggesting the issue is bridge pairing config rather than RF transmission.

### RX Decode Failures with 4-Button Picos

When receiving from 4-button picos, decoder sometimes fails. Raw FIFO shows garbage instead of proper N81-encoded data. Happens on every 4-button press (at least one failure per burst). Does not happen with 5-button picos.

Impact: Low - most packets decode correctly.

## Button Codes Reference

### 5-Button Pico (PJ2-3BRL)
| Button | Code |
|--------|------|
| ON | 0x02 |
| FAVORITE | 0x03 |
| OFF | 0x04 |
| RAISE | 0x05 |
| LOWER | 0x06 |

### 4-Button Scene Pico (PJ2-4B-S)
| Button | Code |
|--------|------|
| BRIGHT | 0x08 |
| ENTERTAIN | 0x09 |
| RELAX | 0x0A |
| OFF | 0x0B |

### 4-Button Raise/Lower Pico (PJ2-4B-L)
| Button | Code |
|--------|------|
| ON | 0x08 |
| RAISE | 0x09 |
| LOWER | 0x0A |
| OFF | 0x0B |

## ID Relationships

- **Label/Factory ID**: Printed on device, factory-assigned
- **Load ID**: Assigned by bridge per-device during pairing
- **RF Transmit ID**: Derived from Load ID: `RF_TX = Load_ID XOR 0x20000008`

Example:
- 07004e8c paired -> Load ID af902c00 -> RF TX 8f902c08
- 06fdeff4 re-added -> Load ID af902c11 -> RF TX 8f902c19

Level commands work via direct RF (no bridge routing). Dimmer listens for its factory ID in payload. Works even with bridge unplugged, but dimmer must be paired.
