# Lutron Tools

Reverse-engineering toolkit for Lutron lighting control systems. RF packet capture/injection, Thread mesh networking, LEAP processor API, and CoAP device programming — from a single STM32 hardware platform with TypeScript host tooling.

Targets RadioRA 3, HomeWorks QSX, Caseta, and Vive product families.

## Background

This reverse engineering project lead to the discovery of tons of information about the inner workings of Lutron's control systems. Beginning with Caseta CCA radios, then diving into reverse engineering the Lutron Designer binaries and firmwares (publicly accessible files and hardware I purchased myself from eBay and other sources). Through hobby efforts but then some sleepless nights, Claude Code and I unpacked tons of data and made some large discoveries that allowed us to do more 'advanced' things with my own personal Lutron systems. These capabilities include:

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

## TLDR:

- CCA = QS Link over radio = 8N1 packets + TDMA slotting. Seq + 6 = 75ms time delta. Seq + 1 = 12.5ms.
- CCX = 2.4 GHz Thread + CBOR encoding + CoAP port. Code name Pegasus. Credentials are extractable from LEAP or from the Designer database
- Phoenix = RadioRA3, HomeWorks QSX, Athena, myRoomXc. Designer project determines capabilities. Firmware is identical across this family
- Sunnata = all the same. RRST = HRST = ARST. RA3 dimmers pair easily to HWQS. Seriously, theres no difference other than the label here.
- Lutron Designer = .NET app + LocalDB. Project files are just source of truth for the database

## Hardware

```
  CC1101 (433 MHz CCA)  ──┐                                ┌── UART shell (ST-LINK VCP)
                          ├── STM32H723 Nucleo (FreeRTOS) ─┤
  nRF52840 (Thread CCX) ──┘   Ethernet, UDP :9433          └── Stream → CLI (cli/nucleo.ts)
```

The Nucleo drives dual radios — a CC1101 for CCA (Clear Connect Type A, 433 MHz FSK) and an nRF52840 NCP for CCX (Clear Connect Type X, Thread/802.15.4 2.4 GHz). The host CLI connects over UDP for real-time packet display, protocol decoding, and interactive command dispatch.

Really, this is pretty similar to what Lutron actually uses in production for their own bridges. For Caseta/Vive/RA2 Select it's a STM32L100 + CC110L (2 of these on Vive) and EFR32

## Protocol Coverage


| Layer    | Transport                 | What It Does                                                      |
| -------- | ------------------------- | ----------------------------------------------------------------- |
| **CCA**  | 433 MHz 2-FSK, CC1101     | Legacy RF — dimmer control, pico remotes, pairing, state reports  |
| **CCX**  | 802.15.4 Thread, nRF52840 | Sunnata/Darter — multicast level/scene, unicast CoAP programming  |
| **LEAP** | TLS mutual-auth JSON      | Processor API — zone/device/area hierarchy, status, configuration |
| **CoAP** | UDP :5683 over Thread     | Direct device communication — firmware metadata, trim, LED, DFU   |


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

The interactive TUI (`cli/nucleo.ts`) provides live packet display with protocol decoding, CCA/CCX/CoAP command dispatch, and recording.

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

Protocol research and RE findings are in `docs/`:

- `**protocols/ccx-coap.md**` — CoAP endpoint map, firmware metadata format, database buckets
- `**cca-protocol.md**` — CCA packet structure, field layouts, pairing sequences
- `**protocols/ccx.md**` — Thread/802.15.4 protocol, CBOR message types, programming plane
- `**leap-api-exploration.md**` — Full LEAP endpoint enumeration
- `**coproc-firmware-re.md**` — Kinetis/EFR32 coprocessor firmware reverse engineering
- `**lutron-pki.md**` — Certificate infrastructure and key extraction

## Configuration

Environment values in `.env`:

```bash
RA3_HOST=10.x.x.x
CASETA_HOST=10.x.x.x
NUCLEO_HOST=10.x.x.x
```

Thread network parameters in `firmware/src/ccx/thread_config.h`. Both are gitignored — get credentials from LEAP API `/link` endpoint.

LEAP tools require mutual TLS certificates (`lutron-{name}-{cert,key,ca}.pem` in project root).

## Credits and Other Research

This project has been something I have tinkered with for a long time since I started reverse engineering with AI (before it was cool). 

However even before that several others did good manual labor. Special thanks to Entropy512, whose work saved me tons of time narrowing the RF parameters and packet structures: [https://github.com/Entropy512/lutron_hacks](https://github.com/Entropy512/lutron_hacks)

Additionally, [https://hackaday.io/project/2291-integrated-room-sunrise-simulator/log/7223-the-wireless-interface](https://hackaday.io/project/2291-integrated-room-sunrise-simulator/log/7223-the-wireless-interface) from Ceady was a great resource. One of my early test harnesses was an ESP32, an array of relays, and Pico with test leads soldered on. 

Thank you for you work.

## Future Work

- One goal is to get full cross compatibility with Vive devices. I have this of course with the custom bridge but it would be cool to flash the Caseta NCP with Vive (type 30) CCA instead of Caseta/HWQS (type 9/11). MRF2/MRF2S devices are the only ones from Vive that I have gotten to 'natively pair'

## License

Research and educational purposes. Not affiliated with Lutron Electronics.  