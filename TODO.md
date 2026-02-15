# Nucleo Firmware — Feature Roadmap

STM32H723 is the primary radio platform with dual radios (CC1101 + nRF52840),
Ethernet, and FreeRTOS. ESP32 prototype and web UI have been removed.

## Legend
- `[ ]` — Not started
- `[~]` — Partial / in progress
- `[x]` — Done

---

## 1. CCA TX Command Library (DONE)

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

## 2. Pairing Engine (DONE)

- [x] **Bridge pairing**: beacon → device discovery → 6-round handshake
  - [x] Beacon TX with configurable subnet + duration
  - [x] RX filter for pairing responses during beacon window
  - [x] Handshake state machine (challenge-response rounds)
  - [x] Device selection from discovered list
- [x] **Vive pairing**: beacon burst → accept → zone assignment
  - [x] Vive beacon burst TX (B9, 9 packets, 90ms spacing)
  - [x] Accept command (BA) with auto-detect from B8 responses
  - [x] Zone ID assignment + config sequence
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
- [~] nRF DFU data streaming (opcodes 0x03-0x04, partially wired)

## 5. Host-Side CLI (`cli/nucleo.ts`)

- [x] TCP client for Nucleo stream (auto-reconnect, binary framing)
- [x] Interactive shell with all CCA/CCX commands
- [x] Live packet display with protocol decoding (`identifyPacket()`)
- [x] Status query with parsed 48-byte blob
- [x] Packet recording to CSV
- [x] Text passthrough to STM32 shell (opcode 0x20/0xFD)
- [ ] Session replay
- [ ] Device database (SQLite or JSON)

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

## 8. Persistent Storage (DONE)

- [x] Use STM32H7 internal flash (last sector) for settings
- [x] Persist: known device IDs, pairing state, Thread network config
- [ ] Host-side device database with names, zones, capabilities (see §17)

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

## 13. Codebase Cleanup (DONE)

- [x] Remove `esphome/` directory entirely
- [x] Remove `backend/` server (ESP32 UDP+SSE protocol)
- [x] Remove `web/` React frontend
- [x] Update CLAUDE.md and README to reflect STM32-only architecture

## 14. Deduplicate CCA Protocol Definitions (DONE)

- [x] `protocol/cca.yaml` is the single source of truth
- [x] `tools/codegen.ts` generates `protocol/generated/typescript/protocol.ts`
- [x] `cca_types.h` constants aligned with YAML
- [x] CI-friendly diff check for drift detection

## 15. Transport Architecture — TCP vs UDP vs USB

The current transport is TCP on port 9433. This works well for LAN operation.

| | TCP (current) | UDP | USB CDC (VCP) |
|---|---|---|---|
| Latency | ~1ms LAN | ~0.5ms LAN | ~0.1ms direct |
| Reliability | Guaranteed delivery | Best-effort | Guaranteed (USB flow control) |
| Multi-client | Yes (up to 4) | Yes (broadcast easy) | Single host only |
| Remote access | Yes — any host on LAN | Yes | No — physically connected |

**Tasks:**
- [ ] Evaluate whether current TCP throughput is a bottleneck (profile during heavy RX)
- [ ] Consider mDNS for auto-discovery (lwIP has mdns module)
- [ ] Evaluate USB CDC as secondary transport for local low-latency use

## 16. Device Exposure & MQTT Integration (ccax2mqtt)

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

## 17. Protocol Analysis & Refinement

Research and refinement of the CCA protocol based on field observations and hardware constraints.

- [x] **64-byte FIFO Optimization**: RX data processing in 64-byte chunks matching CC1101 FIFO.
- [~] **Ecosystem Tagging**: 'ecosystem' metadata field (Caseta, RA3, Vive, Homeworks) in protocol definitions.
  - [x] Map ecosystem-specific device ID ranges and command behaviors in `cca.yaml`.
  - [ ] Document bridge logic that distinguishes between ecosystems.
- [ ] **ID Schema Clarification**:
  - [ ] Formally document Vive Hub ID as a standard 4-byte hardware ID (printed label).
  - [ ] Refine the mapping of Subnet/Zone IDs vs. Hardware IDs in `cca.yaml` and the decoder.
  - [ ] Investigate the 'last byte' of device IDs (e.g., `A1` vs `80`) as component/endpoint index.
- [ ] **Short Packet Handling**: Improve detection and decoding of <24 byte packets, specifically the 5-byte `0x0B` ACKs and their `seq ^ 0x26` integrity check.

---

## Priority Order

**Phase 1 — Functional parity** (DONE)
1. ~~CCA TX command library~~
2. ~~Host CLI~~
3. ~~Pairing engine (bridge + Vive + pico)~~
4. ~~Device configuration commands~~

**Phase 2 — Infrastructure** (DONE)
5. ~~Persistent storage (flash)~~
6. ~~Watchdog (IWDG)~~
7. ~~Protocol codegen~~
8. ~~Codebase cleanup (remove ESP32/web)~~

**Phase 3 — Next up**
9. **ccax2mqtt** — highest impact; enables Home Assistant integration
10. CCX expansion (BUTTON_PRESS, DIM_HOLD, device discovery)
11. RX filter / quiet mode
12. Unit tests
13. NCP DFU completion
