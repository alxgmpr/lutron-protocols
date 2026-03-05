# CCX Sunnata Commissioning Capture Analysis

Captured 2026-03-04 — pairing + transfer of a real Sunnata dimmer to RA3 processor.

## Capture Files
- `/tmp/thread-commission-capture.pcapng` — 210 frames, 80s — Thread join (BLE pairing phase, sniffer only)
- `/tmp/thread-transfer-capture.pcapng` — 2726 frames, 303s — Full transfer with CoAP programming

## Network Topology
- 21 unique Thread devices (EUI-64s)
- 16 routers responding to MLE
- Processor IPv6: `::54dc:e9ff:fe40:243d`
- New Sunnata IPv6: `::b489:31ff:fecb:8a93`
- Second device programmed: `::3c2e:f5ff:fef9:73f9`

## Phase 1: BLE Pairing (not captured on Thread)
- Device pairs via BLE to the Lutron app
- No Thread traffic during this phase
- Device must be rebooted after BLE pairing

## Phase 2: Thread Join (t=73.6s in commission capture)
- Standard MLE Parent Request to ff02::2
- 16 routers responded within 500ms
- Selected parent: `52:33:27:e5:03:f0:0c:38`
- Full join in 780ms
- No special authentication beyond Thread network credentials

## Phase 3: Transfer Programming (CoAP on UDP:5683)

Processor sends programming to device's mesh-local IPv6. Uses **separate response** pattern:
1. Processor sends CON request
2. Device immediately ACKs with empty ACK
3. Device processes, then sends CON response (2.02/2.04)
4. Processor ACKs

### Sequence:

#### Step 1: Clear — DELETE /cg/db
- Processor sends CON DELETE /cg/db
- Device takes ~2 seconds to process (wipes config)
- Responds with 2.02 Deleted

#### Step 2: Multicast Groups — POST /cg/db/mc/c/AAI
4 entries, each a CBOR array containing a 5-byte group address:
```
["00000e3fef"]
["00000e50ef"]
["00000020ef"]
["00000e4fef"]
```

#### Step 3: Programming Records — POST /cg/db/pr/c/AAI
5 preset-to-zone mappings. CBOR map with 3-byte keys (bucket token):
- Key bytes: [bucket_hi, bucket_lo, preset_key]
- Value: [recType=72, {0: zone_id}]

| Bucket | Preset Key | Zone ID |
|--------|-----------|---------|
| 0x28ef | 0x20 | 15826 |
| 0x27ef | 0x20 | 32310 |
| 0x26ef | 0x20 | 48795 |
| 0x25ef | 0x20 | 65279 (0xFEFF = 100%) |
| 0x24ef | 0x20 | 0 |

#### Step 4: Config Table — PUT /cg/db/ct/c/*
| Record ID | Type | CBOR |
|-----------|------|------|
| AAI | ZONE(3) | {2: 58685, 3: 2638, 8: 5} — zone_id=0xE53D |
| AAM | DEVICE(9) | {1: 48640, 3: 1, 4: 1, 8: 20, 10: 3} — device model/variant |
| AAU | SCENE(57) | {0: 1, 1: 50} — scene enabled, level 50% |
| AAY | SCENE(57) | {0: 1, 1: 50} — scene enabled, level 50% |

Final step re-sends AAI ZONE record (possibly commit/finalize).

Second device (`::3c2e:f5ff:fef9:73f9`) also received a PUT /cg/db/ct/c/AAI ZONE record.

## Runtime Traffic (UDP:9190 multicast to ff03::1)

### PRESENCE (type 0xFFFF)
```cbor
[65535, {4: status, 5: seq}]
```
- status=1 means online
- Sent by processor, flooded via MPL (multiple copies from different routers)
- ~30 second interval

### STATUS (type 0x29 = 41)
```cbor
[41, {
  0: {0: 0, 2: <24-byte binary blob>},
  2: [1, <timestamp>],
  3: {1: <group_id>}
}]
```
- Unicast from device to processor (fd00::ff:fe00:XXXX → fd00::ff:fe00:6c00)
- 24-byte binary status blob contains device state
- group_id = 30052-30056 range
- Multiple devices send STATUS every ~30s

### SCENE_RECALL (type 40 = 0x28)
```cbor
[40, {
  0: {0: 0},
  1: [0],
  3: {0: scene_id, 2: [component_type, value]},
  5: seq
}]
```

### COMPONENT_CMD (type 7)
```cbor
[7, {0: {1: {0: <response_code>}}, 5: seq}]
```

## Key Observations
- Processor address is always fd00::ff:fe00:6c00 (RLOC16 = 0x6c00)
- LEVEL_CONTROL is multicast to ff03::1 — ALL Thread devices hear it
- Programming is unicast CoAP to specific device IPv6
- No certificate or device identity validation observed on Thread layer
- CoAP responses use standard codes (2.02 Deleted, 2.04 Changed)
- The "AAI", "AAM", "AAU", "AAY" record IDs appear to be base64-encoded bucket identifiers
