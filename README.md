# Lutron Tools

Tools and firmware for reverse engineering Lutron lighting control systems, covering CCA (433 MHz RF), CCX (Thread/802.15.4), and LEAP (processor API). Built on an STM32H723 transceiver with TypeScript host tooling.

Supports Phoenix, Caseta, and Vive product families.

<img width="912" height="740" alt="image" src="https://github.com/user-attachments/assets/de5c9715-4d1f-4f45-b770-9e668852199d" />

## Background

This project started with Caseta CCA radios and expanded into reverse engineering Lutron Designer binaries and firmware images (from publicly accessible files and hardware purchased from eBay). Over time, this work produced a detailed understanding of Lutron's control systems and enabled the following capabilities:

- Pairing to devices as a transmitter, aka imitating a Pico (direct control, no bridge required)
- Imitating a bridge, pairing devices to our own radios and fake CCA subnet.
- Adding virtual devices to a project, allowing for low-latency bridging to other devices (I used this to turn my RGB+CCT WiZ WiFi bulbs into fake Ketra bulbs)
- Mixing device families (RA3 <-> HomeWorks QSX), "teaching" devices to pair with other families
- Spoofing devices during pairing to allow more x-family pairing
- On-the-fly configuration of devices and expanded parameters like fade rates, delays, trim config, and status LED config
- Decoding Vive, Caseta, RA2 Select, and Phoenix (RA3/QSX/Athena/XC) firmware.
  - This includes locating test pad pinouts from FCC internal photo filings. Soldering onto them and loading a custom SPL written in raw assembly to extract data from the eMMC. From there the SPL was updated to surgically change a `#` to `\n` to allow for root access over UART serial console.
- Root exploits in Phoenix and Caseta/RA2 Select bridge firmwares. 
  - Unlocked device limits, change device types

## Key Concepts

- CCA = QS Link over radio = 8N1 packets + TDMA slotting. Seq + 6 = 75ms time delta. Seq + 1 = 12.5ms.
- CCX = 2.4 GHz Thread + CBOR encoding + CoAP port. Code name Pegasus. Credentials are extractable from LEAP or from the Designer database
- Phoenix = RadioRA3, HomeWorks QSX, Athena, myRoomXc. Designer project determines capabilities. Firmware is identical across this family
- Sunnata variants are identical hardware: RRST = HRST = ARST. RA3 dimmers pair to HWQS without modification. The only difference is the product label.
- Lutron Designer = .NET app + LocalDB. Project files are just source of truth for the database

## Hardware

<img width="461" alt="image" src="https://github.com/user-attachments/assets/11533b74-ef90-4847-9f7d-609a5c813bd4" />


```
  CC1101 (433 MHz CCA)  ──┐                                ┌── UART shell (ST-LINK VCP)
                          ├── STM32H723 Nucleo (FreeRTOS) ─┤
  nRF52840 (Thread CCX) ──┘   Ethernet, UDP :9433          └── Stream → CLI (cli/nucleo.ts)
```

The Nucleo board hosts two radios: a CC1101 for CCA (433 MHz FSK) and an nRF52840 NCP for CCX (Thread/802.15.4 at 2.4 GHz). The host CLI connects over UDP for packet display, protocol decoding, and command dispatch.

This is architecturally similar to Lutron's production bridges. Caseta/Vive/RA2 Select use an STM32L100 with one or two CC110L radios, plus an EFR32 for CCX.

## Protocol Coverage


| Layer    | Transport                 | Description                                                       |
| -------- | ------------------------- | ----------------------------------------------------------------- |
| **CCA**  | 433 MHz 2-FSK, CC1101     | Dimmer control, pico remotes, pairing, state reports              |
| **CCX**  | 802.15.4 Thread, nRF52840 | Sunnata/Darter multicast level/scene, unicast CoAP programming    |
| **LEAP** | TLS mutual-auth JSON      | Processor API for zone/device/area hierarchy, status, configuration |


## Quick Start

```bash
git clone https://github.com/alxgmpr/lutron-tools.git && cd lutron-tools
npm install
cp .env.example .env  # configure IPs

# Connect to Nucleo
npx tsx cli/nucleo.ts

# One-shot commands
npx tsx tools/nucleo-cmd.ts "ccx coap get rloc:4800 fw/it/md"
npx tsx tools/nucleo-cmd.ts "cca button 001D94EF on"

# LEAP
npx tsx tools/leap-dump.ts --save
npx tsx tools/leap-query.ts /zone/3663/status
```

## Firmware

```bash
cd firmware
cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/arm-none-eabi.cmake
make -C build -j8
make flash     # OpenOCD + ST-LINK
make test      # C++ unit tests
```

Requires `arm-none-eabi-gcc`, CMake, and OpenOCD.

## CLI

The interactive TUI (`cli/nucleo.ts`) displays decoded packets, dispatches CCA/CCX commands, and supports recording.

```
ccx coap get rloc:4800 fw/it/md        # CoAP GET with CBOR decode
ccx coap scan 4800 cg/db/ct/c/AA       # Scan bucket names A-Z
ccx coap trim rloc:4800 95.0 1.0       # Set dimmer trim
ccx level 3663 50                       # Multicast level to zone
cca button 001D94EF on                  # CCA button press
status                                  # Radio/network status
```

## Tools


| Tool                         | Purpose                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `cli/nucleo.ts`              | Interactive TUI — packet display, commands, CoAP explorer |
| `tools/nucleo-cmd.ts`        | Scriptable one-shot Nucleo commands                       |
| `tools/coap-probe.ts`        | Scan all CCX devices for CoAP endpoints                   |
| `tools/coap-fuzz.ts`         | Rapid CoAP path fuzzer                                    |
| `tools/leap-dump.ts`         | Dump LEAP device/zone hierarchy                           |
| `tools/leap-query.ts`        | One-shot LEAP API query                                   |
| `tools/leap-cmd.ts`          | LEAP zone control (level, on, off, raise, lower)          |
| `tools/ccx-sniffer.ts`       | Thread traffic sniffer                                    |
| `tools/ccx-send.ts`          | Send CCX multicast commands                               |
| `tools/codegen.ts`           | Generate C headers from TS protocol definitions           |
| `tools/thread-decrypt.ts`    | Decrypt 802.15.4 frames                                   |
| `tools/rtlsdr-cca-decode.ts` | Decode CCA from RTL-SDR captures                          |
| `ldproxy/`                   | Designer auth proxy — unlocks all product types           |


## Documentation

Protocol research and reverse engineering findings are in `docs/`. See [docs/index.md](docs/index.md) for the full table of contents.

## Configuration

Environment values in `.env`:

```bash
RA3_HOST=10.x.x.x
CASETA_HOST=10.x.x.x
NUCLEO_HOST=10.x.x.x
```

Thread network parameters in `firmware/src/ccx/thread_config.h`. Both are gitignored — get credentials from LEAP API `/link` endpoint.

LEAP tools require mutual TLS certificates (`lutron-{name}-{cert,key,ca}.pem` in project root).

## Prior Work

- Entropy512's Lutron RF parameter and packet structure research: [github.com/Entropy512/lutron_hacks](https://github.com/Entropy512/lutron_hacks)
- Ceady's wireless interface documentation: [hackaday.io/project/2291](https://hackaday.io/project/2291-integrated-room-sunrise-simulator/log/7223-the-wireless-interface)

## Future Work

- Native Vive cross-compatibility. The custom bridge handles this at the application layer, but native pairing requires flashing the Caseta NCP with Vive (link type 30) CCA instead of Caseta/HWQS (type 9/11). So far only MRF2/MRF2S devices have paired natively.

## License

Research and educational purposes. Not affiliated with Lutron Electronics.  
