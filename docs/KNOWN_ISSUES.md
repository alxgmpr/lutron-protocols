# Known Issues

## Current Status

| Feature | Status | Notes |
|---------|--------|-------|
| Button commands (ON/OFF/RAISE/LOWER/FAVORITE) | Working | Direct-paired 5-button Pico |
| Scene Pico buttons | Working | All 4-button variants |
| Level commands (0-100%) | Working | Bridge-paired devices |
| Fake state reports | Working | Spoof dimmer level to bridge |
| Beacon mode | Working | Use AF902C01 as load ID |
| Pico reset (unpair) | Working | Broadcasts "forget me" |
| Pairing as 5-button Pico | Working | Direct pair to dimmers |
| Pairing as 2-button paddle | Working | FAV acts as ON |
| Pairing as 4-button R/L | Working | Direct pair |
| Pairing as 4-button scene | Working | Direct pair |
| **Bridge pairing** | **Not working** | See below |

## Open Issues

### ESP32 as Load Device (Dimmer/Switch)

ESP32 cannot pair to a real bridge as a load device (dimmer/switch) to receive commands.

**Goal:** Bridge sends level commands, ESP32 responds as if it were a dimmer.

**Challenge:** Likely requires responding to bridge pairing queries with correct handshake/crypto.

**Investigation needed:**
- Capture bridge <-> dimmer pairing sequence
- Identify what responses the bridge expects from a dimmer during pairing
- Check for challenge/response or certificate exchange

### ESP32 as Bridge

ESP32 cannot act as a bridge that real dimmers pair to.

**Goal:** Real Lutron dimmers pair to our ESP32, which can then control them.

**Challenge:** Need to emit correct beacon/pairing packets that dimmers recognize and respond to.

**Investigation needed:**
- Capture real bridge beacon sequence during pairing mode
- Capture dimmer's response to bridge pairing
- Identify the full handshake sequence
- Check if dimmers validate bridge identity

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
