# Lutron Tools

Reverse-engineering toolkit for Lutron lighting systems (RadioRA3, Homeworks QSX, Caseta, Vive). Covers all three Lutron transport layers — RF packet capture and injection, Thread mesh networking, and the LEAP processor API — from a single STM32 platform with host-side TypeScript tooling.

## Architecture

```
  CC1101 (CCA 433 MHz) ──┐                               ┌── Interactive shell (USART3)
                          ├── STM32H723 Nucleo (FreeRTOS) ┤
  nRF52840 (CCX Thread) ──┘   Ethernet / TCP :9433        └── TCP stream → Bun CLI
```

The STM32H723 Nucleo runs dual radios (CC1101 for CCA, nRF52840 for CCX), Ethernet via lwIP, and FreeRTOS. The host CLI (`cli/nucleo.ts`) connects over UDP for real-time packet streaming, protocol decoding, and command dispatch.

## Transport Layers

| Layer | Frequency | Physical | Encoding | Port/Protocol |
|-------|-----------|----------|----------|---------------|
| **CCA** (Clear Connect Type A) | 433 MHz | 2-FSK, CC1101 | N81 line coding, CRC-16 | SPI to STM32 |
| **CCX** (Clear Connect Type X) | 2.4 GHz | 802.15.4, Thread | CBOR arrays over IPv6/UDP | UDP :9190, nRF52840 NCP |
| **LEAP** | TCP/IP | TLS 1.2 mutual auth | JSON lines | TCP :8081 on processor |

## Directory Layout

| Directory | Runtime | Purpose |
|-----------|---------|---------|
| `firmware/` | STM32 C/C++ (FreeRTOS, lwIP) | Radio drivers, protocol engine, TCP stream, shell |
| `cli/nucleo.ts` | Bun | Primary UI — TCP client, interactive shell, packet decoder |
| `tools/` | Bun/TypeScript, Python | CLI utilities (RTL-SDR decoder, LEAP tools, codegen, analyzers) |
| `protocol/` | YAML + generated TS/C | CCA/CCX protocol definitions (single source of truth) |
| `ccx/` | TypeScript | CCX protocol encoder/decoder/config |
| `docs/` | — | Protocol documentation, research notes |

## Setup

### Prerequisites

- [Bun](https://bun.sh) (TypeScript runtime)
- [ARM GCC](https://developer.arm.com/tools-and-software/open-source-software/developer-tools/gnu-toolchain) (`arm-none-eabi-gcc` for firmware)
- [OpenOCD](https://openocd.org/) (firmware flashing)
- [CMake](https://cmake.org/) (firmware build system)
- Optional: [RTL-SDR](https://www.rtl-sdr.com/) dongle for raw RF captures
- Optional: [tshark](https://www.wireshark.org/) for CCX packet capture

### Install

```bash
git clone https://github.com/alxgmpr/lutron-tools.git
cd lutron-tools
bun install

# Copy and configure secrets
cp .env.example .env                                          # edit with your IPs/credentials
cp firmware/src/ccx/thread_config.example.h \
   firmware/src/ccx/thread_config.h                           # edit with your Thread network params
```

### LEAP Certificates

LEAP tools require mutual TLS certificates for your processor. Place them in the project root:

```
lutron-ra3-cert.pem    lutron-ra3-key.pem    lutron-ra3-ca.pem       # RA3 / Homeworks
lutron-caseta-cert.pem lutron-caseta-key.pem lutron-caseta-ca.pem    # Caseta
```

These can be extracted from the Lutron app or obtained via the LEAP pairing process.

### Build Firmware

```bash
cd firmware
cmake -B build -DCMAKE_TOOLCHAIN_FILE=arm-toolchain.cmake
make -C build -j8
```

### Flash

```bash
cd firmware
make flash    # uses OpenOCD + ST-LINK
```

## Usage

### CLI — Connect to Nucleo

```bash
bun cli/nucleo.ts <nucleo-ip>
```

Interactive shell with live packet display, protocol decoding, and all CCA/CCX commands. Type `help` for the full command list.

### LEAP — Query and Control

```bash
# Read zone status, set levels, configure presets
bun run tools/leap-cmd.ts status
bun run tools/leap-cmd.ts level 75 --fade 5
bun run tools/leap-cmd.ts config

# Dump full device hierarchy
bun run tools/leap-dump.ts --save

# Explore all LEAP endpoints
bun run tools/leap-explore.ts --save
```

### CCX — Thread Mesh Commands

```bash
# Send commands to Thread devices
bun run tools/ccx-send.ts level 50 --zone 3663
bun run tools/ccx-send.ts on --zone 3663

# Sniff Thread traffic
bun run tools/ccx-sniffer.ts --live

# CoAP programming (trim, LED config, etc.)
bun run tools/ccx-coap-send.ts aha --dst <ipv6> --src <ipv6>
```

### CCA — RF Capture and Decode

```bash
# Capture with RTL-SDR
rtl_sdr -f 433602844 -s 2000000 -g 40 capture.bin

# Decode packets
bun run tools/rtlsdr-cca-decode.ts --rate 2000000 capture.bin
```

### Protocol Codegen

```bash
# Regenerate TypeScript/C from YAML definitions
bun run tools/codegen.ts
```

## Protocol Definitions

`protocol/cca.yaml` and `protocol/ccx.yaml` are the single source of truth for packet structure. The codegen tool produces:

- `protocol/generated/typescript/protocol.ts` — TypeScript packet types and field parsers
- `protocol/generated/c/cca_types.h` — C header with packet format constants

## Key Concepts

**OUTPUT vs DEVICE** is the fundamental architectural split in Lutron:
- **OUTPUT** = zone/load control with level + fade + delay (CCA format 0x0E, CCX type 0)
- **DEVICE** = component control like button presses (CCA pico packets, CCX type 1)

**CCA packet lengths**: type byte 0x80–0x9F = 24 bytes, type 0xA0+ = 53 bytes (both include 2-byte CRC).

**Level encoding**: `level16 = percent * 0xFEFF / 100` (shared across CCA and CCX).

**Fade encoding**: quarter-seconds (`byte = seconds * 4`).

## Configuration

All environment-specific values live in `.env` (gitignored):

```bash
RA3_HOST=10.x.x.x          # RadioRA3 processor IP
CASETA_HOST=10.x.x.x       # Caseta bridge IP
NUCLEO_HOST=10.x.x.x       # STM32 Nucleo IP
DESIGNER_VM_HOST=10.x.x.x  # Designer VM IP
DESIGNER_VM_USER=user       # Designer VM SSH user
DESIGNER_VM_PASS=pass       # Designer VM SSH password
THREAD_CHANNEL=25           # Thread 802.15.4 channel
THREAD_PANID=0x0000         # Thread PAN ID
THREAD_XPANID=...           # Thread extended PAN ID (hex)
THREAD_MASTER_KEY=...       # Thread network master key (hex)
```

Thread network parameters for the firmware live in `firmware/src/ccx/thread_config.h` (also gitignored). Get both from the LEAP API `/link` endpoint on your processor.

## Documentation

The `docs/` directory contains detailed protocol research:

| Document | Topic |
|----------|-------|
| `lutron-rf-overview.md` | High-level RF transport overview |
| `cca-protocol.md` | CCA packet structure and field layouts |
| `CCX.md` | Thread/802.15.4 protocol deep dive |
| `leap-api-exploration.md` | Full LEAP endpoint enumeration |
| `leap-routes.md` | LEAP REST API routes |
| `cloud-leap-proxy.md` | Cloud LEAP relay via Lutron IoT |
| `ipl-protocol.md` | Designer IPL integration protocol |
| `firmware-update-infra.md` | OTA firmware update infrastructure |
| `ble-commissioning-re.md` | BLE commissioning reverse engineering |

## License

This project is for research and educational purposes. Not affiliated with Lutron Electronics.
