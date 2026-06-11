# Lutron Protocol Wiki

Reverse-engineering and interoperability reference for Lutron lighting systems
(RadioRA3, HomeWorks QSX, Caséta, RadioRA 2, Vive). Organized along two axes:
**protocols** (the wire formats) and **devices** (one page per hardware family,
combining teardown and firmware RE), plus Designer tooling, our own toolkit, and
reference tables.

## Protocols

### CCA — Clear Connect Type A (433 MHz FSK)

| Doc | Description |
|-----|-------------|
| [protocols/cca/index.md](protocols/cca/index.md) | CCA protocol reference — packet types, addressing, commands, level/fade encoding |
| [protocols/cca/pairing.md](protocols/cca/pairing.md) | Pairing & handshake — device↔bridge challenge-echo, DeviceClass gating, no cryptography |
| [protocols/cca/tdma.md](protocols/cca/tdma.md) | TDMA MAC — slot timing, frame sync, beacon scheduling |
| [protocols/cca/rx-dispatch.md](protocols/cca/rx-dispatch.md) | Bridge RX state machine on the Phoenix EFR32 coprocessor (static analysis) |
| [protocols/cca/ota.md](protocols/cca/ota.md) | OTA firmware transfer — single-channel wire format, channel params, force-trigger procedure (EFR32 + HCS08) |
| [protocols/cca/end-devices.md](protocols/cca/end-devices.md) | CCA end-device firmware notes |

### CCX — Clear Connect Type X (Thread / 802.15.4)

| Doc | Description |
|-----|-------------|
| [protocols/ccx/index.md](protocols/ccx/index.md) | CCX protocol — CBOR messages, addressing, network params, sniffer setup |
| [protocols/ccx/coap.md](protocols/ccx/coap.md) | CoAP device communication — firmware endpoints, database buckets, trim/level encoding |
| [protocols/ccx/commissioning.md](protocols/ccx/commissioning.md) | BLE commissioning — Thread network-key delivery over TLS-in-GATT, authentication model |

### LEAP — JSON/TLS processor API

| Doc | Description |
|-----|-------------|
| [protocols/leap/index.md](protocols/leap/index.md) | LEAP API — endpoint matrix (RA3 vs Caséta), routes, CCX addressing |
| [protocols/leap/server-internals.md](protocols/leap/server-internals.md) | LEAP server RE — route/struct recovery from the RA3 Go binary |
| [protocols/leap/api-discovery.md](protocols/leap/api-discovery.md) | LEAP API discovery via the Android APK — command surfaces, zone/device endpoints |

### Wired

| Doc | Description |
|-----|-------------|
| [protocols/qslink.md](protocols/qslink.md) | QS Link RS-485 wired protocol and CCA field-mapping appendix |
| [protocols/ipl.md](protocols/ipl.md) | IPL — Designer ↔ processor TLS:8902 binary protocol, telnet/WSS interface |

## Devices

| Doc | Description |
|-----|-------------|
| [devices/index.md](devices/index.md) | RF transport overview — CCA vs CCX, product families, link types, OUTPUT vs DEVICE |
| [devices/ra3-processor.md](devices/ra3-processor.md) | RA3 processor ("Janus", AM3351) — architecture, services, DB schema, cert chains |
| [devices/caseta-smartbridge.md](devices/caseta-smartbridge.md) | Caséta SmartBridge — STM32 coprocessor, firmware extraction, dispatch/IPC, CCA OTA orchestration |
| [devices/vive.md](devices/vive.md) | Vive hub — teardown, app evolution (HTTP → Athena/LEAP), device firmware |
| [devices/radiora2-select-rep.md](devices/radiora2-select-rep.md) | RadioRA 2 Select Repeater (RR-SEL-REP2) — hardware, NAND layout, coprocessor |
| [devices/radiora2-main-rep.md](devices/radiora2-main-rep.md) | RadioRA 2 Main Repeater (RR-MAIN-REP-WH) — ColdFire, NOR flash, memory map |
| [devices/powpak.md](devices/powpak.md) | PowPak (RMJ/LMJ/RMJS) HCS08 + CC1101 — LDF format, DeviceClass, bootloader RE |
| [devices/qsm.md](devices/qsm.md) | QSM (Smart Bridge) HCS08 firmware — dispatch, TDMA, codec, CC1101 config |
| [devices/esn.md](devices/esn.md) | ESN (Energi Savr Node) 68K/ColdFire firmware — RTOS tasks, QS Link radio |
| [devices/pd-3pcl.md](devices/pd-3pcl.md) | PD-3PCL lamp dimmer — STM8L firmware extraction plan |
| [devices/grafik-eye.md](devices/grafik-eye.md) | Grafik Eye QS firmware — sysconfig payload format, encryption scheme |
| [devices/coprocessor-firmware.md](devices/coprocessor-firmware.md) | Phoenix coprocessor firmware RE — obfuscation cipher, EFR32/Kinetis variants |
| [devices/wink-hub.md](devices/wink-hub.md) | Wink Hub 1 — legacy Lutron hub firmware analysis |

## Designer

| Doc | Description |
|-----|-------------|
| [designer/index.md](designer/index.md) | Designer overview — commissioning app, project format, integration work |
| [designer/database.md](designer/database.md) | Designer LocalDB — schema, tables, preset/scene mapping |
| [designer/ra3-hw-migration.md](designer/ra3-hw-migration.md) | RA3 ↔ HomeWorks QSX migration — full identity injection and ID-only switch workflows |
| [designer/cycle-dim.md](designer/cycle-dim.md) | RA3 cycle dimming enablement (ATPM) — custom dimming curve spec |

## Tooling

| Doc | Description |
|-----|-------------|
| [tooling/nucleo.md](tooling/nucleo.md) | STM32H723 Nucleo transceiver — toolchain, flashing, build, wiring |
| [tooling/bdm-recovery.md](tooling/bdm-recovery.md) | PowPak BDM recovery — USBDM wiring and the `bdm-prog.py` programmer |
| [tooling/ccx-wiz-bridge.md](tooling/ccx-wiz-bridge.md) | CCX-WiZ bridge — state machine, HA add-on deployment, WiZ integration |
| [tooling/network.md](tooling/network.md) | Network topology, IP assignments, LEAP infrastructure |
| [tooling/cloud-proxy.md](tooling/cloud-proxy.md) | Cloud LEAP proxy — remote tunneling, firmware-check flow |
| [tooling/firmware-updates.md](tooling/firmware-updates.md) | Firmware update infrastructure — download API, CDN paths, device-class enum |

## Reference

| Doc | Description |
|-----|-------------|
| [reference/dimming-curves.md](reference/dimming-curves.md) | Dimming curve definitions — knots, group mappings, CCT/chromaticity |
| [reference/daylighting.md](reference/daylighting.md) | Daylighting system — Hyperion sensors, Designer config, firmware gating |
| [reference/cca-event-loop.md](reference/cca-event-loop.md) | CCA radio task design — FreeRTOS event loop, GDO0 interrupts |
| [reference/ccx-device-map.md](reference/ccx-device-map.md) | CCX device table — keypads, RLOCs, EUI-64 addresses |
| [reference/training-notes-index.md](reference/training-notes-index.md) | Index of the FSE training-notes corpus — defaults, limits, protocol corroboration |
