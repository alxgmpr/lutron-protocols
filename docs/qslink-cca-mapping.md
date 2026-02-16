# QS Link to CCA Field Mapping

This document maps the "magic bytes" in our CCA firmware code to their proper field names,
established by reverse engineering the 2009 ESN-QS (Energi Savr Node) firmware.

**QS Link** is a real inter-device protocol used on RS-485 wired networks in Lutron's
commercial systems (Homeworks QS, Grafik Eye QS, Quantum, etc.). It predates CCA by years.
**CCA** (Clear Connect Type A) is essentially QS Link adapted for 433 MHz RF instead of
RS-485 — same packet structure, same field definitions, different physical layer. The ESN-QS
is a wired-to-wireless bridge that speaks QS Link on its RS-485 port and CCA over the air,
which is how we can map one to the other so directly.

These field names have been unchanged since at least 2009.

See also: `docs/qslink-protocol.md` for the full QS Link protocol specification.

## Field Reference

### Proper Names for CCA Packet Bytes

These bytes appear across multiple CCA packet formats. Our firmware (`cca_commands.cpp`,
`cca_pairing.cpp`) previously used unnamed hex literals for all of them.

| CCA Byte | Value | Proper Name | QS Link Origin | Our Code Reference |
|----------|-------|-------------|----------------|-------------------|
| 6 | `0x21` | `proto_radio_tx` | Radio IC TX command register (addr 0x0288) | `cca_commands.cpp:228`, `cca_pairing.cpp:383` |
| 7 | varies | `format` | Payload length in bytes (format 0x0E = 14 bytes) | `cca_commands.cpp:229` |
| 8 | `0x00`/`0x03` | `flags` | 0x00=normal, 0x03=pico frame | `cca_commands.cpp:230,147` |
| 9-12 | device ID | `object_id` | Device serial number (32-bit big-endian) | `cca_commands.cpp:233-236` |
| 13 (fmt 0x0E) | `0xFE` | `addr_mode` | Component unicast addressing | `cca_commands.cpp:238` |
| 13 (fmt 0x0E) | `0xEF` | `addr_mode` | Group multicast addressing | (format 0x28 byte 25) |
| 13 (fmt 0x0E) | `0xFF` | `addr_mode` | Broadcast to all devices | beacon packets byte 9-13 |
| 14 (fmt 0x0E) | `0x40` | `cmd_class` | Level control (GoToLevel) | `cca_commands.cpp:239` |
| 14 (fmt 0x0E) | `0x42` | `cmd_class` | Dim control (raise/lower) | `cca_commands.cpp:160` |
| 14 (config) | `0x06` | `cmd_class_legacy` | Original 2009 dim/config class | `cca_pairing.cpp:428,460` |
| 15 (fmt 0x0E) | `0x02` | `cmd_type` | Set/Execute command | `cca_commands.cpp:240` |
| 15 (config) | `0x50` | `component_type` | Dimmer component | `cca_pairing.cpp:429,498` |
| 15 (scene cfg) | `0x40` | `component_type_scene` | Scene component | scene config packets |
| 15 (fmt 0x12) | `0x6E` | `entity_type` | Zone binding entity (unknown exact meaning) | `cca_pairing.cpp:567` |

### Pico Packet Fields (Format 0x0E, Byte Offsets Shifted)

Pico packets embed a second device ID and shift the command fields deeper:

| CCA Byte | Value | Proper Name | Notes |
|----------|-------|-------------|-------|
| 8 | `0x03` | `pico_frame` | Identifies this as a pico/button device frame |
| 12-15 | device ID | `object_id` (repeated) | Second copy of pico's device ID |
| 17 | `0x40`/`0x42` | `cmd_class` (embedded) | 0x40=scene/level, 0x42=dim control |
| 18 | `0x00`/`0x02` | `cmd_type` (embedded) | 0x00=hold, 0x02=step/execute |
| 19 | varies | `cmd_param` | Preset ID (0x20=top) or dim direction (0x01=raise, 0x00=lower) |

### Format 0x28 (Zone Assignment) Fields

Format 0x28 is special: format byte moves to position 6 (no protocol byte) because
the 40-byte payload needs the space.

| CCA Byte | Value | Proper Name | Notes |
|----------|-------|-------------|-------|
| 6 | `0x28` | `format` | At position 6, NOT 7 (exception) |
| 9 | `0x50`/`0x38` | `component_type` | 0x50=dimmer, 0x38=relay |
| 10 | `zone+0x23` | `zone_reference` | Zone ID with offset (non-critical) |
| 18 | `0xFE` | `addr_mode` | Component addressing |
| 19 | `0x06` | `cmd_class_legacy` | Original QS Link dim/config class |
| 20 | `0x40` | `cmd_class` | Level control |
| 25 | `0xEF` | `addr_mode_group` | Group addressing mode |

### Format 0x12 (Final Config) Fields

| CCA Byte | Value | Proper Name | Notes |
|----------|-------|-------------|-------|
| 14 | `0x06` | `cmd_class_legacy` | Original config class |
| 15 | `0x6E` | `entity_type` | Possibly "zone binding" entity |
| 24 | zone | `zone_id` | **THE** authoritative zone assignment byte |
| 25 | `0xEF` | `addr_mode_group` | Group addressing |

### Format 0x13 (Dimming Capability) Fields

| CCA Byte | Value | Proper Name | Notes |
|----------|-------|-------------|-------|
| 14 | `0x06` | `cmd_class_legacy` | Original config class (NOT modern 0x42) |
| 15 | `0x50` | `component_type` | Dimmer |
| 17 | `0x0D` | unknown | Config sub-parameter |
| 18 | `0x08` | unknown | Config sub-parameter |
| 19 | `0x02` | unknown | Config sub-parameter |
| 20 | `0x0F` | unknown | Config sub-parameter |
| 21 | `0x03` | unknown | Config sub-parameter |

### Format 0x14 (Function Mapping) Fields

| CCA Byte | Value | Proper Name | Notes |
|----------|-------|-------------|-------|
| 14 | `0x06` | `cmd_class_legacy` | Original config class |
| 15 | `0x50` | `component_type` | Dimmer |
| 19 | `0xFE` | `addr_mode`? | Or could be level high byte |
| 20 | `0xFF` | unknown | Possibly max level |
| 22 | `0x02` | `dimmer_capability` | Dimmer=0x02, relay=0x00 |

## Addressing Mode Values

| Value | Constant Name | Description | Where Used |
|-------|---------------|-------------|------------|
| `0xFE` | `ADDR_MODE_COMPONENT` | Unicast to a specific component/zone | Byte 13 in SET_LEVEL, byte 18 in fmt 0x28 |
| `0xEF` | `ADDR_MODE_GROUP` | Multicast to all components in a group | Byte 25 in fmt 0x28, byte 25 in fmt 0x12 |
| `0xFF` | `ADDR_MODE_BROADCAST` | Broadcast to all devices on the link | Beacon packets (bytes 9-13 = 0xFF) |

## Command Class Evolution (2009 → 2024)

The command class byte tells the device what kind of operation to perform.

| QS Link (2009) | Value | Modern CCA | Value | Status |
|----------------|-------|------------|-------|--------|
| Level control | `0x40` | Level control | `0x40` | **UNCHANGED** since 2009 |
| Dim control | `0x06` | Dim control | `0x42` | Runtime changed, but 0x06 persists in config/pairing packets |
| Button/PM | `0x05` | (embedded in pico structure) | — | Folded into pico frame type |
| Scene | `0x09` | (implicit in format) | — | May appear in fmt 0x28 byte 29 |
| Addressing | `0x08` | (implicit in packet type) | — | Folded into type byte 0xA0+ |
| Device control | `0x01` | (identify, mode) | — | Used in format 0x09 |
| Select/Query | `0x03` | (addressing) | — | Used in format 0x09 |

Key insight: **0x06 in config/pairing packets is NOT a mystery byte** — it's the original
2009 dim control command class, kept for backwards compatibility in the config path even though
runtime control moved to 0x42.

## Command Type Values

| Value | Constant Name | Meaning | Where Used |
|-------|---------------|---------|------------|
| `0x02` | `CMD_TYPE_EXECUTE` | Set/Execute (go to level) | Byte 15 in SET_LEVEL, byte 18 in pico |
| `0x00` | `CMD_TYPE_HOLD` | Hold/Start | Pico byte 18 for hold-start |
| `0x22` | `CMD_TYPE_IDENTIFY` | Flash LEDs / self-identify | Format 0x09 |
| `0x33` | `CMD_TYPE_CONFIG` | Device configuration | Config packets |
| `0x50` | `CMD_TYPE_RAISE_START` | Dim raise (legacy) | QS Link dim control |
| `0x63` | `CMD_TYPE_LOWER` | Dim lower (legacy) | QS Link dim control |
| `0x67` | `CMD_TYPE_STOP` | Dim stop (legacy) | QS Link dim control |
| `0xA3` | `CMD_TYPE_ADDR_ASSIGN` | Address programming | Format 0x0A |
| `0xA5` | `CMD_TYPE_ADDR_QUERY` | Address read | Format 0x0D |

## Format Byte = Payload Length (Confirmed)

The format byte at CCA byte 7 (or byte 6 for format 0x28) literally equals the number of
payload bytes following the header. This is confirmed by the QS Link radio TX path which
writes `[total_len][0x21][format_byte][payload]` where payload is exactly `format_byte` bytes.

| Format | Payload Size | Used For |
|--------|-------------|----------|
| `0x04` | 4 bytes | Button tap (press/release) |
| `0x09` | 9 bytes | Device control (identify, select) |
| `0x0A` | 10 bytes | Address assign |
| `0x0C` | 12 bytes | Beacon / dim stop |
| `0x0D` | 13 bytes | Extended addressing with secondary ID |
| `0x0E` | 14 bytes | GoToLevel, button extended |
| `0x12` | 18 bytes | Final config with zone |
| `0x13` | 19 bytes | Dimming capability config |
| `0x14` | 20 bytes | Function mapping |
| `0x15` | 21 bytes | Trim / phase config |
| `0x1A` | 26 bytes | Scene config |
| `0x1C` | 28 bytes | Fade config / broadcast reset |
| `0x28` | 40 bytes | Zone assignment (format at byte 6, no protocol byte) |

The format 0x28 exception: 40 bytes of payload is so large that the `proto_radio_tx` byte
(0x21) is omitted and the format byte moves from position 7 to position 6 to reclaim 1 byte.

## Component Type Values

| Value | Constant Name | Description | Where Used |
|-------|---------------|-------------|------------|
| `0x50` | `COMPONENT_TYPE_DIMMER` | Dimmer component/zone | Fmt 0x28:9, fmt 0x13:15, fmt 0x14:15 |
| `0x38` | `COMPONENT_TYPE_RELAY` | Relay/switch component | Fmt 0x28:9 for relay pairing |
| `0x40` | `COMPONENT_TYPE_SCENE` | Scene component | Scene config byte 15 |

## Hypotheses to Investigate

Based on QS Link protocol knowledge applied to CCA:

### 1. Broadcast Addressing (ADDR_MODE_BROADCAST = 0xFF)

**Hypothesis**: Setting byte 13 to `0xFF` (broadcast) in a SET_LEVEL packet should
command ALL devices on the network, without knowing their device IDs.

**Evidence**: QS Link explicitly defines 0xFF as broadcast mode. Our beacon packets
already use 0xFF at bytes 9-13 (the target ID position) and devices respond.

**Test**: Send a format 0x0E SET_LEVEL packet with `object_id = 0xFFFFFFFF` and
`addr_mode = 0xFF` instead of our usual `0xFE`.

**Risk**: Low — worst case it's ignored. Devices may require being paired to a specific
source, in which case broadcast only works from a known hub/bridge ID.

### 2. Group Addressing for Control (ADDR_MODE_GROUP = 0xEF)

**Hypothesis**: We can control multiple devices simultaneously using group addressing
(byte 13 = `0xEF`) if they share a group assignment from pairing.

**Evidence**: QS Link defines group GoToLevel as the same format 0x0E but with
`addr_mode = 0xEF` and component = `0x0000`. Format 0x28 zone assignment includes
`addr_mode_group = 0xEF` at byte 25, suggesting devices are assigned to groups during pairing.

**Test**: Send SET_LEVEL with `addr_mode = 0xEF` and see if paired devices respond.

### 3. New Command Classes We Haven't Tried

**Hypothesis**: Sending known QS Link command classes that differ from our usual 0x40/0x42
may trigger additional device behaviors.

| Class | QS Link Meaning | Worth Trying? |
|-------|-----------------|---------------|
| `0x01` | Device control (identify, mode) | **YES** — could trigger LED flash without pairing |
| `0x03` | Select/Query | **YES** — could query device state or component info |
| `0x05` | Button/PM events | Maybe — pico already handles this differently |
| `0x08` | Address assign | **YES** — could reassign devices to new zones |
| `0x09` | Scene activation | **YES** — could trigger stored scenes |

**Test**: Build format 0x09 (9-byte) packets with various command classes directed at
a known device ID.

### 4. Device Discovery via Format 0x0A (Address Assign)

**Hypothesis**: Format 0x0A with `cmd_type = 0xA5` (address query) can discover
devices on the network by requesting their address/component information.

**Evidence**: QS Link has `DEVICEREQUESTCOMPONENTPRESENT` (cmd 0x1F) and
`DEVICECOMPONENTINITIALIZE` (cmd 0x0F, with type 0x00=NEW/UNADDRESSED) which scan
for devices. The radio packet format for this is format 0x0A + format 0x09.

**Test**: Send format 0x09 with `cmd_class = 0x03` (select/query), `cmd_type = 0x02`
to a broadcast address and listen for responses.

### 5. Factory Reset via Format 0x1C Broadcast

**Hypothesis**: QS Link message type 0x06 is "broadcast reset" which sends format 0x1C
to address `0xFFFFFF` with parameter 5. This may factory-reset devices over CCA.

**Evidence**: The ESN firmware explicitly handles this as a separate message type from
normal format 0x1C (fade config). The address 0xFFFFFF + specific parameter = DFC
(Default Factory Config).

**Test**: **DO NOT TEST CASUALLY** — this could unpair all devices. Only test with a
sacrificial device isolated from the production system.

### 6. Component Self-Identify (Format 0x09 + 0x0A)

**Hypothesis**: Sending format 0x09 with `cmd_class = 0x01` (device control) and
`cmd_type = 0x22` (identify) to a device ID should make it flash its LED without
requiring any pairing.

**Evidence**: QS Link handler 0x30 (`DEVICEIDENTIFY`) builds exactly this packet.
Identify is a fundamental device function that should work regardless of pairing state.

**Test**: Build a format 0x09 packet with the known field values and target a known
device ID. Look for LED flash.

### 7. The 0x06 → 0x42 Migration Pattern

**Hypothesis**: Config/pairing packets use `cmd_class = 0x06` (legacy) because the
configuration path was never updated from the 2009 QS Link protocol, while the
runtime control path was updated to use `cmd_class = 0x42` for dim control.

**Evidence**: In our code, every config format (0x13, 0x14, 0x28, 0x12) uses 0x06
at the cmd_class position, while runtime dim packets use 0x42. This is NOT a different
protocol — it's the same field with legacy vs modern values.

**Implication**: This means we could potentially use modern command class values in
config packets too, OR use legacy values in runtime packets. Neither is tested.

## Unchanged Since 2009

These protocol elements are confirmed identical between QS Link (2009) and CCA (2024+):

- **Level encoding**: `percent * 0xFEFF / 100`
- **CRC-16 polynomial**: 0xCA0F
- **Sequence increment**: +6 per packet, wraps at 0x48
- **Padding**: 0xCC for extended packets
- **Protocol byte**: 0x21
- **Command class 0x40** = level control
- **Addressing modes**: 0xFE/0xEF/0xFF
- **Format byte** = payload length
- **Component types**: 0x50=dimmer, 0x38=relay

## Source

Field names and protocol structure derived from:
- ESN-QS firmware (`Energi Savr.app/FirmWare file for Demo.s19`) — ColdFire M68K, 2009
- Energi Savr macOS app (`Energi Savr.app`) — arm64, CommunicationFramework class model
- Cross-referencing with modern CCA captures from CC1101 and RTL-SDR

QS Link is a wired RS-485 protocol for Lutron commercial systems (Homeworks QS, Grafik Eye
QS, Quantum). CCA reuses the same packet encoding over 433 MHz RF. The ESN-QS bridges
both — QS Link on RS-485, CCA over the air — which is how we can directly map field names
from the wired protocol to our RF captures.
