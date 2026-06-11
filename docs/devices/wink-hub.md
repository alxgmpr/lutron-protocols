# Wink Hub 1 Firmware RE Findings

Reverse engineered from Wink Hub 1 (i.MX28, firmware 4.3.60), accessed via NAND voltage glitch.
Target binary: `lutron-core` (1.5MB, ARM, stripped but with C++ RTTI symbols).

## Key Finding: CCA State Discovery Mechanism

### No per-device query
Confirmed 2026-03-26: CCA has no **per-device** over-the-air poll/query. Tested format 0x09
with class 0x40/types 0x64-0x66, class 0x03/type 0x02, and class 0x01/type 0x22 — no RF
response from any device. The `RuntimePropertyQuery` in `lutron-core` queries the
coprocessor's cached state (host→coproc HDLC), not devices over RF.

### Broadcast boot poll (format 0x0A → 0x0D response)
Confirmed 2026-03-27 via processor reboot capture (`captures/cca-sessions/proc-reboot_2026-03-27T03-13-22.csv`).

When the processor boots, it uses a **broadcast poll** to discover all device states:

**Phase 1 — Processor announces itself (format 0x0A, broadcast):**
```
80 xx A1 82 D7 00 21 0a 00 ff ff ff ff ff 09 06 00 00 cc cc cc cc
```
- Type 0x80, format 0x0A, broadcast FF FF FF FF FF
- Byte 14 = 0x09, byte 15 = QS_CLASS_LEGACY (0x06)
- Repeats in ~4 second cycles, ~10 packets per burst with rotating sequence

**Phase 2 — Processor walks all zones with handshake rounds:**
```
c1 20 82 d7 fe bf 00 be 7f 00 00 3d fe ...  (zone FEBF — link properties?)
c1 40 82 d7 01 00 ...                        (zone 0100)
c1 60 82 d7 00 00 ...                        (zone 0000)
c1 80 82 d7 00 00 ...                        (seq 0x80)
c1 a0 82 d7 00 00 ...                        (seq 0xA0)
c1 c0 82 d7 00 00 ...                        (seq 0xC0)
c1 e0 82 d7 00 00 ...                        (seq 0xE0)
```
Full C1→C7→CD→D3→D9→DF cycle for each zone. Seq byte at offset 1 increments by 0x20
across zone groups.

**Phase 3 — Devices respond with format 0x0D (state/capability dump):**
```
81 01 a1 82 d7 00 21 0d 00 ff ff ff ff ff 48 02 1a 05 03 07 ea cc
```
- Type 0x81, format 0x0D, broadcast FF FF FF FF FF
- Byte 14 = 0x48, byte 15 = 0x02, byte 16 = 0x1A
- Bytes 17-19 = 05 03 07 (possibly firmware version or capability flags?)
- Byte 20 = 0xEA
- Followed by DIM_STEP (format 0x0B) bursts

**Format 0x0D is NOT yet decoded** — needs field analysis. It appears to be a device
capability/state announcement in response to the processor's broadcast poll.

**Implication:** To poll device state, broadcast format 0x0A with QS_CLASS_LEGACY (0x06).
All paired devices should respond with format 0x0D dumps. This is the missing "query"
mechanism — it's broadcast-based, not unicast.

### TODO
- [ ] Decode format 0x0D response fields (byte 14-20 meaning)
- [ ] Implement broadcast poll in firmware (send format 0x0A, collect 0x0D responses)
- [ ] Test if format 0x0A alone triggers responses, or if handshake walk is required
- [ ] Check if zone FEBF handshake has special meaning (link properties?)

## Coprocessor Architecture

The host CPU (i.MX28) talks to a CC110L radio coprocessor via HDLC over `/dev/ttySP2` at 115200 baud. The coprocessor handles all CCA RF — the host sends structured commands and receives events.

### HDLC Transport
- Standard HDLC framing with I/S/U frames
- 3-bit sequence numbers (mod 8)
- CRC validation on every frame
- Log format: `Rx I-Frame: <hex>` / `Tx I-Frame: <hex>`

### Host→Coproc Direction
Text-based JSON key-value messages with `"cmd"` and `"args"` keys:
```
{"cmd": "GoToLevel", "args": {"ObjectId": ..., "ObjectType": ..., "Level": ..., "Fade": ..., "Delay": ...}}
```

Registered command parsers:
| Command | Args | Notes |
|---------|------|-------|
| GoToLevel | ObjectId (u32), ObjectType (u32), Level (u16), Fade (u16), Delay (u16) | Full zone control |
| PresetActivate | PresetID (u32) | Scene activation, const 0x2B passed internally |
| Raise | ObjectId (u32), ObjectType (u32) | Start raise |
| Lower | ObjectId (u32), ObjectType (u32) | Start lower |
| RaiseLowerStop | ObjectId (u32), ObjectType (u32) | Stop dimming |
| RuntimePropertyQuery | Params: [[ObjectId, ComponentNum], ...] | Batch poll device state |

### Coproc→Host Direction
Binary messages with 16-bit command IDs at offset 0-1 (big-endian).

#### REPORT_EVENT (0x500)
```
Offset  Size  Field
0-1     2     Command ID (0x0500)
2       1     Link Address
3-6     4     Serial Number (big-endian)
7-8     2     Event Type (big-endian)
9       1     Component Number
10      1     Payload length
11+     var   Event payload
```

#### REPORT_PROPERTY_UPDATE (0x521)
```
Offset  Size  Field
0-1     2     Command ID (0x0521)
2-5     4     Object ID (big-endian)
6-7     2     Level value (big-endian, uint16, 0x0000-0xFEFF)
8       1     Property Type (1=Level, 43=Tilt)
9-12    4     Device Serial (big-endian)
```

#### Full Command ID Table
| Range | Purpose |
|-------|---------|
| 0x001-0x005 | System info/discovery |
| 0x101-0x118 | Addressing/pairing (enter/exit, identify, assign, unaddress, OOB) |
| 0x201-0x205 | Preset transfer/deletion responses |
| 0x300-0x312 | Component record transfer, DB sync, cmd src→dest affiliation |
| 0x500-0x525 | Runtime: events, presets, raise/lower, property updates, status |
| 0xE204-0xE206 | Engineering: ping, function test |

Each runtime command has FAILURE (even ID) and SUCCESS (odd ID) response pairs.

## DeviceClass Encoding

Full 32-bit `DeviceClass` from Lutron DB:

```
Byte 0 (MSB): Category
  0x01 = Input (keypads, picos)
  0x03 = Shade (roller, venetian, cellular, honeycomb)
  0x04 = Output (dimmers, switches, plug-in, bulb)
  0x05 = Infrastructure (repeater)
  0x06 = Sensor (occupancy, daylight)
  0x08 = Processor (gateway, bridge)
  0x16 = Module (softswitch)

Byte 1: Sub-category (product line within category)
  0x01/03 = Keypads, 0x07 = Pico, 0x15 = Super Pico
  0x04-0x0A = Shade variants
  0x01-0x37 = Dimmer/switch variants
  0x02 = Repeater, 0x08 = Sensor, 0x03 = Processor

Byte 2: Variant (usually 0x01 for standard)

Byte 3 (LSB): Model number
  Picos: 0x02=1btn, 0x03=2btn, 0x04=2btn+RL, 0x05=3btn, 0x06=3btn+RL
  Most others: 0x01
```

DeviceClassMask determines matching:
- `0xFFFF0000` = match category + sub-category (most devices)
- `0xFFFF00FF` = match category + sub-category + model, skip variant (Picos)

## Component Record Format

During pairing/config, "component records" are transferred over CCA long packets. Three types:

1. **PRESET_BUTTON** — button → preset scene mapping
2. **RAISE_LOWER_BUTTON** — button → raise/lower behavior
3. **RF_PROPERTY_ADDRESS** — zone → RF property address (for level reporting)

Serialized format per record: 4 bytes (2 control + 2 data as BE uint16).
Wrapped in envelope with size byte at offset 0xC. Min total: 14 bytes.

Deserialized fields (from CLEAR_CONNECT_COMPONENT_RECORD_DESERIALIZER):
```
Offset  Size  Field
4-5     2     Field 1 (big-endian uint16)
6-7     2     Field 2 (big-endian uint16)
8-9     2     Field 3 (big-endian uint16)
10-11   2     Field 4 (big-endian uint16)
12-13   2     Field 5 (big-endian uint16)
```

## PropertyAddress ↔ Zone Mapping

SQL from lutron-core reveals the chain:
```
Device (SerialNumber) + Component → PropertyAddress → Zone byte in CCA packets
```

Key queries:
- `SELECT PropertyAddress FROM GetRfPropertyAddressInfo WHERE SerialNumber = ? AND ReferenceComponentNumber = ?`
- `SELECT RuntimePropertyTypeID FROM GetRfPropertyAddressInfo WHERE PropertyAddress = ?`
- RuntimePropertyType: 1=Level, 43=Tilt

## Pairing State Machine

Full flow from coproc command IDs:
1. Enter addressing mode (0x101/0x102)
2. Device identify / beacon (0x105) — the B8/B9/BA packets
3. Assign device address (0x107/0x108) — address assignment
4. Transfer component records (0x300-0x302) — config long packets
5. Transfer presets (0x201/0x202) — scene assignments
6. Sync runtime databases (0x307/0x308)
7. Affiliate cmd source → destination (0x311/0x312) — button→zone binding
8. Exit addressing mode (0x104)

## Kidde Protocol

PIC microcontroller on `/dev/ttySP3`, text-based serial:
- Init: `I:<sysid>` where sysid is 1-byte hex system ID (default 0xAA)
- Response: 5-byte echo, "Kidde PIC is alive" if match
- RX mode (`-r` flag): continuous hex dump of received 433MHz packets
- `kiddetest` binary has full symbols (not stripped)

## Files Dumped

All at `/Volumes/Secondary/wink/dump/`:
- `binaries/lutron-core` (1.5MB), `aprond` (535KB), `kiddetest` (13KB, symbols), `libapron.so` (43KB)
- `databases/lutron-db.sqlite` (296KB — 60+ tables, full protocol definitions)
- `databases/apron.db` (117KB — multi-protocol device DB: ZWave, ZigBee, Lutron, BT)
- `coproc-protocol.md` — full command ID table
- `lutron-device-classes.csv` — DeviceClass mapping
- `lutron-core-strings.txt`, `lutron-core-messages.txt` — string dumps
