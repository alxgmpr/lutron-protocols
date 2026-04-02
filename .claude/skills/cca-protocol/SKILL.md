---
name: cca-protocol
description: "CCA protocol reference — packet types, TDMA timing, 8N1 framing, QS Link fields. Points to authoritative sources, no duplication."
metadata:
  author: alex
  version: "1.0"
user_invocable: false
---

# CCA Protocol Reference

## Sources of Truth

**Do not duplicate protocol knowledge here.** Read these files directly:

| File | What it contains |
|------|-----------------|
| `protocol/cca.protocol.ts` | **The** source of truth. All enums, packet types, field layouts, QS Link constants, timing, sequences, pairing presets, device fingerprints |
| `protocol/protocol-ui.ts` | Runtime parsing: `identifyPacket()`, `parseFieldValue()`, format discrimination rules |
| `protocol/shared.ts` | Cross-protocol encoding: level ↔ percent, fade ↔ quarter-seconds |
| `docs/protocols/cca.md` | Human-readable protocol reference (packet types, addressing, commands, pairing flows) |
| `docs/firmware-re/qsm.md` | RE findings from QSM firmware: trampoline table, TDMA, 8N1 codec, CRC, CC1101 config, dispatch tables |
| `docs/protocols/qslink.md` | QS Link protocol + CCA field naming mapping appendix |

## How to Search

```bash
# Find a packet type or constant by name
grep -n "BEACON\|beacon" protocol/cca.protocol.ts

# Find all QS Link constants
grep -n "Qs\|QS_" protocol/cca.protocol.ts

# Find field layout for a specific packet type
grep -A 20 "BTN_SHORT_A" protocol/cca.protocol.ts

# Find timing constants
grep -n "timing\|repeat\|interval\|Timing" protocol/cca.protocol.ts

# Find how a packet type is identified at runtime
grep -A 10 "0x88\|BTN_SHORT" protocol/protocol-ui.ts

# Find what C constants are generated for firmware
grep "define\|const" firmware/src/cca/cca_generated.h | head -40
```

## Critical Callouts

### OUTPUT vs DEVICE
The fundamental architectural split in Lutron. OUTPUT = zone/load control with level + fade + delay (CCA format 0x0E, CCX type 0). DEVICE = component control like button presses (CCA pico packets, CCX type 1). This is why pico set-level has no fade — it uses the DEVICE path.

### Packet Length Rule
Type byte determines length: 0x80-0x9F = 24 bytes (22 data + 2 CRC), 0xA0+ = 53 bytes (51 data + 2 CRC). Long packet padding is 0x00. Exception: dimmer ACK (type 0x0B) is 5 bytes with XOR encoding, not 8N1.

### Level Encoding
`level16 = percent * 0xFEFF / 100` — shared across CCA and CCX. Note: 0xFEFF not 0xFFFF. The max is 0xFE for 8-bit, 0xFEFF for 16-bit. 0xFF/0xFFFF are reserved.

### 8N1 Framing
Each byte over the air: start bit (0) + 8 data bits (LSB first) + stop bit (1) = 10 bits. Sync marker: 8N1(0xFF) + 8N1(0xFA) + 8N1(0xDE) preceded by 32-bit alternating preamble (0xAA pattern). CRC-16 poly 0xCA0F appended as 2 bytes before 8N1 encoding.

### TDMA Timing
- Each seq increment = 12.5ms
- Slot = `seq & 7` (8-slot frame standard)
- Frame period = 75ms
- Devices stay in same slot across retransmits (seq increments by stride)
- Retransmits: 5 (normal), 10 (pairing/scene), 16 (button), 20 (level)

### Format Discrimination
State types (0x80-0x83) and config types (0xA1-0xA3) are **overloaded** — the format byte (byte 7) determines the actual packet meaning. A 0x81 with format 0x0E is SET_LEVEL, but 0x81 with format 0x0C is UNPAIR. See `formatDiscrimination` in `cca.protocol.ts`.

### Device ID Endianness
Button/pairing/handshake types use **big-endian** device ID at bytes 2-5. State/config types (0x80-0x83, 0xA1-0xA3) use **little-endian**. The `cca_uses_be_device_id()` function in generated code handles this.
