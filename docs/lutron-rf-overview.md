# Lutron RF Transport Overview

Start here. This doc covers the three communication layers in Lutron lighting systems and how they relate to each other.

## Three Transport Layers

| Layer | Band | Protocol | Devices | Our Tools |
|-------|------|----------|---------|-----------|
| **CCA** (Clear Connect Type A) | 433 MHz FSK | Proprietary N81+CRC | Picos, dimmers, switches, sensors, hubs | ESP32/CC1101, RTL-SDR |
| **CCX** (Clear Connect Type X) | 2.4 GHz | Thread (802.15.4) | Smart dimmers, keypads, processors | nRF52840 sniffer, tshark |
| **LEAP** | IP/TLS | JSON over TCP | Processor API (read-only on port 8081) | `tools/leap-dump.ts`, pylutron-caseta |

All three carry the same logical commands. The telnet integration protocol documents them as abstract action numbers; CCA and CCX are the RF transports for those actions.

## OUTPUT vs DEVICE: The Fundamental Split

Every Lutron command falls into one of two categories:

- **OUTPUT** = zone/load control with level + fade + delay
  - CCA: bridge/Vive format 0x0E (8-byte payload, fade at byte 19)
  - CCX: type 0 LEVEL_CONTROL
  - Telnet: `#OUTPUT,<id>,1,<level>,<fade>,<delay>`

- **DEVICE** = component control (buttons, LEDs, sensors)
  - CCA: pico packets (5-byte payload, no fade field)
  - CCX: type 1 BUTTON_PRESS
  - Telnet: `#DEVICE,<id>,<component>,<action>`

This split explains the pico set-level slow fade problem: pico commands travel the DEVICE path, which has no fade field. The dimmer applies its default ramp rate (~1-2 min) instead of the commanded fade time. Fast fade requires the OUTPUT path (bridge or Vive).

## Addressing Models

### CCA (433 MHz)

```
Device ID: [Zone][SubnetLo][SubnetHi][Endpoint]  (4 bytes, big-endian on label)
```

- **Subnet** (2 bytes) identifies which processor/bridge owns the device
- **Zone** (1 byte) is the device number within the subnet
- **Endpoint** (1 byte) indicates target type: 0x80=unicast, 0x8F=broadcast
- Factory ID vs Load ID vs RF TX ID: `RF_TX = Load_ID XOR 0x20000008`
- Arbitrary subnets work — no validation by devices

### Vive (CCA variant)

```
Hub ID (4 bytes) + Zone ID (1 byte)
```

- Hub ID identifies the Vive hub, zone ID identifies the room
- Zone byte appears at different offsets depending on format (byte 12 for commands, byte 24 for config)
- Constant `0xEF` always follows the zone byte

### CCX (Thread)

```
IPv6 address + zone_id (internal Lutron index, not hardware ID)
```

- Thread mesh with `fd00::/64` prefix
- Zone IDs (e.g., 961) are internal Lutron indices mapped in the LEAP database
- Device serials match LEAP database, enabling cross-referencing

### LEAP (IP)

```
Area → Zone (for loads)
Area → ControlStation → Device → ButtonGroup → Button → Preset (for controls)
```

- Hierarchical REST-like JSON API on port 8081 (read-only, mutual TLS)
- Preset IDs appear directly in CCX packets: `device_id[0:1] = LEAP Preset ID (BE uint16)`

## Level Encoding

Consistent across all CCA sources:

| Level | CCA (uint16) | CCX | Formula |
|-------|-------------|-----|---------|
| OFF | 0x0000 | 0x0000 | 0 |
| 25% | 0x3FBF | - | `percent * 0xFEFF / 100` |
| 50% | 0x7F7F | 0x8000 | |
| 100% | 0xFEFF | 0xFEFF | |

- CCA: `level16 = percent * 0xFEFF / 100` (0xFFFF is reserved/invalid)
- CCX: `level = percent * 655.35` (0xFEFF = "full on")
- Quarter-second fade/delay resolution is universal across all systems: `value = seconds * 4`

## Key Breakthroughs

1. **LEAP API exposes everything**: CCA subnet address, RF channel, Thread network master key, device serials, preset mappings — single source of truth (port 8081, read-only)

2. **CCX button encoding cracked**: `device_id[0:1]` = LEAP Preset ID as big-endian uint16, `device_id[2:3]` = constant `0xEF20`

3. **Arbitrary subnets work**: No subnet validation — any 16-bit value is accepted by devices during pairing

4. **Dimmers accept arbitrary levels from any source**: Pico, Vive, and bridge can all set arbitrary 0-100% levels. Only fade control varies by source path.

5. **Fade time byte discovered**: Format 0x0E byte 19 = fade in quarter-seconds. Shared between Vive and Caseta bridge commands.

6. **OUTPUT vs DEVICE explains pico slow fade**: Pico packets use the DEVICE path (5-byte payload, no fade field). Fast fade requires OUTPUT path (bridge/Vive, 8-byte payload).

## Quick Reference

| I want to... | Use this |
|--------------|----------|
| Control a dimmer with fast fade | Bridge `send_bridge_level()` or Vive `send_vive_level()` — OUTPUT path |
| Control a dimmer without bridge | Pico `send_pico_level()` — works but slow fade (~1-2 min) |
| Sniff CCA packets | ESP32/CC1101 for 24-byte, RTL-SDR for 53-byte config packets |
| Sniff CCX packets | nRF52840 + tshark with Thread master key |
| Enumerate system | `npm run leap:dump` (LEAP API, needs certs) |
| Decode CCA packet | `npm run cca -- decode "88 0C..."` |
| Decode CCX message | `npm run ccx:analyze -- decode "<hex>"` |
| Pair a device (CCA) | Vive: `start_vive_pairing()`, Bridge: `start_bridge_pairing()` |
| Configure device LED/fade/trim | `POST /api/config/{led,fade,trim}` — uses 53-byte config packets |

## Related Docs

- **[cca-protocol.md](cca-protocol.md)** — CCA byte-level protocol reference (packet formats, pairing, config)
- **[CCX.md](CCX.md)** — CCX/Thread protocol (CBOR messages, button encoding, sniffer setup)
- **[ra3-system.md](ra3-system.md)** — RA3 processor internals (LEAP API, certificates, database editing)
- **[dimming-curves.md](dimming-curves.md)** — Warm-dim curve definitions from Designer database
