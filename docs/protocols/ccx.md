# Lutron Clear Connect Type X (CCX) Protocol

## CCX is Thread

Analysis of Lutron RadioRA3/Homeworks databases shows that Clear Connect X (CCX) is based on Thread, not a proprietary RF protocol like CCA.

Evidence:
- `fd00::` IPv6 prefixes indicate Thread/6LoWPAN Unique Local Addresses
- EUI-64 formatted addresses with `::ffff:fe` MAC derivation
- Standard 802.15.4 network parameters (PAN ID, Channel, Extended PAN ID)
- 16-byte AES-128 network master key

Thread is an 802.15.4-based mesh protocol that uses:
- IEEE 802.15.4 MAC layer (same as ZigBee)
- 6LoWPAN adaptation layer
- IPv6 network layer
- UDP/CoAP application layer (typically)

## Protocol Comparison

| Feature | Clear Connect A (CCA) | Clear Connect X (CCX) |
|---------|----------------------|----------------------|
| Frequency | 433 MHz | 2.4 GHz |
| Protocol | Proprietary | Thread (802.15.4) |
| Range | Long (433 MHz advantage) | Mesh extends range |
| Devices | Pico remotes, sensors | Dimmers, switches, processors |
| Network | Point-to-multipoint | IPv6 mesh |
| Encryption | Custom CRC/whitening | AES-128 (standard) |

## Network Parameters

Extracted from `LinkNetwork` table in Lutron project database:

| Parameter | Example Value |
|-----------|---------------|
| Channel | 25 (2480 MHz) |
| PAN ID | <pan-id> |
| Extended PAN ID | XX:XX:XX:XX:XX:XX:XX:XX |
| Network Master Key | XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX |

## Device Table (LinkNode)

Devices with IPv6 addresses are Thread routers/always-on devices.
NULL addresses indicate sleepy end devices (Picos, sensors).

| LinkNodeID | IPv6 Address | Role |
|------------|--------------|------|
| 640 | fd00::<device-iid-1> | Router |
| 835 | fd00::<device-iid-2> | Router |
| 233 | NULL | Sleepy end device |
| 1288 | NULL | Sleepy end device |

## MAC Address Derivation

Thread/6LoWPAN uses EUI-64 format. To derive MAC from IPv6:

1. Take the last 64 bits of the IPv6 address
2. Remove the `ff:fe` in the middle
3. Flip bit 7 of the first byte

Example: `fd00::<device-iid-1>`
- Interface ID: `<device-iid-1>`
- Remove ff:fe: `e406:bf` + `9a:114f`
- Flip bit 7: `e4` -> `e6`
- Result: `E6:06:BF:9A:11:4F`

## Sniffing Hardware

### Recommended: nRF52840 Dongle (~$15)

- Native 802.15.4 support
- Official Nordic Wireshark plugin
- Preferred Thread sniffer (Nordic is Thread contributor)
- Available from: Mouser, DigiKey, Amazon

### Alternative: CC2531 USB Dongle (~$10)

- Requires sniffer firmware flash
- Works with whsniff (Linux) or ZBOSS (Windows)
- Cheaper but more setup required

### Other Options

- HUSBZB-1 (~$45) - Works out of box
- Any 802.15.4 capable SDR

## Wireshark Configuration

### 1. Install nRF Sniffer for 802.15.4

Download from: https://www.nordicsemi.com/Products/Development-tools/nRF-Sniffer-for-802154

### 2. Configure Thread Decryption

Edit -> Preferences -> Protocols -> Thread

| Setting | Value |
|---------|-------|
| Thread Master Key | (from LinkNetwork table) |

### 3. Configure IEEE 802.15.4 Decryption

Edit -> Preferences -> Protocols -> IEEE 802.15.4 -> Decryption Keys -> Edit

Add the Network Master Key from your database.

### 4. Capture Settings

- Channel: (from LinkNetwork table, typically 25)
- Interface: nRF52840 sniffer

### 5. Display Filters

```
# All Thread traffic
thread

# All 802.15.4 traffic
wpan

# 6LoWPAN
6lowpan

# Specific PAN ID
wpan.dst_pan == <pan-id>

# Specific device by MAC
wpan.src64 == e6:06:bf:9a:11:4f
```

## Traffic Architecture

### Protocol Stack

```
802.15.4 MAC → 6LoWPAN → IPv6 → UDP:9190 (runtime CCX CBOR)
                                ↳ UDP:5683 (CoAP /cg/db programming plane)
```

tshark handles all lower layers (decryption, decompression, reassembly). The TypeScript decoder handles only the CBOR application payload.

### Multicast & Retransmission

All commands are multicast to `ff03::1` and retransmitted 7-25 times across the Thread mesh (~100ms window). The decoder deduplicates by `(msg_type, sequence)` pairs.

### Processor Address

The RA3 processor originates commands at `fd00::ff:fe00:2c0c`.

## Database Tables

| Table | Contents |
|-------|----------|
| LinkNetwork | Network parameters (channel, PAN ID, keys) |
| LinkNode | Device list with IPv6 addresses |
| LinkGroup | Multicast groups |
| LinkScene | Scene definitions |
| LinkBinding | Device-to-device bindings |
| LinkRoute | Mesh routing tables |

## Extracting Keys

Keys can be extracted from the LEAP API (`/link/{id}`) or from the project database. See [ra3-system.md](ra3-system.md) for database extraction instructions.

## Application Layer Protocol (Runtime CBOR over UDP)

CCX runtime control uses **CBOR-encoded messages** over **UDP port 9190**.
The programming plane uses CoAP on UDP 5683 (see [Programming Plane](#programming-plane-cgdb-over-coap) below).

### Message Structure

All messages are CBOR arrays with 2 elements:
```
[msg_type, body_map]
```

### Message Types

| Type | Name | Description |
|------|------|-------------|
| 0 | LEVEL_CONTROL | Direct level set (0x0000=OFF, 0xFEFF=ON) to zone |
| 1 | BUTTON_PRESS | Physical button/scene press with replay counters |
| 2 | DIM_HOLD | First of raise/lower pair (even seq), announces hold |
| 3 | DIM_STEP | Second of pair (odd seq), step=180-250 |
| 7 | ACK | Response to commands |
| 27 | DEVICE_REPORT | Devices broadcast after executing (no seq) |
| 36 | SCENE_RECALL | Scene/group recall, triggers DEVICE_REPORTs |
| 40 | COMPONENT_CMD | Shade/fan command, params=[10,4800] |
| 41 | STATUS | Periodic device status heartbeat |
| 65535 | PRESENCE | Device announcement |

### Body Map Keys

All message bodies are integer-keyed CBOR maps with shared top-level keys:

| Key | Name | Description |
|-----|------|-------------|
| 0 | COMMAND | Inner command data (type-specific) |
| 1 | ZONE | Zone info: `[zone_type, zone_id]` |
| 2 | DEVICE | Device info: `[type, device_id]` |
| 3 | EXTRA | Extra info map (scene ID, group ID, params) |
| 4 | STATUS | Status field (used by PRESENCE) |
| 5 | SEQUENCE | Sequence number |

### Level Control (Type 0) - Primary Command Format

```cbor
[0, {
    0: {
        0: <level>,     # 0xFEFF = ON (100%), 0x0000 = OFF (0%)
        3: 1            # Command subtype (always 1)
    },
    1: [<zone_type>, <zone_id>],  # e.g., [16, 961]
    5: <sequence>
}]
```

**Level Values** (LINEAR scale):
```
level = percent * 655.35
level = percent * (65535 / 100)
```

| Percent | Level (hex) | Level (dec) |
|---------|-------------|-------------|
| 0% | 0x0000 | 0 |
| 1% | 0x028F | 655 |
| 10% | 0x199A | 6554 |
| 25% | 0x4000 | 16384 |
| 50% | 0x8000 | 32768 |
| 75% | 0xBFFF | 49151 |
| 100% | 0xFFFF | 65535 |
| FULL ON | 0xFEFF | 65279 |

Note: `0xFEFF` ("full on") vs `0xFFFF` may distinguish "turn on" from "set to 100%"

**Zone Addressing**:
- `zone_type`: Usually 16 (may indicate device category)
- `zone_id`: Internal Lutron zone ID (e.g., 961)

**Example ON command** (hardware ID 0631acd7, zone 961):
```
Hex: 8200a300a20019feff03010182101903c105185c
Decoded: CCXLevelCommand(ON, level=100%, zone=961, seq=92)
```

**Example OFF command**:
```
Hex: 8200a300a2000003010182101903c105185d
Decoded: CCXLevelCommand(OFF, level=0%, zone=961, seq=93)
```

### Presence Broadcast (Type 65535)

Devices periodically broadcast presence messages:

```cbor
[65535, {
    4: 1,           # Status (1 = active?)
    5: <sequence>
}]
```

### Acknowledgment (Type 7)

```cbor
[7, {
    0: {
        1: {
            0: <response_bytes>
        }
    },
    5: <sequence>
}]
```

### Button Press (Type 1) - Physical Button/Scene

Triggered when a physical button is pressed on a Lutron device (keypad button, dimmer paddle).
The device broadcasts the button press, and the dimmer internally executes the associated scene.

```cbor
[1, {
    0: {
        0: <device_id>,       # 4 bytes: [preset_hi, preset_lo, 0xEF, 0x20]
        1: [cnt1, cnt2, cnt3] # Frame counters (replay protection)
    },
    5: <sequence>
}]
```

**Device ID = LEAP Preset ID**: Bytes 0-1 encode the LEAP Preset ID as a big-endian uint16.
Bytes 2-3 are always `0xEF 0x20`.

| Byte | Meaning |
|------|---------|
| 0 | Preset ID high byte |
| 1 | Preset ID low byte |
| 2 | 0xEF (constant) |
| 3 | 0x20 (constant) |

**Example**: Pressing "Office" on the Office Doorway keypad sends preset 1093 (secondary):
```
device_id = 04 45 EF 20  →  (0x04 << 8) | 0x45 = 1093 = SecondaryPreset of "Office" button
```

**Toggle behavior**: `AdvancedToggleProgrammingModel` buttons send different preset IDs
depending on toggle state — PrimaryPreset when turning off/recalling, SecondaryPreset when
activating. This is how the same physical button sends two different CCX messages.

**ACK Response**: Button presses receive ACK with response byte `0x55` ('U'):
```
Hex: 8207a200a2000101a1004155051883
```

### Status Updates (Type 41)

Periodic status broadcasts from Thread devices containing device state:

```cbor
[41, {
    0: {
        0: 0,
        2: <status_payload>   # Raw status bytes
    },
    2: [type, device_id],     # Device identifier
    3: {1: <extra_field>}
}]
```

These appear at ~6 second intervals and may contain mesh routing or device health information.

### Dim Hold (Type 2) — Raise/Lower Start

First of a raise/lower pair. Always paired with a DIM_STEP (type 3). Uses even sequence numbers.

```cbor
[2, {
    0: {
        0: <device_id>,  # 4 bytes: [preset_hi, preset_lo, 0xEF, 0x20]
        1: <action>      # 3 = raise/lower action
    },
    5: <sequence>         # Even number
}]
```

### Dim Step (Type 3) — Raise/Lower Step

Second of a raise/lower pair. Uses odd sequence numbers (DIM_HOLD seq + 1). Contains a step value (180-250 observed).

```cbor
[3, {
    0: {
        0: <device_id>,  # Same 4-byte format as DIM_HOLD
        1: <action>,     # 3 = raise/lower action
        2: <step_value>  # Step size/timing (180-250 observed)
    },
    5: <sequence>         # Odd number (hold_seq + 1)
}]
```

### Device Report (Type 27) — State Broadcast

Devices broadcast their state after executing commands. No sequence number. Triggered by LEVEL_CONTROL, BUTTON_PRESS, or SCENE_RECALL.

```cbor
[27, {
    0: {
        <key>: <value>,  # Device-specific state data
        ...
    },
    2: [<device_type>, <device_serial>],  # e.g., [1, 100000003]
    3: {1: <group_id>}   # Scene/group that triggered the report
}]
```

**Device serials** match LEAP database serial numbers, allowing cross-referencing with device names.

### Scene Recall (Type 36)

Recalls a stored scene/group, triggering all member devices to execute and broadcast DEVICE_REPORTs.

```cbor
[36, {
    0: {0: [1,133,135,140,138,16,142]},  # Recall/program vector (7 bytes observed in transfer captures)
    1: [0],                         # Targets (0 = all members)
    3: {0: <scene_id>, 1: <scene_family_id>, 2: [5, 60]}, # Scene ID + related family/group ID + params
    5: <sequence>
}]
```

Older runtime notes simplified `body[0][0]` to `[4]`, but the included transfer captures show a stable 7-byte vector instead. Treat it as a packed recall/program descriptor until more captures prove a shorter canonical form.

### Component Command (Type 40) — Shade/Fan Control

Controls shades, fans, and other non-dimmer components.

```cbor
[40, {
    0: {0: 0},                          # Command
    1: [<targets>],                      # Target devices
    3: {0: <group_id>, 2: [10, 4800]},   # Group + params [component_type, value]
    5: <sequence>
}]
```

**Params**: `[10, 4800]` observed for shade commands. Component type 10 may indicate shade position.

### Sample ON/OFF Traffic

| Time | Seq | Type | Level | Zone | Description |
|------|-----|------|-------|------|-------------|
| 8.4s | 91 | 65535 | - | - | Presence broadcast |
| 24.3s | 92 | 0 | 0xFEFF | 961 | Turn ON |
| 29.3s | 93 | 0 | 0x0000 | 961 | Turn OFF |
| 33.2s | 94 | 0 | 0xFEFF | 961 | Turn ON |
| 37.1s | 95 | 0 | 0x0000 | 961 | Turn OFF |

Note: Commands are broadcast multiple times across the Thread mesh for reliability.

### Zone ID vs Hardware ID

The `zone_id` in CCX messages (e.g., 961) is an **internal Lutron index**, not the hardware serial number. The hardware ID (e.g., `0631acd7`) is stored in the Lutron database `LinkNode` table and maps to the zone ID.

### Wireshark Filter for Lutron Traffic

```
udp.port == 9190
```

## LEAP API

The LEAP API on port 8081 provides device enumeration, preset mappings, and RF credentials. See [ra3-system.md](ra3-system.md) for connection details, endpoints, and certificate setup.

Key for CCX: `npm run leap:dump -- --config` generates preset mappings for `ccx/config.ts`.

## TypeScript Decoder & Tools

The CCX tooling lives in `ccx/` (decoder library) and `tools/` (CLI tools).

### Decode a message

```typescript
import { decodeAndParse, formatMessage } from "./ccx/decoder";

const msg = decodeAndParse("8200a300a20019feff03010182101903c105185c");
console.log(formatMessage(msg));
// LEVEL_CONTROL(FULL_ON, level=0xfeff, zone=961, seq=92)
```

### CCX Sniffer (tshark-based capture pipeline)

```bash
# Process a pcapng capture file
npm run ccx:sniff -- --file captures/ccx-onoff.pcapng

# Live capture from nRF 802.15.4 sniffer
npm run ccx:sniff -- --live --channel 25

# JSON output for scripting
npm run ccx:sniff -- --file capture.pcapng --json

# Relay decoded packets to backend
npm run ccx:sniff -- --live --relay
```

The sniffer uses tshark for Thread decryption (802.15.4 → 6LoWPAN → IPv6 → UDP),
then decodes the Lutron CBOR application layer in TypeScript.

**Requirements:**
- tshark (Wireshark CLI) installed
- For live capture: nRF 802.15.4 sniffer extcap plugin installed in Wireshark
- Thread master key configured in `ccx/config.ts` or via `--key` flag

### CCX Analyzer (reverse engineering helper)

```bash
# Decode a single CBOR message with annotated dump
npm run ccx:analyze -- decode "8200a300a20019feff03010182101903c105185c"

# Catalog all message types in a capture
npm run ccx:analyze -- types --file captures/ccx-onoff.pcapng

# Analyze field patterns for a specific type
npm run ccx:analyze -- fields LEVEL_CONTROL --file captures/ccx-onoff.pcapng

# Timeline with timing deltas
npm run ccx:analyze -- timeline --file captures/ccx-onoff.pcapng

# List unique devices
npm run ccx:analyze -- devices --file captures/ccx-onoff.pcapng

# Find variable fields across same-type messages
npm run ccx:analyze -- compare LEVEL_CONTROL --file captures/ccx-onoff.pcapng

# Find unknown/unrecognized message types
npm run ccx:analyze -- unknown --file captures/ccx-onoff.pcapng

# Summary statistics
npm run ccx:analyze -- stats --file captures/ccx-onoff.pcapng
```

### LEAP Dump (system enumeration)

Enumerates all devices, buttons, presets, and zones from the LEAP API. Re-run this when
the system configuration changes to refresh the CCX preset mapping.

```bash
# Human-readable output
npm run leap:dump

# JSON output (for scripting / external tools)
npm run leap:dump -- --json

# TypeScript config fragments (paste into ccx/config.ts)
npm run leap:dump -- --config

# Custom host
npm run leap:dump -- --host <ra3-ip>
```

Output includes:
- **33 zones** with area names and control types
- **44 devices** with serial numbers, types, and control station locations
- **101 preset mappings** linking LEAP preset IDs to button names and devices
- CCX device_id encoding for every button in the system

### Configuration

Edit `ccx/config.ts` to set your Thread network parameters:
- Channel, PAN ID, Extended PAN ID
- Thread master key
- Known device IPv6 addresses and zone names
- Known presets (generated by `leap-dump --config`)

## Button → Preset Encoding (CRACKED)

The CCX `device_id` in BUTTON_PRESS, DIM_HOLD, and DIM_STEP messages encodes the
LEAP Preset ID:

```
device_id[0:1] = LEAP Preset ID (big-endian uint16)
device_id[2:3] = 0xEF20 (constant)
```

### LEAP Button Hierarchy

```
Device (e.g., SunnataHybridKeypad)
└── ButtonGroup
    └── Button (engraving text)
        └── ProgrammingModel
            ├── AdvancedToggleProgrammingModel
            │   ├── PrimaryPreset   (sent on OFF/recall press)
            │   └── SecondaryPreset (sent on ON/activate press)
            ├── SingleActionProgrammingModel
            │   └── Preset (sent on every press)
            ├── SingleSceneRaiseProgrammingModel
            │   └── Preset (sent on raise)
            └── SingleSceneLowerProgrammingModel
                └── Preset (sent on lower)
```

### Example Mapping (Office Doorway Keypad)

| Button | Action | Preset ID | CCX Bytes | PM Type |
|--------|--------|-----------|-----------|---------|
| Office | ON (secondary) | 1093 | `0445 EF20` | AdvancedToggle |
| Office | OFF (primary) | 939 | `03AB EF20` | AdvancedToggle |
| Lamps | ON (secondary) | 1223 | `04C7 EF20` | AdvancedToggle |
| Lamps | OFF (primary) | 943 | `03AF EF20` | AdvancedToggle |
| Relax | ON (secondary) | 2011 | `07DB EF20` | AdvancedToggle |
| Relax | OFF (primary) | 947 | `03B3 EF20` | AdvancedToggle |
| Lower | press | 984 | `03D8 EF20` | SingleSceneLower |
| Raise | press | 987 | `03DB EF20` | SingleSceneRaise |

### Shared Scenes

Some presets are shared across multiple devices. For example, preset 2507 ("Relax" primary)
appears on 5 different keypads across the house. When any of these buttons is pressed,
the same preset ID is sent over CCX.

## nRF 802.15.4 Sniffer Setup

1. Download the nRF Sniffer for 802.15.4 from [Nordic's site](https://www.nordicsemi.com/Products/Development-tools/nRF-Sniffer-for-802154)
2. Flash the sniffer firmware onto an nRF52840 dongle
3. Install the extcap plugin into Wireshark:
   ```bash
   cp -r nrf_sniffer_for_802154/extcap/* /Applications/Wireshark.app/Contents/MacOS/extcap/
   pip3 install pyserial
   ```
4. Verify: `tshark -D` should list the nRF sniffer interface

## Capture Files

| File | Contents |
|------|----------|
| `captures/ccx-activity.pcapng` | 67 LEVEL_CONTROL packets (ON/OFF zone 961) |
| `captures/ccx-full-exercise.pcapng` | 1212 decoded packets, all 8 active message types |
| `captures/ccx-button-mapping.pcapng` | Office keypad button press sequence (preset ID verification) |

## Known Zones (from LEAP database)

See `ccx/config.ts` for the full mapping (currently 33 zones, 101 presets, 44 devices).
Regenerate with `npm run leap:dump -- --config`.

## Remaining Unknowns

- **Type 34**: Observed from keypads, structure `{0: {0:7, 1:0}, 2: [1, serial]}` — possibly button activity acknowledgment
- **Type 34**: More likely local interaction/UI state than a generic ACK. In keypad captures, types `5`, `18`, and `8` bracket press/hold/release-like behavior.
- **COMPONENT_CMD params**: `[10, 4800]` meaning not yet determined (likely shade position)
- **SCENE_RECALL params**: `[5, 60]` meaning not yet determined, but current captures also carry a distinct recall vector and recurring `scene_family_id`
- **STATUS inner data**: Raw bytes not yet decoded, though `body[3][1]` appears to be a recurring scene/group-family identifier

## Programming Plane (`/cg/db` over CoAP)

CCX uses at least two application planes on Thread:

- Runtime/control plane: `UDP 9190` with CBOR messages (`ACK`, `SCENE_RECALL`, `COMPONENT_CMD`, `STATUS`, `PRESENCE`, etc.).
- Programming plane: `UDP 5683` (CoAP), with paths under `/cg/db/...` carrying CBOR payloads during transfer/pairing/programming.

In captures, device programming traffic is primarily on `5683`, not `9190`.

### Evidence (capture set)

- Capture: `/tmp/lutron-sniff/live/lutron-thread-ch25_00001_20260217235133.pcapng`
- Duration: ~500s, packets: 9594
- Ports seen:
  - `5683`: 3410 frames
  - `9190`: 1399 frames
  - `19788`: 553 frames (MLE/network control)
- Event markers: `/tmp/lutron-sniff/live/events.log`

### Observed programming transaction pattern

Per target device/session, we repeatedly see:

1. `DELETE /cg/db`
2. `PUT /cg/db/ct/c/*`
3. `POST /cg/db/mc/c/AAI`
4. `POST /cg/db/pr/c/AAI`
5. `2.02` / `2.04` responses

Top URI counts (same capture):

- `/cg/db/pr/c/AAI`: 1029 packets (request+response)
- `/cg/db/mc/c/AAI`: 203
- `/cg/db`: 56
- `/cg/db/ct/c/AAI`: 53
- plus many `/cg/db/ct/c/<token>` variants (`AAM`, `AFE`, `AFI`, `AFQ`, `AHA`, etc.)

### `ct` Bucket Token Encoding (confirmed)

`/cg/db/ct/c/<token>` uses a Base64URL token that decodes to a 2-byte bucket ID.

Examples:

- `AAC` -> `0x0007`
- `AAg` -> `0x0008`
- `AFE` -> `0x0051`
- `AFI` -> `0x0052`

Observed map in this capture:

- `AAA` -> `0x0000`
- `AAE` -> `0x0001`
- `AAI` -> `0x0002`
- `AAM` -> `0x0003`
- `AAQ` -> `0x0004`
- `AAU` -> `0x0005`
- `AAc` -> `0x0007`
- `AAg` -> `0x0008`
- `AAo` -> `0x000A`
- `ABI` -> `0x0012`
- `ABM` -> `0x0013`
- `AFE` -> `0x0051`
- `AFI` -> `0x0052`
- `AFM` -> `0x0053`
- `AFQ` -> `0x0054`
- `AFY` -> `0x0056`
- `AHA` -> `0x0070`
- `AIE` -> `0x0081`

### Likely meaning of names (inference)

These are hypotheses from traffic behavior and payload shape, not vendor-confirmed names.

- `db`:
  - Likely "database" (high confidence).
  - Evidence: frequent `DELETE /cg/db` before config/program writes.
- `pr`:
  - Preset records (confirmed).
  - Evidence: payload keys map to LEAP preset IDs; user validation confirms `pr` is preset.
- `mc`:
  - Likely "mapping/membership/index records" (medium confidence).
  - Evidence: compact 5-byte IDs ending in `ef`, used alongside `pr`.
- `ct`:
  - Likely "configuration/control table" writes (medium confidence).
  - Evidence: many setup-like writes across multiple named buckets before/with `pr` traffic.
- `c` path segment (`.../c/...`):
  - Likely "collection/class/channel" sub-namespace (low/medium confidence).
- `AAI`, `AAM`, `AFE`, etc.:
  - Likely table/bucket IDs (high confidence they are bucket IDs, low confidence on naming expansion).

### Payload findings

#### `/cg/db/pr/c/AAI` (CoAP `POST`, code `2`)

Payload decodes as CBOR map keyed by bytes ending in `ef20`, for example:

- Hex: `a1440dc3ef20821848a10000`
- Decoded form (semantic): `{ 0x0dc3ef20: [72, {0: 0}] }`

Observed value structure:

- `[72, {...}]` dominates (504/508 rows in analyzed capture).
- Inner map keys:
  - `0`: level-like value (`0`, `0x3DD2`, `0x7E36`, `0xBE9B`, `0xFEFF`, etc.)
  - `3`: fade time (confirmed)
  - `4`: delay time (confirmed)

The level ladder matches known CCX level encoding (`0xFEFF` full-on, quarter/half/three-quarter values, etc.).

In this capture:

- `pr` rows: 508
- unique `pr` keys: 126
- keys matching local LEAP presets dump: 72
- keys matching Designer `tblPreset.PresetID`: 76
- remaining keys not in `tblPreset`: 50

Current LEAP dump (`<project-root>/data/leap-<ra3-ip>.json`) contains:

- 33 zones
- 44 devices
- 101 presets

> **Discovery:** DB enumeration on the active Designer LocalDB (`Project`) shows those 50 non-`tblPreset` keys map to scene/assignment records:
>
> - `tblScene.SceneID` (all 50 IDs hit)
> - `tblPresetAssignment.ParentID` (all 50 IDs hit)
> - `tblAssignmentCommandParameter.ParentId` (all 50 IDs hit)
> - `AllPresetsAndSceneDefinition.scene_id` with `preset_id = NULL` for these rows
>
> So the `pr` key space in this capture is mixed: Preset IDs (`tblPreset.PresetID`) and Scene IDs (`tblScene.SceneID`) used as assignment parents.

#### `/cg/db/mc/c/AAI` (CoAP `POST`, code `2`)

Payload shape is usually a single CBOR byte-string item:

- Example: `8145000007c9ef` -> `[0x000007c9ef]`

IDs are commonly 5 bytes ending with `ef`.

#### `/cg/db/ct/c/*` (CoAP `PUT`, code `3`)

Payloads are short CBOR arrays, often opcode-like first element + parameter map:

- `[57, {"1":1}]`
- `[9, {"1":65279, "7":229, "10":3}]`
- `[107, {"0":37}]`
- `[108, {"4":153, "5":20}]`
- `[3, {"2":58685, "3":2638, "8":5}]`
- `[92, {}]`, `[94, {}]`

Exact semantics are still unresolved, but these appear to establish supporting tables/config used by `mc`/`pr` programming rows.

> **Discovery:** `AHA` (`0x0070`) controls keypad status LED levels.

For office keypad programming captures, this write is confirmed:

- Path: `/cg/db/ct/c/AHA`
- CoAP: `PUT` (`0.03`)
- Payload CBOR form: `[108, {4: <activated_level>, 5: <deactivated_level>}]`
- Level range: `0..255` for both values

Observed values:

- High: `82186ca20418e5051819` -> `[108, {4:229, 5:25}]`
- Low: `82186ca2041833050c` -> `[108, {4:51, 5:12}]`

### Addressing prerequisite for successful injection

To reproduce writes from STM32+nRF injection:

- Use mesh-local RLOC addresses, not the `::...` display addresses shown in Wireshark decode.
- Format used successfully:
  - Source (injector): `<src-ipv6>`
  - Office keypad target: `<dst-ipv6>`

Example commands:

```bash
# HIGH
bun run tools/ccx-coap-send.ts aha \
  --stm32-host <nucleo-ip> \
  --dst <dst-ipv6> \
  --src <src-ipv6> \
  --k4 229 --k5 25 \
  --repeat 3 --interval 150 --timeout-ms 9000

# LOW
bun run tools/ccx-coap-send.ts aha \
  --stm32-host <nucleo-ip> \
  --dst <dst-ipv6> \
  --src <src-ipv6> \
  --k4 51 --k5 12 \
  --repeat 3 --interval 150 --timeout-ms 9000
```

> **Discovery:** High/low trim uses `AAI` (`0x0002`) opcode `3`.

From programming capture decode (`coap.code=3`, path `/cg/db/ct/c/AAI`), trim-like writes are:

- Payload shape: `[3, {2: <high_raw>, 3: <low_raw>, 8: <profile>}]`
- Common values seen:
  - `[3, {2:58685, 3:2638, 8:5}]` (`58685` ~= `89.9%`, `2638` ~= `4.0%`)
  - `[3, {2:58685, 8:5}]` (devices without key `3` in this capture)
  - Other high values: `64620` (`~99.0%`), `45498` (`~69.7%`), `35607` (`~54.5%`)

Cross-check with Designer LocalDB (`Project`, `LOCALDB#A2D4DCDA`):

- `tblSwitchLeg` contains high/low trim percentages with distribution:
  - `90/5` (most common), plus `99/1`, `70/2`, `55/6`, etc.
- These percentage cohorts match the observed `AAI` raw cohorts:
  - `90%` -> `58685`
  - `99%` -> `64620`
  - `70%` -> `45498`
  - `55%` -> `35607`

Use the trim sender:

```bash
# Example: write high/low trim raw values to AAI
bun run tools/ccx-coap-send.ts trim \
  --stm32-host <nucleo-ip> \
  --dst <dst-ipv6> \
  --src <src-ipv6> \
  --high16 58685 --low16 2638 --k8 5 \
  --repeat 3 --interval 150 --timeout-ms 9000
```

Notes:

- `k8` appears profile/class metadata (`5` most common for dimmer-like records in this capture).
- UI percent -> wire raw conversion is not yet fully modeled across all load profiles; use capture-derived raw values for exact replay.

> **Discovery:** `0x0051..0x0054` carry LED link indices.

For keypad sessions, `AFE/AFI/AFM/AFQ` (`0x0051..0x0054`) carry values matching Designer `tblLed.LedNumberOnLink`.

Office keypad session (`dst ::3c2e:f5ff:fef9:73f9`, `ControlStationDeviceID=926`) writes:

- `AFE (0x0051)` payload `[107, {0: 3}]`
- `AFI (0x0052)` payload `[107, {0: 4}]`
- `AFM (0x0053)` payload `[107, {0: 5}]`

Designer DB for `ParentDeviceID=926` has `LedNumberOnLink` = `3,4,5`.

### Current boundary: no per-LED brightness payload identified (RA3 captures)

Across observed RA3 programming sessions, keypad LED brightness changes appear as global device-level writes on:

- `/cg/db/ct/c/AHA` with payload `[108, {4:<on-level>, 5:<off-level>}]`

We do **not** currently see a distinct payload carrying independent brightness values per individual LED. The likely split is:

- Brightness levels: device-wide (`AHA`)
- Per-LED behavior/state mapping: programming model + LED link assignments (`AFE/AFI/AFM/AFQ`, `tblProgrammingModel`, `tblLed`)

Relevant Designer DB columns already identified from enumeration:

- `tblProgrammingModel.LedLogic`
- `tblProgrammingModel.UseReverseLedLogic`
- `tblProgrammingModel.ReferencePresetIDForLed`
- `AllPresetsAndSceneDefinition.led_logic_type`

### How this maps to user-observed flow

- Designer transfer to processor (LAN-side) happens before Thread programming bursts.
- After processor comes back online, Thread programming appears as large `5683` `/cg/db/*` bursts.
- `9190` remains active for runtime/control state traffic, not the main programming record stream.

### Programming plane open questions

- Exact expansion of `cg`, `ct`, `mc`, and token buckets (`AAI`, `AAM`, ...).
- Which `ct` opcodes map to which internal objects.
- Exact runtime decision logic for choosing `pr` key as preset ID vs scene ID.

### Quick extraction commands

```bash
FILE=/tmp/lutron-sniff/live/lutron-thread-ch25_00001_20260217235133.pcapng

# CoAP programming paths
tshark -r "$FILE" -d udp.port==5683,coap \
  -Y 'udp.port==5683 && coap.opt.uri_path_recon' \
  -T fields -e coap.code -e coap.opt.uri_path_recon | sort | uniq -c | sort -nr

# pr payloads (program records)
tshark -r "$FILE" -d udp.port==5683,coap \
  -Y 'coap.opt.uri_path_recon=="/cg/db/pr/c/AAI" && coap.code==2 && data' \
  -T fields -e frame.time_relative -e data

# runtime CCX plane
tshark -r "$FILE" -Y 'udp.port==9190 && data' \
  -T fields -e frame.time_relative -e ipv6.src -e ipv6.dst -e data
```

### Full-transfer diff workflow (when there are no discrete events)

When Designer always re-transfers the full file, compare two captures (`before` vs `after`) and filter to the target device:

```bash
bun run tools/ccx-program-diff.ts \
  --base /tmp/lutron-sniff/live/before.pcapng \
  --new /tmp/lutron-sniff/live/after.pcapng \
  --dst ::3c2e:f5ff:fef9:73f9
```

This highlights only changed request signatures (`dst + method + path + payload`) and decodes known records (`AHA`, `AAI`, `AF*`).

## Discovery Notes

> **Discovery (2026-02-13): Thread Network Injection (ACHIEVED)**
>
> nRF52840 dongle can JOIN the Lutron Thread network and SEND commands. No pairing/commissioning needed — just network key + channel + PAN ID + extended PAN ID. Devices accept commands from our dongle without additional auth. Two modes: RCP (USB dongle + ot-daemon) and NCP (soldered to STM32 via UART). CCA threshold -45 dBm is REQUIRED — default ~-75 dBm causes 100% TX failure (TxErrCca).

> **Discovery (2026-02-13): Fade & Delay Control (CONFIRMED)**
>
> - Command key 3 = fade time in quarter-seconds (`key3 = seconds * 4`)
> - Command key 4 = delay time in quarter-seconds (`key4 = seconds * 4`)
> - Default fade = `1` (0.25s, instant). Delay omitted = no delay.
> - Full LEVEL_CONTROL: `[0, { 0: {0: level, 3: fade, 4: delay}, 1: [16, zoneId], 5: seq }]`
> - `tools/ccx-send.ts --fade <seconds> --delay <seconds>`

> **Discovery (2026-03-05): Thread Frame Decryption (RESOLVED)**
>
> - Key derivation: `HMAC-SHA256(master_key, seq_BE || "Thread")` — the "Thread" suffix is critical!
> - Bun does NOT support `aes-128-ccm` — must use Node.js
> - Dimmer EUI-64: `22:0e:fb:79:b4:ce:f7:6f` → 0x6c06 (serial 0x0451A7A0, zone 3663)
> - DEVICE_REPORT: `[27, {0: {0:1, 1:<level16>, 2:3}, 2: [1, serial]}]`
> - Dimmer sends unicast to processor — sniff directly, processor does NOT re-multicast
> - LEAP constructor: `new LeapConnection({ host, certName })` (object, not positional args)
> - See `memory/ccx-thread-decryption.md` for full details

> **Discovery (2026-03-06): CoAP Programming (RESOLVED)**
>
> - Send to device PRIMARY ML-EID (random IID, discoverable via `ping ff03::1`)
> - Path `/cg/db/ct/c/AHA` works, `/cg/db/pr/c/0070` does NOT (4.04)
> - Device secondary ML-EID (EUI-64, `ff:fe` pattern, stored in Designer DB) is NOT reachable from nRF dongle — Thread address resolution doesn't know about them
> - AHA LED brightness: `[108, {4: <active_level>, 5: <inactive_level>}]` (0-255)
> - 13 keypads identified and mapped — see `docs/reference/ccx-device-map.md`
> - Skills: `/nrf-ot` (flash RCP, join Thread), `/nrf-sniffer` (flash sniffer, capture)
> - nRF dongle DFU: press reset → LED pulses red → `nrfutil nrf5sdk-tools dfu usb-serial`
> - RCP firmware: `~/lutron-tools/src/ot-nrf528xx/build/nrf52840-usb/bin/ot-rcp`
> - Sniffer firmware: `~/Downloads/nRF-Sniffer-for-802.15.4/nrf802154_sniffer_nrf52840dongle_dfu.zip`

> **Discovery (2026-03-06): NCP TX (RESOLVED)**
>
> - NCP `Ip6::SendRaw()` does NOT compute UDP checksums for STREAM_NET packets
> - IPv6 mandates valid UDP checksum — devices silently drop checksum=0 packets
> - Fix: parse mesh-local addr from IPv6 address table, set as src, compute checksum ourselves
> - CCA threshold must be set BEFORE `ifconfig up` in `thread_join()`
> - NCP LAST_STATUS=0 only means "accepted into queue", NOT "transmitted OTA"
> - 7 retransmits at 80ms, on/off/level all confirmed working

## Thread Network Injection (nRF52840 RCP)

### Overview (ACHIEVED 2026-02-13)

An nRF52840 USB dongle can join the Lutron RA3 Thread (CCX) network and send
arbitrary LEVEL_CONTROL commands. Lights respond immediately. No pairing or
commissioning needed — just the network credentials from the LinkNetwork DB table.

### Architecture: RCP (NOT NCP)

- **NCP + wpantund is DEPRECATED** — do not use
- **RCP (Radio Co-Processor)** is the correct approach:
  - nRF52840 runs minimal radio firmware (ot-rcp)
  - Mac runs `ot-daemon` (full OpenThread stack)
  - `ot-ctl` is the CLI controller
- This is better for scripting — everything runs on the Mac

### Hardware

- Nordic nRF52840 USB Dongle (PCA10059), ~$15
- Has built-in USB DFU bootloader (press RESET button to enter)

### Build & Flash (one-time setup)

#### Prerequisites
```bash
brew install --cask gcc-arm-embedded   # NOT brew formula — needs nano.specs
brew install cmake ninja
# nrfutil from nordicsemi.com + `nrfutil install nrf5sdk-tools`
```

**CRITICAL**: The Homebrew `arm-none-eabi-gcc` formula is MISSING `nano.specs`.
Must use `brew install --cask gcc-arm-embedded` which installs to
`/Applications/ArmGNUToolchain/`. Add to PATH before building:
```bash
export PATH="/Applications/ArmGNUToolchain/15.2.rel1/arm-none-eabi/bin:$PATH"
```

#### Build RCP Firmware
```bash
cd lutron-tools/src
git clone --recursive https://github.com/openthread/ot-nrf528xx.git
cd ot-nrf528xx
# bootstrap will fail on brew tap conflict — that's OK, deps already installed
./script/build nrf52840 USB_trans -DOT_BOOTLOADER=USB
```

#### Create DFU Package & Flash
```bash
cd build/bin
arm-none-eabi-objcopy -O ihex ot-rcp ot-rcp.hex
nrfutil nrf5sdk-tools pkg generate \
    --hw-version 52 --sd-req=0x00 \
    --application ot-rcp.hex --application-version 1 \
    ot-rcp-dfu.zip

# Press RESET on dongle (side button, push toward USB) — red LED pulses
nrfutil nrf5sdk-tools dfu usb-serial \
    --package ot-rcp-dfu.zip \
    --port /dev/cu.usbmodemXXXX
```

#### Build ot-daemon + ot-ctl
Uses the OpenThread submodule already cloned inside ot-nrf528xx:
```bash
cd lutron-tools/src/ot-nrf528xx/openthread
./script/cmake-build posix -DOT_DAEMON=ON
```

Binaries at:
- `build/posix/src/posix/ot-daemon`
- `build/posix/src/posix/ot-ctl`

### Running

#### Terminal 1: Start daemon
```bash
sudo ./src/ot-nrf528xx/openthread/build/posix/src/posix/ot-daemon -v \
    'spinel+hdlc+uart:///dev/cu.usbmodemXXXX?uart-baudrate=460800'
```

#### Terminal 2: ot-ctl
```bash
sudo ./src/ot-nrf528xx/openthread/build/posix/src/posix/ot-ctl -I utun8
```
(Socket is at `/tmp/openthread-utun8.sock` — check `ls /tmp/openthread-*.sock`)

#### Join Lutron Network (enter one at a time)
```
factoryreset
ccathreshold -45
dataset networkkey <your-thread-master-key>
dataset channel 25
dataset panid 0xXXXX
dataset extpanid <your-thread-xpanid>
dataset commit active
ifconfig up
thread start
```

Wait ~10-30s, verify:
```
state          # should show "child" or "router"
ipaddr         # should show fd00:: addresses
counters mac   # TxErrCca should be 0, RxTotal > 0
```

#### Send Commands
```
udp open
udp send ff03::1 9190 -x 8200a300a20019feff03010182101903c105185c
```
(That's LEVEL_CONTROL ON for zone 961)

### Critical Gotchas

#### CCA Threshold (THE KEY BLOCKER)
- **`ccathreshold -45` is REQUIRED** — without it, ALL transmissions fail
- Default CCA threshold is too sensitive (~-75 dBm)
- 2.4 GHz WiFi background noise (~-67 dBm) triggers CCA on every TX attempt
- Symptoms: `TxErrCca` = `TxTotal`, `RxTotal: 0`, state stuck at `detached`
- Must set BEFORE `ifconfig up` / `thread start`

#### Network Name
- Lutron DB has NetworkName as EMPTY — don't set `dataset networkname` at all
- Setting a wrong name (e.g., "Lutron") doesn't seem to prevent joining
  but leaving it default is cleanest

#### Mesh-Local Prefix
- Lutron uses `fd00::/64` — OpenThread default is `fdde:ad00:beef::/64`
- We did NOT need to set it manually — it's learned from the network leader after joining
- `dataset meshlocalprefix fd00::/64` has parser issues — avoid

#### ifconfig down Kills Everything
- `ifconfig down` destroys the TUN interface, which kills `ot-daemon`
- Use `thread stop` instead if you need to stop Thread
- If daemon dies, must restart it in Terminal 1

#### Multicast Commands
- All Lutron CCX commands go to multicast `ff03::1` on UDP port 9190
- CBOR-encoded arrays: `[msg_type, body_map]`
- Devices respond without checking the source — no auth beyond network key

### Lutron Network Credentials (from LinkNetwork DB table)
- Channel: 25
- PAN ID: 0xXXXX
- Extended PAN ID: <your-thread-xpanid>
- Network Key: <your-thread-master-key>
- Network Name: (empty in DB)

## EUI-64 Byte Order in CCM* Nonce

> **Discovery:** IEEE 802.15.4 extended addresses (EUI-64) are stored LITTLE-ENDIAN in frames, but the CCM* nonce requires them in BIG-ENDIAN (canonical EUI-64) order. `parseFrame()` returns raw LE bytes from the frame — these MUST be reversed before passing to `buildNonce()` / `decryptMacFrame()`.
>
> **Why:** Wireshark/tshark hides this by reversing internally — `wpan.src64` is already in canonical BE form. When we process raw frames from the serial sniffer (bypassing tshark), we get LE bytes and must handle the conversion ourselves.
>
> **How to apply:** Any code that takes an extended address from a parsed 802.15.4 frame and uses it for CCM* decryption must reverse the 8 bytes first. The LEAP-derived EUI-64s (from `getAllDevices()`) are already in BE/canonical order and don't need reversal.

## Stream Source Address Limitation

> **Discovery:** The Nucleo's CCX stream framing (`StreamTxItem`) discards source IPv6 address before sending to TCP clients. Current frame: `[FLAGS:1][LEN:1][TS_MS:4][CBOR:N]` — no sender info.
>
> The firmware already extracts full source IPv6 (16 bytes) and RLOC16 (2 bytes) in `ccx_process_rx()` (ccx_task.cpp ~line 1252), uses them for peer table updates and UART logging, but `stream_send_ccx_packet()` only passes the CBOR payload.
>
> **Why:** This is why the sniffer (tshark) shows device names per packet but the Nucleo CLI doesn't — the CLI never receives who sent each message.
>
> **Fix plan:** Extend stream framing to include source RLOC16 (2 bytes, minimal) or full IPv6 (16 bytes). Requires:
> 1. Extend `StreamTxItem` struct in `stream.cpp` to carry source address
> 2. Update stream framing format (new version byte or extended FLAGS)
> 3. Update CLI `nucleo.ts` stream parser to extract and display source
> 4. Use `getDeviceName()` or peer table lookup for sender name resolution
>
> Most CCX traffic is multicast (LEVEL_CONTROL, BUTTON_PRESS, DIM, SCENE_RECALL, DEVICE_REPORT) so the Nucleo sees it all — it just can't show WHO sent it.
