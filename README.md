# Lutron Tools

Reverse-engineering toolkit for Lutron lighting control systems. RF packet capture/injection, Thread mesh networking, LEAP processor API, and CoAP device programming — from a single STM32 hardware platform with TypeScript host tooling.

Targets RadioRA 3, Homeworks QSX, Caseta, and Vive product families.

## Hardware

```
  CC1101 (433 MHz CCA) ──┐                                ┌── UART shell (ST-LINK VCP)
                          ├── STM32H723 Nucleo (FreeRTOS) ─┤
  nRF52840 (Thread CCX) ──┘   Ethernet, UDP :9433          └── Stream → CLI (cli/nucleo.ts)
```

The Nucleo drives dual radios — a CC1101 for CCA (Clear Connect Type A, 433 MHz FSK) and an nRF52840 NCP for CCX (Clear Connect Type X, Thread/802.15.4). The host CLI connects over UDP for real-time packet display, protocol decoding, and interactive command dispatch.

## Protocol Coverage

| Layer | Transport | What It Does |
|-------|-----------|-------------|
| **CCA** | 433 MHz 2-FSK, CC1101 | Legacy RF — dimmer control, pico remotes, pairing, state reports |
| **CCX** | 802.15.4 Thread, nRF52840 | Sunnata/Darter — multicast level/scene, unicast CoAP programming |
| **LEAP** | TLS mutual-auth JSON | Processor API — zone/device/area hierarchy, status, configuration |
| **CoAP** | UDP :5683 over Thread | Direct device communication — firmware metadata, trim, LED, DFU |

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

| Tool | Purpose |
|------|---------|
| `cli/nucleo.ts` | Interactive TUI — packet display, commands, CoAP explorer |
| `tools/nucleo-cmd.ts` | Scriptable one-shot Nucleo commands |
| `tools/coap-probe.ts` | Scan all CCX devices for CoAP endpoints |
| `tools/coap-fuzz.ts` | Rapid CoAP path fuzzer |
| `tools/leap-dump.ts` | Dump LEAP device/zone hierarchy |
| `tools/leap-query.ts` | One-shot LEAP API query |
| `tools/leap-cmd.ts` | LEAP zone control (level, on, off, raise, lower) |
| `tools/ccx-sniffer.ts` | Thread traffic sniffer |
| `tools/ccx-send.ts` | Send CCX multicast commands |
| `tools/codegen.ts` | Generate C headers from TS protocol definitions |
| `tools/thread-decrypt.ts` | Decrypt 802.15.4 frames |
| `tools/rtlsdr-cca-decode.ts` | Decode CCA from RTL-SDR captures |
| `ldproxy/` | Designer auth proxy — unlocks all product types |

## Documentation

Protocol research and RE findings are in `docs/`:

- **`ccx-coap-protocol.md`** — CoAP endpoint map, firmware metadata format, database buckets
- **`cca-protocol.md`** — CCA packet structure, field layouts, pairing sequences
- **`CCX.md`** — Thread/802.15.4 protocol, CBOR message types
- **`leap-api-exploration.md`** — Full LEAP endpoint enumeration
- **`coproc-firmware-re.md`** — Kinetis/EFR32 coprocessor firmware reverse engineering
- **`lutron-pki.md`** — Certificate infrastructure and key extraction

## Configuration

Environment values in `.env`:

```bash
RA3_HOST=10.x.x.x
CASETA_HOST=10.x.x.x
NUCLEO_HOST=10.x.x.x
```

Thread network parameters in `firmware/src/ccx/thread_config.h`. Both are gitignored — get credentials from LEAP API `/link` endpoint.

LEAP tools require mutual TLS certificates (`lutron-{name}-{cert,key,ca}.pem` in project root).

## License

Research and educational purposes. Not affiliated with Lutron Electronics.
