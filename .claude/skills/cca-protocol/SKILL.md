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
| `docs/protocols/cca/index.md` | Human-readable protocol reference (packet types, addressing, commands, pairing flows) |
| `docs/devices/qsm.md` | RE findings from QSM firmware: trampoline table, TDMA, 8N1 codec, CRC, CC1101 config, dispatch tables |
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
