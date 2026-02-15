# Nucleo Firmware — Migration & Feature Roadmap

Migrating from lutron-tools (ESP32 + Bun server) to STM32H723 as the primary
radio platform. The ESP32 was a prototype; the Nucleo has better SPI timing,
dual radios (CC1101 + nRF52840), Ethernet, and a real RTOS.

## Legend
- `[ ]` — Not started
- `[~]` — Partial / in progress
- `[x]` — Done

---

## 1. CCA TX Command Library

The ESP32 firmware has 35+ structured command services. The Nucleo currently
only supports raw hex TX (`tx <hex>`). Need structured command builders so
the shell and TCP API can send real CCA packets without hand-crafting hex.

- [x] Packet builder: construct CCA packets from type + fields (device ID, seq, button, level, etc.)
- [x] `tx button <device_id> <button> <press|release>` — button press/release
- [x] `tx level <device_id> <0-100> [fade_quarters]` — set dimmer level (bridge format)
- [x] `tx pico-level <device_id> <0-100>` — pico set level
- [x] `tx beacon <subnet> <duration_sec>` — bridge beacon for pairing
- [x] `tx state <device_id> <level>` — state report
- [x] `tx raise/lower <device_id>` — raise/lower dimmer (via `cca button <dev> raise/lower`)
- [x] `tx unpair <device_id> <zone_id>` — unpairing command
- [x] `tx save-fav <device_id>` — save favorite
- [x] Sequence number auto-management (auto-increment, group A/B alternation)

## 2. Pairing Engine

The ESP32 has full pairing flows for bridge, Vive, and Pico. This is the
most complex feature to migrate.

- [x] **Bridge pairing**: beacon → device discovery → 6-round handshake
  - [x] Beacon TX with configurable subnet + duration
  - [x] RX filter for pairing responses during beacon window
  - [x] Handshake state machine (challenge-response rounds)
  - [x] Device selection from discovered list
- [ ] **Vive pairing**: beacon burst → accept → zone assignment
  - [ ] Vive beacon burst TX
  - [ ] Accept command
  - [ ] Zone ID assignment
- [x] **Pico direct pairing (OWT)**: one-way TX, no handshake
  - [x] 5-button preset pairing
  - [x] 2-button on/off pairing
  - [x] 4-button raise/lower pairing
  - [x] Scene/custom preset assignment
  - [x] Configurable pairing duration + repeat count

## 3. Device Configuration Commands

- [x] `tx fade <device_id> <on_rate> <off_rate>` — fade rate config
- [x] `tx led <device_id> <mode 0-3>` — LED indicator mode
- [x] `tx trim-high <device_id> <value>` — high trim calibration
- [x] `tx trim-low <device_id> <value>` — low trim calibration
- [ ] `tx trim-save <device_id>` — save trim settings
- [x] `tx phase <device_id> <byte>` — phase control configuration
- [ ] Generic 53-byte config packet builder

## 4. TCP Stream Protocol v2

Current stream protocol is minimal binary. Need to expand to support
bidirectional structured commands (replacing ESP32's UDP JSON protocol).

- [x] Binary packet streaming (CCA + CCX, RX + TX echo)
- [x] Heartbeat (0xFF 0x00 every 5s)
- [x] CCA raw TX command (0x01)
- [x] CCX zone control command (0x02)
- [x] Structured CCA commands (opcodes 0x05–0x10) — button, level, beacon, unpair, LED, fade, trim, phase, pico-pair, bridge-pair
- [x] Pairing commands over TCP (pico-pair 0x0F, bridge-pair 0x10)
- [x] Device config commands over TCP (LED 0x0B, fade 0x0C, trim 0x0D, phase 0x0E)
- [x] Status query command (0x11 → 48-byte blob: stats, thread role, heap, clients)
- [x] Multi-client support (up to 4 concurrent TCP clients)
- [ ] Recording start/stop commands
- [ ] nRF DFU data streaming (opcodes 0x03-0x04, partially wired)

## 5. Host-Side Application

The Bun server + React UI from lutron-tools needs to talk to the Nucleo
over TCP instead of the ESP32 over UDP. Two approaches:

### Option A: Adapt existing lutron-tools server
- [ ] Replace UDP transport with TCP client to Nucleo port 9433
- [ ] Map existing API routes to new TCP command protocol
- [ ] Keep React UI mostly unchanged

### Option B: New lightweight CLI (`cli/nucleo.ts`)
- [x] TCP client for Nucleo stream (auto-reconnect, binary framing)
- [x] Interactive shell with all CCA/CCX commands
- [x] Live packet display with protocol decoding (`identifyPacket()`)
- [x] Status query with parsed 48-byte blob
- [x] Packet recording to CSV
- [ ] REST/SSE API for web UI
- [ ] Session replay
- [ ] Device database (SQLite or JSON)

### Shared (either option)
- [ ] Web UI packet viewer with real-time updates
- [ ] Control panels: buttons, levels, pairing, config
- [ ] Device database with names, IDs, zones
- [ ] LEAP integration for system enumeration
- [ ] Recording/playback of capture sessions

## 6. CCA RX Improvements

- [x] N81 decode with strict + tolerant fallback
- [x] CRC-16 validation
- [x] Type-peek optimization for variable-length packets
- [x] RSSI per packet
- [x] Deferred logging (no printf in RX hot path)
- [x] Double-read RXBYTES (silicon errata workaround)
- [x] Fast-path decoder (skip sync search when at bit 0)
- [x] Diagnostic counters (drops, CRC fails, N81 errors, overflows, runts)
- [ ] Per-device packet tracking (last seq seen, duplicate detection)
- [ ] Configurable RX filter (by device ID, type, or RSSI threshold)
- [ ] Quiet mode (suppress printf entirely, stream-only)

## 7. CCX (Thread) Enhancements

- [x] NCP join as router (channel 25, PAN 0x0000)
- [x] LEVEL_CONTROL TX (zone + level + fade)
- [x] SCENE_RECALL TX
- [x] RX decode (9 message types)
- [x] Deduplication ring buffer
- [ ] More TX message types: BUTTON_PRESS, DIM_HOLD, DIM_STEP
- [ ] Zone-to-device mapping (from LEAP database)
- [ ] Scene database (scene ID → name mapping)
- [ ] CCX device discovery (listen for PRESENCE messages, build device table)
- [ ] Master key rotation support

## 8. Persistent Storage

The Nucleo has no persistent config. Everything resets on reboot.

- [x] Use STM32H7 internal flash (last sector) for settings
- [~] Persist: known device IDs + names, pairing state, network config
- [ ] Or: rely on host-side database and query at boot via TCP

## 9. Shell Improvements

- [x] Line editing, history, cursor control
- [x] Async-safe printf
- [x] `status` command with full diagnostics
- [x] `clear` command
- [x] `config` / `save` commands — show/persist settings to flash
- [x] `cca` commands — button, level, pico-level, state, beacon, unpair, led, fade, trim, phase, save-fav, pair
- [x] `ccx` commands — on, off, level, scene
- [x] `ot` commands — OpenThread NCP query/control
- [x] `spinel` commands — raw Spinel property access
- [ ] `devices` command — list known devices (from pairing or RX history)
- [ ] `log <on|off>` — toggle verbose packet logging
- [ ] `filter <device_id|type|off>` — RX display filter
- [ ] `stats reset` — clear all counters
- [ ] Tab completion for commands

## 10. Reliability & Performance

- [x] Interrupt-driven USART2 RX (ring buffer + ISR)
- [x] Multi-byte SPI burst reads
- [x] Removed unnecessary delays in RX restart path
- [x] Watchdog timer (IWDG) for crash recovery
- [ ] SPI DMA for CC1101 FIFO reads (not recommended — see MEMORY.md)
- [x] UART DMA for shell TX (USART3 TX DMA)
- [ ] Stack overflow detection (FreeRTOS hooks)
- [ ] Error rate monitoring with auto-recovery (e.g., CC1101 re-init on sustained errors)

## 11. nRF52840 NCP Management

- [x] Spinel protocol (HDLC framing, property get/set/insert)
- [x] Thread join + role management
- [~] DFU over serial (MCUboot SMP — enters bootloader, upload incomplete)
- [ ] Complete DFU implementation (chunk upload, validation, confirm)
- [ ] NCP health monitoring (periodic heartbeat, auto-reset on timeout)
- [ ] NCP firmware version check at boot

## 12. Testing & Validation

- [ ] Packet encode/decode unit tests (host-side, cross-compiled)
- [ ] CRC calculation tests
- [ ] N81 codec round-trip tests
- [ ] Spinel framing tests
- [ ] CBOR encode/decode tests
- [ ] Soak test script: count packets over time, measure drop rate

---

## Priority Order

**Phase 1 — Functional parity for sniffing + basic control** (DONE)
1. ~~CCA TX command library (buttons + levels)~~
2. ~~Host app TCP adapter (connect lutron-tools UI to Nucleo)~~
3. Quiet mode / RX filter
4. CCX additional TX types

**Phase 2 — Pairing + configuration** (DONE)
5. ~~Pico direct pairing (simplest, one-way TX)~~
6. ~~Bridge pairing engine~~
7. ~~Device configuration commands~~
8. Vive pairing

**Phase 3 — Polish + reliability** (PARTIAL)
9. ~~Persistent storage (flash)~~
10. ~~Watchdog (IWDG)~~
11. DMA for SPI/UART
12. Complete NCP DFU
13. Testing suite

---

## 13. Codebase Cleanup — ESPHome Removal

The original prototype lived in `esphome/custom_components/cc1101_cca/`. The STM32
Nucleo is now the primary platform — more SPI bandwidth, dual radios, Ethernet,
FreeRTOS. ESPHome/ESP32 code is dead weight that creates confusion about which
definitions are authoritative.

- [x] Remove `esphome/` directory entirely (custom components, YAML configs)
- [x] Remove any ESP32-specific backend/server code that only spoke UDP to the ESP
- [x] Audit `backend/` for leftover ESP32 references and clean up or remove
- [x] Update README / top-level docs to reflect STM32-only architecture

## 14. Remove Frontend Web UI

The React frontend (`frontend/`) was built for the ESP32 prototype's UDP+JSON
protocol. It's a maintenance burden and out of sync with the Nucleo's binary TCP
stream. Better to invest in a robust CLI that an AI agent (or human) can drive,
then build a UI later on a solid foundation.

- [x] Remove `frontend/` directory
- [x] Remove any backend routes/endpoints that only served the React UI
- [x] Ensure `cli/nucleo.ts` covers all control and monitoring use cases
- [x] Document CLI as the primary interface in README

## 15. Deduplicate CCA Protocol Definitions

CCA packet types, field offsets, button codes, and action codes are defined in
multiple places across the codebase. Without codegen, these must be kept tightly
aligned by hand. Ideally there is one authoritative source file per language.

Current duplicates:
- `firmware/src/cca/cca_types.h` — C++ constants (packet types, buttons, actions, offsets)
- `protocol/cca.yaml` — YAML packet definitions (types, fields, offsets, formats)
- `protocol/generated/typescript/protocol.ts` — TS enums, PacketFields, ButtonNames
- `protocol/protocol-ui.ts` — TS display helpers (`identifyPacket`, `parseFieldValue`)

Goals:
- [x] Audit all four files for drift — button codes, type bytes, field offsets, action codes
- [x] Establish `protocol/cca.yaml` as the single source of truth for packet structure
- [x] Ensure `cca_types.h` constants match YAML exactly (add comments with YAML cross-refs)
- [x] Ensure `protocol.ts` PacketFields match YAML field definitions 1:1
- [x] Add a CI-friendly diff check or linting script that flags mismatches between YAML and generated TS
- [x] Consider a lightweight codegen script (Bun/TS) that reads `cca.yaml` and emits `protocol.ts`

## 16. Transport Architecture — TCP vs UDP vs USB

The current transport is TCP on port 9433. This works, but there are tradeoffs
worth evaluating before building more on top of it.

**Options:**

| | TCP (current) | UDP | USB CDC (VCP) |
|---|---|---|---|
| Latency | ~1ms LAN | ~0.5ms LAN | ~0.1ms direct |
| Reliability | Guaranteed delivery | Best-effort, can drop | Guaranteed (USB flow control) |
| Framing | Must handle stream reassembly | Datagram boundaries free | Stream, same as TCP |
| Multi-client | Yes (up to 4 currently) | Yes (broadcast/multicast easy) | Single host only |
| Remote access | Yes — any host on LAN/VPN | Yes | No — host must be physically connected |
| MCU complexity | lwIP netconn API, moderate | lwIP UDP, simpler | USB CDC, HAL-level |
| Host discovery | Need IP (DHCP or mDNS) | Can broadcast | Auto-enumerated by OS |
| Throughput | ~10 Mbit practical | ~10 Mbit practical | 12 Mbit (FS) or 480 Mbit (HS) |

**Considerations:**
- TCP is the right default for remote/LAN operation (Nucleo on a shelf, host anywhere)
- USB CDC could be a secondary channel for low-latency local dev/debug
  - STM32H723 has USB FS (OTG_FS on PA11/PA12) — currently unused
  - Would coexist with ST-LINK VCP (USART3) which is the shell
- UDP would simplify the MCU side (no connection state, no per-client tracking)
  but loses guaranteed delivery — bad for commands, fine for streaming RX packets
- Hybrid: TCP for commands + status, UDP multicast for RX packet firehose?
- mDNS/DNS-SD for zero-conf host discovery (`_nucleo._tcp.local`)

**Tasks:**
- [ ] Evaluate whether current TCP throughput is a bottleneck (profile during heavy RX)
- [ ] Consider mDNS for auto-discovery (lwIP has mdns module)
- [ ] Evaluate USB CDC as secondary transport for local low-latency use
- [ ] Consider UDP multicast for high-volume RX streaming (CCA packets are fire-and-forget)
- [ ] Document transport architecture decision and rationale

## 17. Device Exposure & MQTT Integration (ccax2mqtt)

Raw CCA/CCX packets are meaningless to a home automation system. We need a
semantic layer that translates packet streams into device state and actions,
then publishes over MQTT for Home Assistant (or any MQTT consumer). Think
zigbee2mqtt but for Lutron's proprietary radio protocols.

**Architecture:**

```
  CC1101 (CCA)  ──┐                                    ┌── MQTT ── Home Assistant
                   ├── STM32 ── TCP ── Host daemon ────┤
  nRF52840 (CCX) ─┘                                    └── MQTT ── other consumers
```

The host daemon is the intelligence layer. The STM32 stays dumb — it sniffs,
transmits, and streams. The host daemon:
1. Maintains a **device registry** (ID → name, type, zone, capabilities)
2. Tracks **device state** (on/off, level, last-seen, RSSI, battery for picos)
3. Translates RX packets into **state updates** (BTN_PRESS → "light turned on")
4. Translates MQTT commands into **TX packets** (HA "turn_on" → CCA button press)
5. Publishes HA MQTT discovery so devices auto-appear in Home Assistant

**Device model:**

```
Device {
  id: string            // CCA device ID (hex) or CCX zone ID
  name: string          // human-readable ("Kitchen Dimmer")
  type: enum            // dimmer, switch, pico, fan, shade, occupancy, ...
  protocol: cca | ccx   // which radio
  zone_id?: number      // bridge zone (CCA) or Thread group (CCX)
  state: {
    on: boolean
    level: number       // 0-100
    last_seen: timestamp
    rssi: number
  }
}
```

**MQTT topics (zigbee2mqtt-style):**

```
ccax2mqtt/bridge/state              → {"state": "online"}
ccax2mqtt/bridge/devices            → [{id, name, type, ...}]
ccax2mqtt/<device_name>/state       → {"state": "ON", "brightness": 178}
ccax2mqtt/<device_name>/set         ← {"state": "ON", "brightness": 255}
ccax2mqtt/<device_name>/availability → "online" / "offline"
homeassistant/light/<id>/config     → HA MQTT discovery payload
```

**Packet → state mapping (examples):**

| RX packet | Semantic event | MQTT publish |
|---|---|---|
| BTN_PRESS_A btn=ON dev=X | Device X turned on | `ccax2mqtt/X/state` → `{"state":"ON"}` |
| BTN_PRESS_A btn=OFF dev=X | Device X turned off | `ccax2mqtt/X/state` → `{"state":"OFF"}` |
| SET_LEVEL target=X level=75% | Device X level changed | `ccax2mqtt/X/state` → `{"brightness":191}` |
| STATE_REPORT dev=X level=50% | Device X reporting state | `ccax2mqtt/X/state` → `{"brightness":128}` |
| CCX LEVEL_CONTROL zone=Y level=FE | Zone Y turned on | `ccax2mqtt/Y/state` → `{"state":"ON"}` |
| PRESENCE dev=X | Device X heartbeat | Update last_seen, publish availability |

**MQTT command → TX mapping:**

| MQTT command | Action |
|---|---|
| `{"state":"ON"}` on dimmer | `cca button <id> on` |
| `{"state":"OFF"}` on dimmer | `cca button <id> off` |
| `{"brightness":191}` on dimmer | `cca level <zone> <id> 75` |
| `{"state":"ON"}` on CCX zone | `ccx on <zone>` |

**Tasks:**
- [ ] Design device registry schema (JSON file? SQLite?)
- [ ] Implement packet→state mapping for core CCA types (button, level, state report)
- [ ] Implement packet→state mapping for CCX types (level_control, scene_recall)
- [ ] MQTT client in host daemon (publish state, subscribe to /set)
- [ ] HA MQTT discovery (auto-register lights, switches, fans as entities)
- [ ] Device learning mode: sniff traffic, auto-discover devices by ID + infer type
- [ ] Configurable device names and zones (YAML config file or CLI command)
- [ ] Pico button → HA event (not a light, it's a remote — publish button events)
- [ ] Occupancy sensor support (map CCA occupancy packets to HA binary_sensor)
- [ ] Shade/fan support (different HA entity types, different command mappings)

---

## 18. Protocol Analysis & Refinement

Research and refinement of the CCA protocol based on field observations and hardware constraints.

- [x] **64-byte FIFO Optimization**: Investigate measuring and processing RX data in 64-byte chunks (matching the CC1101 FIFO). Explore splitting logic for cases where multiple 24-byte packets reside in the same FIFO burst.
- [~] **Ecosystem Tagging**: Implement an 'ecosystem' metadata field (Caseta, RA3, Vive, Homeworks) in the protocol definitions.
  - [x] Map ecosystem-specific device ID ranges and command behaviors in `cca.yaml`.
  - [ ] Document bridge logic that distinguishes between ecosystems (e.g., why a Caseta device is rejected by a RA3 hub).
- [ ] **ID Schema Clarification**:
  - [ ] Formally document Vive Hub ID as a standard 4-byte hardware ID (printed label).
  - [ ] Refine the mapping of Subnet/Zone IDs vs. Hardware IDs in `cca.yaml` and the decoder.
  - [ ] Investigate the 'last byte' of device IDs (e.g., `A1` vs `80`) to determine if it acts as a component/endpoint index.
- [ ] **Short Packet Handling**: Improve detection and decoding of <24 byte packets, specifically the 5-byte `0x0B` ACKs and their `seq ^ 0x26` integrity check.
