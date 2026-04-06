# Documentation Index

Documentation for the Lutron reverse engineering toolkit, organized by topic.

## Protocols

| Doc | Description |
|-----|-------------|
| [protocols/cca.md](protocols/cca.md) | CCA (Clear Connect Type A) 433 MHz RF protocol — packet format, addressing, commands, pairing, timing |
| [protocols/ccx.md](protocols/ccx.md) | CCX (Clear Connect Type X) Thread/802.15.4 protocol — CBOR messages, addressing, programming plane |
| [protocols/ccx-coap.md](protocols/ccx-coap.md) | CCX CoAP device communication — firmware endpoints, database buckets, trim/level encoding |
| [protocols/qslink.md](protocols/qslink.md) | QS Link wired protocol (RS-485) and CCA field mapping appendix |
| [protocols/leap.md](protocols/leap.md) | LEAP JSON/TLS API — endpoint matrix (RA3 vs Caseta), route reference, CCX addressing |
| [protocols/ipl.md](protocols/ipl.md) | IPL (Integrated Protocol Layer) — Designer TLS:8902 binary protocol, telnet interface |

## Hardware

| Doc | Description |
|-----|-------------|
| [hardware/overview.md](hardware/overview.md) | RF system overview — CCA vs CCX, product families, link types |
| [hardware/phoenix.md](hardware/phoenix.md) | RA3 processor (AM335x "Janus") — architecture, services, LEAP, coprocessor links, DB schema |
| [hardware/vive.md](hardware/vive.md) | Vive hub teardown — AM335x + STM32L100 + CC110L, firmware extraction |
| [hardware/vive-processor.md](hardware/vive-processor.md) | Vive.app binary analysis (Binary Ninja RE) |
| [hardware/vive-athena.md](hardware/vive-athena.md) | Vive Athena variant — LEAP route probing follow-up |
| [hardware/rr-sel-rep2.md](hardware/rr-sel-rep2.md) | RadioRA Select Repeater — hardware analysis, firmware extraction |
| [hardware/nucleo.md](hardware/nucleo.md) | STM32H723 Nucleo transceiver — toolchain, flashing, wiring, nRF sniffer protocol |

## Security

| Doc | Description |
|-----|-------------|
| [security/phoenix-root.md](security/phoenix-root.md) | Phoenix rootfs analysis — binary inventory, UART boot, eMMC attack, persistent root SSH |
| [security/firmware-cdn.md](security/firmware-cdn.md) | Firmware CDN infrastructure — S3 buckets, shared credentials, version analysis |
| [security/pki.md](security/pki.md) | Lutron PKI — certificate chains, key extraction, mutual TLS |

## Firmware Reverse Engineering

| Doc | Description |
|-----|-------------|
| [firmware-re/coproc.md](firmware-re/coproc.md) | Coprocessor firmware — EFR32/Kinetis architecture, S19 extraction |
| [firmware-re/qsm.md](firmware-re/qsm.md) | QSM (Smart Bridge) HCS08 firmware — Ghidra analysis, packet dispatch, TDMA |
| [firmware-re/esn.md](firmware-re/esn.md) | ESN (Energi Savr Node) 68K/ColdFire firmware — RTOS tasks, QS Link radio |
| [firmware-re/pd-3pcl.md](firmware-re/pd-3pcl.md) | Pico/Dimmer firmware — flash extraction, button handling, dimming |
| [firmware-re/ble-commissioning.md](firmware-re/ble-commissioning.md) | BLE device commissioning protocol — pairing, credential exchange |
| [firmware-re/apk.md](firmware-re/apk.md) | LEAP Android APK — decompilation, endpoint discovery, command surfaces |
| [firmware-re/wink-hub.md](firmware-re/wink-hub.md) | Wink hub firmware — legacy Lutron hub analysis |

## Infrastructure

| Doc | Description |
|-----|-------------|
| [infrastructure/network.md](infrastructure/network.md) | Network topology, IP assignments, LEAP infrastructure, firmware delivery |
| [infrastructure/bridge.md](infrastructure/bridge.md) | CCX-WiZ bridge — state management, HA add-on deployment, WiZ integration |
| [infrastructure/designer-db.md](infrastructure/designer-db.md) | Designer database — schema, file format, HW project injection |
| [infrastructure/designer-hw-fix.md](infrastructure/designer-hw-fix.md) | Designer RA3 in HW project — model validation fix |
| [infrastructure/ra3-hw-migration.md](infrastructure/ra3-hw-migration.md) | RA3 to HW migration — validation gates, device migration workflow |
| [infrastructure/ra3-hw-workflow.md](infrastructure/ra3-hw-workflow.md) | Designer-RA3 roundtrip workflow — export, transfer, reimport |
| [infrastructure/cycle-dim.md](infrastructure/cycle-dim.md) | RA3 cycle dimming — custom dimming curve specification |
| [infrastructure/cloud-proxy.md](infrastructure/cloud-proxy.md) | Cloud LEAP proxy — remote tunneling via api.iot.lutron.io |
| [infrastructure/firmware-updates.md](infrastructure/firmware-updates.md) | Firmware update delivery — FTP, CoAP OTA, encryption, signing |

## Reference

| Doc | Description |
|-----|-------------|
| [reference/dimming-curves.md](reference/dimming-curves.md) | Dimming curve formulas — fade timing, level encoding, ramp rates |
| [reference/ccx-device-map.md](reference/ccx-device-map.md) | CCX device table — keypads, RLOCs, EUI-64 addresses |
| [reference/cca-event-loop.md](reference/cca-event-loop.md) | CCA radio task design — FreeRTOS event loop, GDO0 interrupts |
| [reference/daylighting.md](reference/daylighting.md) | Daylighting system — Hyperion sensors, Designer config, firmware gating |
