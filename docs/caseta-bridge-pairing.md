# Caseta/RA3 Bridge Pairing Protocol

Reverse engineered from 3 pairing captures (2026-02-06) using passive ESP32 CC1101 monitoring of a real RadioRA3 bridge pairing DVRF-5NS on/off switches and a DVRF-6L dimmer.

---

## Phase Structure

All 3 captures follow the same 9-phase sequence (~60-70 seconds total):

| Phase | Duration | Packets | Description |
|-------|----------|---------|-------------|
| 0 | ~4s | 91/92/93 | Idle beacons (format 0x08, subcmd 0x01) |
| 1 | ~46s | 91/92/93 | Active pairing beacons (format 0x0C, subcmd 0x02) |
| 2 | ~0.8s | B0/B2 | Device announces itself (format 0x17) |
| 3 | ~2s | 93 + A1 + 82 | Bridge acknowledges: 0x0D beacon, config, unpair |
| 4 | ~2s | 91/92/93 | Brief beacon resume (device processes unpair) |
| 5 | ~4s | A1/A2/A3 | Full config burst: 4 integration IDs + capabilities |
| 6 | ~4s | 91/92/93 | Post-pairing beacons (subcmd 0x04 = "committed") |
| 7 | ~0.8s | 81 | LED configuration |
| 8 | ~1.7s | C1-E0 | Handshake (6 rounds, challenge-response) |

---

## Beacon State Machine

Beacons cycle types 93 → 91 → 92 in ~5-second segments. The subcmd byte at offset 15 encodes the pairing state:

| Subcmd | State | Format |
|--------|-------|--------|
| 0x01 | Idle (no pairing) | 0x08 |
| 0x02 | Seeking (waiting for device) | 0x0C |
| 0x04 | Committed (device paired) | 0x0C |
| 0x06 | Found (device identified) | 0x0D |

### Idle Beacon (format 0x08)
```
92 [seq] [bridge:4] 21 08 00 ff ff ff ff ff 08 01 cc cc cc cc cc cc [CRC:2]
```

### Active Beacon (format 0x0C)
```
93 [seq] [bridge:4] 21 0c 00 ff ff ff ff ff 08 02 [load_id:4] cc cc [CRC:2]
```
- `load_id` = target load address (e.g., `90 2C 1A 04`)

### "Device Found" Beacon (format 0x0D)
```
93 [seq] [bridge:4] 21 0d 00 [device:4] fe 08 06 [load_id:4] [counter] cc [CRC:2]
```
- `device` = HW ID of discovered device
- `counter` = monotonic pairing counter (increments each pairing: 06, 07, 08...)

---

## Device Announce (B0/B2, format 0x17)

Sent by the device in response to active beacons. 53 bytes with CC padding.

```
[type] 00 [prefix] [subnet:2] 7f 21 17 00 ff ff ff ff ff 08 05 [hw_id:4] [class] [subtype] [fw:2] ff 00 00 [ext:3] cc...cc [CRC:2]
```

| Field | Offset | Description |
|-------|--------|-------------|
| Type | 0 | B0 (switch) or B2 (dimmer) |
| Prefix | 2 | A0 (first), then A2/AF |
| Subnet | 3-4 | Echoes bridge subnet |
| Flag | 5 | Always 0x7F |
| HW ID | 16-19 | Device hardware/factory ID |
| Class | 20 | 0x04 for all load devices |
| Subtype | 21 | 0x64=switch, 0x63=dimmer |
| Firmware | 22-23 | Version (e.g., 01 01 or 02 01) |
| Extended | 27-29 | Switch: 00 00 00, Dimmer: 01 03 15 |

### Device Type Table (class 0x04)

| Subtype | Model | Type |
|---------|-------|------|
| 0x63 | DVRF-6L | 600W Dimmer |
| 0x64 | DVRF-5NS | On/Off Switch |

---

## Configuration Packets

### Integration ID Assignment (A1/A2/A3, format 0x0F, subcmd 0x70)

The bridge assigns 4 integration IDs to each device. These are **load-specific** (same IDs reused when re-pairing a different device to the same load).

```
[type] [seq] [bridge:4] 21 0f 00 [target:4] fe 06 70 [slot] [integ_id:4] 00 00 cc
```

| Field | Offset | Description |
|-------|--------|-------------|
| Target | 9-12 | Device HW ID (variable) or Integration ID (for slot assignment) |
| Slot | 16 | Slot/function code (00, 01, 06/07, 26, 2C) |
| Integ ID | 17-20 | 4-byte integration ID being assigned |

Slot byte 16 values observed:
- `00` = assign integration ID 2 (`04 D0 B5 91`)
- `01` = reference integration ID 1 (`08 51 24 C9`)
- `06`/`07` = initial binding with counter (increments per pairing)
- `26` = assign integration ID 3 (`02 EE 94 F7`)
- `2C` = assign integration ID 4 (`01 D4 8D 24`)

### Unpair/Clear (0x82, format 0x09)

Sent before new config to clear previous associations:

```
82 [seq] [bridge:4] 21 09 00 [device:4] fe 02 02 01 cc cc cc cc cc [CRC:2]
```

5 retransmissions with varying type bytes.

### Capability Config (A3, format 0x0F, subcmd 0x50)

Device-type-dependent configuration:

**Switch (1 packet):**
```
a3 [seq] [bridge:4] 21 0f 00 [device:4] fe 06 50 00 05 04 [instance] 01 00 03 cc
```
- `instance` = device instance counter (01, 02, 03...)

**Dimmer (2 packets):**
```
# Initial (same structure as switch but instance=03):
a2 [seq] [bridge:4] 21 0f 00 [device:4] fe 06 50 00 05 04 03 01 00 03 cc

# Dimmer-specific config (additional packet):
a3 [seq] [bridge:4] 21 0f 00 [device:4] fe 06 50 00 0c 04 3b 92 00 03 cc
```

The second packet (`0C 04 3B 92`) likely configures dimmer-specific parameters (fade rates, dim range, waveform).

### Zone Binding (A1/A2/A3, format 0x1A, subcmd 0x40)

Binds integration IDs to zones. Sent in two rounds (byte 20 = 0x20, then 0x22):

```
# Round 1: Bind integration ID 3
a3 [seq] [bridge:4] 21 1a 00 [device:4] fe 06 40 [integ_id_3:4] 00 20 00 03

# Round 1: Bind integration ID 4
a1 [seq] [bridge:4] 21 1a 00 [device:4] fe 06 40 [integ_id_4:4] 00 20 00 03

# Round 1: Set initial level
a2 [seq] [bridge:4] 21 1a 00 [device:4] fe 06 40 00 00 00 [fc/fb] ef 20 00 03

# Round 2: Same pattern with byte 20 = 0x22
```

- Byte 19 = `EF` (zone marker, shared with Vive protocol)
- Byte 20 = `20` (round 1) or `22` (round 2)
- Byte 18 alternates: `FC` (round 1) → `FB` (round 2)

### LED Config (0x81, format 0x0A)

```
81 [seq] [bridge:4] 21 0a 00 ff ff ff ff ff 09 06 00 00 cc cc cc cc [CRC:2]
```

Broadcast to all devices. Identical for switches and dimmers.

---

## Handshake (C1-E0)

6 rounds of challenge-response after configuration. Device sends odd type (C1, C7, CD, D3, D9, DF), bridge responds with even type (C2, C8, CE, D4, DA, E0).

```
[type] [seq] [subnet:2] [data:18] [CRC:2]
```

Handshake uses subnet directly (not full bridge ID). Sequence tags increment by 0x20: 20, 40, 60, 80, A0, C0.

### Round Structure

| Round | Seq Tag | Content |
|-------|---------|---------|
| 1 | 0x20 | Session nonce (varies per device: `63 F0`, `67 F0`, `6F F0`) |
| 2 | 0x40 | Constant: `18 86 ... 01 01` |
| 3 | 0x60 | Constant: `93 38 [FE/18] ... FE 7A` |
| 4 | 0x80 | Device config params (dimmer: `01 00 00 FF ... 32 01 DA`) |
| 5 | 0xA0 | All zeros |
| 6 | 0xC0/0xE0 | All zeros (final) |

Round 1 byte 4 varies per device (session nonce). Round 4 contains device-type-specific operating parameters.

---

## Constant vs Variable Bytes

**Constant (protocol structure):**
- All format bytes (0x08, 0x0C, 0x0D, 0x0F, 0x1A, 0x0A, 0x09, 0x17)
- All subcmd bytes (01, 02, 04, 05, 06, 50, 70, 40, 09)
- Bridge ID, subnet, load ID
- Integration IDs (load-specific, not device-specific)
- Zone binding values (0x20, 0x22, 0x03, 0xEF)
- LED config (09 06 00 00)
- Handshake rounds 2, 3, 5, 6

**Variable (per-device):**
- Device HW ID (bytes 9-12 in most packets)
- Pairing counter (monotonic, increments each pairing)
- Device instance counter in subcmd 0x50
- Handshake round 1 nonce (byte 4)
- Handshake round 4 config params
- Capability config (dimmer gets extra packet)

---

## Comparison: Caseta vs Vive Pairing

| Aspect | Caseta/RA3 | Vive |
|--------|-----------|------|
| Beacon types | 91/92/93 cycling | B9 only |
| Device announce | B0/B2 | B8 |
| Config packets | A1/A2/A3 (24-byte) | AB/A9/AA (53-byte) |
| Integration IDs | 4 per device | None (zone ID only) |
| Unpair step | 82 before config | None |
| Zone marker | 0xEF at byte 19 | 0xEF at byte 13 |
| Command class 0x40 | In zone binding | In ON/OFF commands |
| LED config | 81 (broadcast) | Not observed |
| Handshake | C1-E0 (6 rounds) | None |
| Total duration | ~66 seconds | ~30 seconds |

---

## Reference Captures

| File | Device | HW ID |
|------|--------|-------|
| `cca_packets_2026-02-06T05-59-49.csv` | DVRF-5NS switch #1 | 07 07 DF 6A |
| `cca_packets_2026-02-06T06-12-19.csv` | DVRF-5NS switch #2 | 07 01 6F CE |
| `cca_packets_2026-02-06T06-28-13.csv` | DVRF-6L dimmer | 07 03 C3 C6 |
