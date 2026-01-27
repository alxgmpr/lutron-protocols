# Bridge-Dimmer Pairing Handshake Analysis

Analysis of capture: `captures/bridge_dimmer_pairing.log`
Dimmer: DVRF-6L (Hardware ID: `06FE43B1`)
Bridge Zone: `902C`

## Timeline Overview

```
09:10:49 - 09:11:04  Bridge beacon phase (0x93 -> 0x91 -> 0x92)
09:11:05.352         Dimmer responds with 0xB0 discovery packets
09:11:10.493         Bridge acknowledges dimmer in beacon (0x92)
09:11:11.239         Configuration exchange begins (0xA1, 0xA2, 0xA3)
09:11:11.386         State reports (0x81)
09:11:15+            Extended config (0xA1, 0xA2, 0xA3)
09:11:17.114         Dimmer state report (0x80)
09:11:17.6+          Zone assignment (0xA1 broadcast)
09:11:19+            Final handshake (0x83, 0xC1, 0xC7)
```

## Device Identification via RSSI

| RSSI Range | Source | Notes |
|------------|--------|-------|
| -33 to -43 | Dimmer | Closer to receiver |
| -49 to -57 | Bridge | Further from receiver |
| -50 to -52 | Bridge relay | Bridge repeating dimmer packets |

## Phase 1: Bridge Beacon (0x93 -> 0x91 -> 0x92)

Bridge broadcasts pairing beacons. Three beacon types used in sequence:

### Type 0x93 - Initial Beacon
```
93 XX AF 90 2C 00 21 08 00 FF FF FF FF FF 08 01 CC CC CC CC CC CC XX XX
   seq    zone     proto     [broadcast]  flag
```
- Zone ID: `90 2C`
- Broadcast ID: `FF FF FF FF FF`
- RSSI: ~-56 to -59 (bridge)

### Type 0x91 - Pairing Beacon Stage 2
```
91 XX AF 90 2C 00 21 0C 00 FF FF FF FF FF 08 02 90 2C 1A 04 CC CC XX XX
   seq    zone     proto     [broadcast]  flag zone ??
```
- Adds bridge zone `90 2C` and flags `1A 04`

### Type 0x92 - Pairing Beacon Stage 3
```
92 XX AF 90 2C 00 21 0C 00 FF FF FF FF FF 08 02 90 2C 1A 04 CC CC XX XX
```
- Similar structure to 0x91

## Phase 2: Dimmer Discovery Response (0xB0)

Dimmer responds to bridge beacon with its hardware ID:

```
B0 00 A0 90 2C 7F 21 17 00 FF FF FF FF FF 08 05 06 FE 43 B1 04 63 02 01 FF 00 00 01 03 15 00 ...
   seq    zone  ?  proto     [broadcast]  flag |--dimmer--|  |----device capabilities-----|
```

### Field Analysis:
| Offset | Bytes | Value | Meaning |
|--------|-------|-------|---------|
| 0 | 1 | B0 | Packet type: DIMMER_DISCOVERY |
| 1 | 1 | XX | Sequence |
| 2 | 1 | A0/A2/AF | Format flags |
| 3-4 | 2 | 90 2C | Bridge zone ID |
| 5 | 1 | 7F | Pairing flag? |
| 6 | 1 | 21 | Protocol |
| 7 | 1 | 17 | Length |
| 8 | 1 | 00 | Reserved |
| 9-13 | 5 | FF FF FF FF FF | Broadcast (no target yet) |
| 14 | 1 | 08 | Header flag |
| 15 | 1 | 05 | Capability header |
| 16-19 | 4 | 06 FE 43 B1 | **Dimmer Hardware ID** |
| 20 | 1 | 04 | Device type (dimmer) |
| 21 | 1 | 63 | Capability flags |
| 22 | 1 | 02 | Protocol version? |
| 23 | 1 | 01 | Subtype |
| 24 | 1 | FF | Max level |
| 25-26 | 2 | 00 00 | Reserved |
| 27 | 1 | 01 | Min level |
| 28 | 1 | 03 | Zone count? |
| 29 | 1 | 15 | Features |
| 30 | 1 | 00 | Reserved |

### RSSI Pattern:
- RSSI -33 to -38: Direct from dimmer
- RSSI -50 to -52: Bridge repeating/acknowledging

## Phase 3: Bridge Acknowledges Dimmer (0x92 with ID)

Bridge updates beacon to include the learned dimmer ID:

```
92 01 AD 90 2C 00 21 0D 00 06 FE 43 B1 FE 08 06 90 2C 1A 04 06 CC XX XX
                        |--dimmer ID--|
```

This confirms the bridge has registered the dimmer.

## Phase 4: Configuration Exchange (0x81, 0xA1, 0xA2, 0xA3)

### Type 0x81 - State Confirmation
```
81 01 AD 90 2C 00 21 09 00 06 FE 43 B1 FE 02 02 01 ...
                        |--dimmer ID--|  state
```
- Dimmer ID embedded
- State: `02 02 01` (likely level + flags)

### Type 0xA3 - LED/Config (from bridge)
```
A3 01 AD 90 2C 00 21 0F 00 06 FE 43 B1 FE 06 70 00 04 D0 B5 91 ...
                        |--dimmer ID--|     |--config data--|
```
- Contains dimmer ID
- Config data includes additional IDs like `04 D0 B5 91`

### Type 0xA1 - Config Response (from dimmer, RSSI -42)
```
A1 01 AD 90 2C 00 21 0F 00 06 FE 43 B1 FE 06 70 01 08 51 24 C9 ...
                        |--dimmer ID--|        |---ID 2----|
```
- Second ID: `08 51 24 C9` (possibly assigned load ID?)

### Type 0xA2 - Zone Config (from dimmer)
```
A2 01 AD 90 2C 00 21 0F 00 06 FE 43 B1 FE 06 50 00 05 04 01 01 00 03 ...
                        |--dimmer ID--|     |--zone config--|
```

## Phase 5: Dimmer State Report (0x80)

Dimmer reports its current state:

```
80 00 80 90 2C 06 00 08 00 1B 01 FE 00 1B 92 6F ...
         zone  proto     |-----state data-----|
```

| Field | Value | Meaning |
|-------|-------|---------|
| Zone | 90 2C | Bridge zone |
| Protocol | 06 | CCA protocol |
| Length | 08 | 8 bytes payload |
| State | 1B 01 FE 00 1B 92 6F | Current level + status |

RSSI: -42 (from dimmer)

## Phase 6: Zone Assignment Broadcast (0xA1)

Bridge broadcasts zone configuration:

```
A1 00 40 90 2C 06 21 15 00 00 00 00 00 FC 06 50 00 02 0A 13 FE 30 23 0B
         zone  proto        reserved      |-----zone assignment-----|
```

## Phase 7: Final Handshake (0xC1, 0xC7)

### Type 0xC1 - Completion
```
C1 20 90 2C 62 70 D0 FE 00 00 00 FE FE 00 00 00 00 00 FE 19 FE 00 E5 3E
```

### Type 0xC7 - Confirmation
```
C7 20 90 2C 62 F0 D0 FE 00 00 00 FE FE 00 00 00 00 00 FE 19 FE 7E 89 7A
```

These appear to be the final handshake confirmation packets.

## New Packet Types Discovered

| Type | Name | Length | Direction | Purpose |
|------|------|--------|-----------|---------|
| 0x80 | STATE_80 | 24 | Dimmer->Bridge | Current state report (pairing phase) |
| 0x93 | BEACON_93 | 24 | Bridge | Initial pairing beacon |
| 0xA1 | CONFIG_A1 | 24 | Both | Configuration exchange |
| 0xB0 | DIMMER_DISC | 53 | Dimmer->Bridge | Dimmer announces hardware ID |

### Handshake Packets (6-round exchange)

Type bytes increment by 6, same as sequence bytes. Dimmer sends odd types, bridge sends even:

| Type | Name | Direction | Round | Purpose |
|------|------|-----------|-------|---------|
| 0xC1 | HS_C1 | Dimmer | 1 | Dimmer handshake round 1 |
| 0xC2 | HS_C2 | Bridge | 1 | Bridge handshake round 1 |
| 0xC7 | HS_C7 | Dimmer | 2 | Dimmer handshake round 2 |
| 0xC8 | HS_C8 | Bridge | 2 | Bridge handshake round 2 |
| 0xCD | HS_CD | Dimmer | 3 | Dimmer handshake round 3 |
| 0xCE | HS_CE | Bridge | 3 | Bridge handshake round 3 |
| 0xD3 | HS_D3 | Dimmer | 4 | Dimmer handshake round 4 |
| 0xD4 | HS_D4 | Bridge | 4 | Bridge handshake round 4 |
| 0xD9 | HS_D9 | Dimmer | 5 | Dimmer handshake round 5 |
| 0xDA | HS_DA | Bridge | 5 | Bridge handshake round 5 |
| 0xDF | HS_DF | Dimmer | 6 | Dimmer handshake round 6 (final) |
| 0xE0 | HS_E0 | Bridge | 6 | Bridge handshake round 6 (final) |

## CCA Tool Decode Summary

```
Total packets: 535
Valid CRC: 478 (89%)
Invalid CRC: 57 (11%)

Top packet types:
  BEACON_STOP (0x92): 156
  BEACON_91: 104
  BEACON_93: 60
  STATE_RPT: 26
  DIMMER_DISC: 22
  STATE_80: 19
  CONFIG_A1: 19
  PAIR_RESP_C1: 17
  PAIR_RESP_C7: 13
```

## Pairing Phase Breakdown (from capture 2)

```
Phase 1: Discovery (~1 sec)
  09:31:12 - B0 packets from dimmer (RSSI -34 = dimmer direct)

Phase 2: Configuration (~15 sec)
  09:31:17 - A1/A2/A3 config exchange begins
  09:31:23 - 80 state reports (device FLASHES to confirm)
  09:31:24 - More A1 zone assignment packets
  09:31:26 - Final A2/90 config packets

Phase 3: User Confirmation (5 sec pause)
  09:31:27-32 - Waiting for user to press 'Done' in app
  09:31:32 - 81 state confirmation packets

Phase 4: Finalization (~15 sec)
  09:31:33+ - C/D/E handshake packets after user pressed 'Done'
```

**Handshake RSSI Pattern (C/D/E packets):**
- Bridge packets (RSSI -46 to -48): C2, C8, CE, D4, DA, E0
- Dimmer packets (RSSI -64 to -70): C1, C7, CD, D3, D9, DF

## Zone/Load ID Assignment

During the finalization phase (when user presses "Save" in app), the bridge sends 0x83 STATE_RPT packets that establish the zone/load ID relationship.

### Finalization Packets (0x83)

Captured right as device name was saved:
```
83 01 AD 90 2C 00 21 09 00 06 FE 43 B1 FE 02 02 01 CC CC CC CC CC 81 D7
83 87 AF 90 2C 00 21 09 00 06 FE 43 B1 FE 02 02 01 CC CC CC CC CC 99 6C
83 8D AF 90 2C 00 21 09 00 06 FE 43 B1 FE 02 02 01 CC CC CC CC CC 22 F8
```

| Field | Bytes | Value | Meaning |
|-------|-------|-------|---------|
| Type | 0 | 0x83 | STATE_RPT |
| Sequence | 1 | varies | 0x01, 0x87, 0x8D, 0xAB, 0xBE |
| Source ID (LE) | 2-5 | AD 90 2C 00 | Bridge zone 0x002C90AD |
| Protocol | 6 | 0x21 | CCA |
| Format | 7 | 0x09 | True state report |
| Target ID (BE) | 9-12 | 06 FE 43 B1 | Dimmer hardware ID |
| State | 14-16 | 02 02 01 | Current state |

### ID Structure Analysis

Both bridge zones and dimmer load IDs share a common zone component:

| Type | Full ID | Prefix | Zone | Suffix |
|------|---------|--------|------|--------|
| Bridge Zone 1 | 0x002C90AD | 0x00 | 2C 90 | AD |
| Bridge Zone 2 | 0x002C90AF | 0x00 | 2C 90 | AF |
| Dimmer Load 1 | 0x062C9080 | 0x06 | 2C 90 | 80 |
| Dimmer Load 2 | 0x062C908F | 0x06 | 2C 90 | 8F |

**Pattern:**
- **Zone bytes** (`2C 90` = `902C` big-endian): Shared between bridge and dimmer
- **Prefix**: `0x00` for bridge, `0x06` for dimmer (device type indicator)
- **Suffix**: Uniquely assigned during pairing

The dimmer reports using its assigned load IDs (0x062C9080, 0x062C908F) rather than its hardware ID (0x06FE43B1) after pairing is complete.

## Key Findings

1. **Dimmer ID at fixed offset**: In 0xB0 packets, dimmer hardware ID is always at bytes 16-19.

2. **RSSI distinguishes direction**: Dimmer packets have stronger RSSI (-33 to -43) vs bridge (-49 to -57).

3. **Bridge relay visible**: Some packets appear twice with different RSSI (dimmer sends, bridge relays).

4. **Pairing is bidirectional**: Both devices actively participate:
   - Bridge: Beacon, acknowledge, configure
   - Dimmer: Discovery, state reports, confirm

5. **Device capabilities in discovery**: 0xB0 contains device type (`04` = dimmer), max level (`FF`), etc.

6. **Zone/Load ID assignment**: Bridge assigns load IDs to dimmer that share the bridge's zone bytes but with different prefix (0x06 vs 0x00) and suffix.

## What ESP32 Needs to Emulate Dimmer

To pair as a load device (dimmer):
1. Listen for 0x91/0x92/0x93 beacon packets from bridge
2. Respond with 0xB0 discovery packet containing our device ID
3. Wait for bridge acknowledgment (0x92 with our ID)
4. Exchange configuration (respond to 0xA3 with 0xA1/0xA2)
5. Send state report (0x80) when requested
6. Confirm pairing with appropriate response

## What ESP32 Needs to Emulate Bridge

To act as a bridge that dimmers pair to:
1. Broadcast 0x93 beacon to enter pairing mode
2. Transition to 0x91, then 0x92 beacons
3. Listen for 0xB0 discovery from dimmers
4. Update beacon to include discovered dimmer ID
5. Send configuration packets (0xA3)
6. Complete with 0xC1, 0xC7
