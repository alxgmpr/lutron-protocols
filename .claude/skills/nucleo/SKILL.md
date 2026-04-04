---
name: nucleo
description: "STM32 Nucleo H723ZG: hardware topology, firmware, CLI, shell commands, radio protocol handling. Use PROACTIVELY whenever discussing hardware, serial ports, USB devices, flashing, DFU, firmware, or any physical connection."
metadata:
  author: alexgompper
  version: "2.0.0"
user_invocable: false
---

# STM32 Nucleo H723ZG — Hardware & Firmware Reference

## Hardware Topology — READ BEFORE ANY HARDWARE DISCUSSION

```
  CC1101 (SPI3)  ───┐                                 ┌── USART3 (ST-LINK VCP) → serial shell
  433 MHz CCA       ├── STM32H723ZG Nucleo-144 ───────┤
  nRF52840 (USART2)─┘   FreeRTOS + lwIP               ├── Ethernet (LAN8742A) → TCP/UDP :9433
  802.15.4 CCX           ARM Cortex-M7 @ 550 MHz       └── UDP stream → CLI (cli/nucleo.ts)
```

### Physical Devices

#### 1. STM32 Nucleo H723ZG (the "Nucleo")
- **What**: Main development board, ARM Cortex-M7 @ 550 MHz, runs FreeRTOS + lwIP
- **Connection to Mac**: USB (ST-LINK) → `/dev/tty.usbmodem*` (serial shell at 115200 baud)
- **Connection to Mac**: Ethernet → `10.0.0.3` (TCP/UDP port 9433 for CLI + stream)
- **Has attached**: CC1101 (SPI3) and nRF52840 dongle (USART2)
- **Flash method**: `cd firmware && make flash` (OpenOCD via ST-LINK). NEVER use `st-flash`.
- **Reset**: `reboot` shell command or `make reset` from host

#### 2. nRF52840 Dongle — NCP (soldered to Nucleo)
- **What**: 802.15.4 radio for Thread/CCX, runs OpenThread NCP firmware
- **4 wires to Nucleo**: VCC, GND, TX (P0.20 → STM32 PD6), RX (P0.24 ← STM32 PD5)
- **UART**: USART2 at 460800 baud, Spinel/HDLC protocol, NO hardware flow control
- **Connection to Mac**: **NONE** — USB port exists on dongle but is NOT plugged into the Mac
- **The dongle's USB port is ONLY used for DFU recovery** (flashing NCP firmware)
- **DFU bootloader**: Red pulsing LED = stuck in bootloader, NOT running NCP firmware
- **Normal operation**: No red LED, communicates over UART only
- **EUI-64**: `F4:CE:36:70:D6:82:E5:33`
- **NCP firmware source**: `~/lutron-tools/src/ot-nrf528xx/` (see NCP Firmware section below)
- **Pre-built DFU zip**: `firmware/ncp/ot-ncp-ftd-dfu.zip` (ready to flash, known working)

#### 3. nRF52840 Dongle — Sniffer/RCP (separate, USB to Mac)
- **What**: Second nRF52840 dongle, used for either 802.15.4 sniffing (Wireshark) or OpenThread RCP (ot-daemon)
- **Connection to Mac**: USB → `/dev/cu.usbmodem*` or `/dev/tty.usbmodem*`
- **NOT connected to the Nucleo** — this is a standalone USB dongle
- **Firmware options**: Sniffer mode (`/nrf sniffer`) or RCP mode (`/nrf ot`)
- **DFU**: Press reset button → red LED pulses → flash via `nrfutil nrf5sdk-tools dfu usb-serial`

### CRITICAL DISTINCTIONS

| | NCP Dongle (on Nucleo) | Sniffer/RCP Dongle (USB) |
|---|---|---|
| **Connected to** | STM32 via UART (4 wires soldered) | Mac via USB |
| **USB to Mac?** | **NO** (only for DFU recovery) | **YES** |
| **Serial port on Mac** | None (goes through Nucleo) | `/dev/cu.usbmodem*` |
| **Firmware** | OpenThread NCP | Sniffer or RCP |
| **Purpose** | Thread mesh member, TX/RX | Passive capture or CLI |
| **Red LED = DFU** | Must plug USB to Mac to fix | Press reset, flash via USB |

### Serial Port Guide

| Port | Device |
|------|--------|
| `/dev/tty.usbmodem*` (when only Nucleo connected) | STM32 ST-LINK VCP (shell) |
| `/dev/cu.usbmodem*` (when sniffer dongle plugged in) | nRF52840 sniffer/RCP dongle |
| If TWO usbmodem ports appear | One is ST-LINK, other is sniffer dongle |

**The NCP dongle does NOT appear as a serial port on the Mac** — it talks to the STM32 over UART, and you interact with it through the Nucleo's shell commands (`ot`, `ccx`, `spinel`).

### Common Mistakes to AVOID

1. **DO NOT** assume `/dev/tty.usbmodem*` is the nRF52840 — it's almost always the STM32 ST-LINK
2. **DO NOT** try to flash the NCP dongle via Mac serial commands — it's not connected via USB
3. **DO NOT** confuse the two nRF52840 dongles — one is soldered to the Nucleo (NCP), the other is a separate USB device (sniffer/RCP)
4. **DO NOT** use `nrfutil` to flash the NCP dongle unless its USB is physically plugged into the Mac
5. **DO NOT** send `ot reset` from the shell — it has been removed, but NEVER re-add it
6. **DO NOT** rebuild the NCP firmware without using the EXACT build commands from `firmware/PROJECT.md`
7. **DO NOT** use the `script/build` wrapper in ot-nrf528xx — use the direct cmake invocation

## Radio Hardware

- **CC1101**: 433 MHz FSK transceiver for CCA (Clear Connect Type A). SPI3 (PC10 SCK, PC11 MISO, PC12 MOSI, PA4 CS), GDO0 interrupt (PA0), GDO2 backup interrupt (PC15).
- **nRF52840**: 802.15.4 radio for CCX (Clear Connect Type X / Thread). USART2 (PD5 TX, PD6 RX) at 460800 baud, Spinel/HDLC NCP protocol. This is a dongle soldered to the Nucleo — its USB is NOT connected to the Mac.
- **Ethernet**: LAN8742A PHY, lwIP TCP/IP stack. Nucleo IP: `10.0.0.3`.
- **USART3**: ST-LINK Virtual COM Port — interactive shell with line editing and history.

## Building & Flashing

**IMPORTANT: Never use `st-flash`. Always use `make flash` (OpenOCD).**

```bash
cd firmware

# Build (debug)
make build

# Build + flash via OpenOCD
make flash

# Release build
make release

# Reset without reflash
make reset
```

Build system: CMake with ARM GCC toolchain. Sources listed in `firmware/CMakeLists.txt`.
OpenOCD config: `firmware/openocd.cfg`.
Output ELF: `firmware/build/lutron-nucleo.elf`.

## FreeRTOS Tasks

| Task | File | Priority | Purpose |
|------|------|----------|---------|
| `cca_task` | `firmware/src/cca/cca_task.cpp` | 3 | CC1101 RX/TX, CCA packet processing, command queue |
| `ccx_task` | `firmware/src/ccx/ccx_task.cpp` | 3 | nRF52840 Spinel NCP, Thread join, CCX multicast + CoAP unicast |
| `stream_task` | `firmware/src/net/stream.cpp` | 2 | UDP packet stream to CLI clients (port 9433, binary framing) |
| `shell_task` | `firmware/src/shell/shell.cpp` | 1 | UART interactive shell |
| `eth_task` | `firmware/src/net/eth.c` | 2 | lwIP Ethernet, link polling |

## Shell Commands (UART + CLI passthrough)

### Top-level
| Command | Description |
|---------|-------------|
| `status` | CC1101 state, RSSI, packet counts, heap, uptime |
| `rx on\|off` | Enable/disable CCA RX |
| `tx <hex>` | Transmit raw CCA packet (hex bytes) |
| `cca [cmd]` | CCA radio commands |
| `ccx [cmd]` | CCX Thread commands |
| `ot [cmd]` | OpenThread NCP query/control |
| `spinel [cmd]` | Raw Spinel property access |
| `stream` | UDP stream status |
| `eth` | Ethernet PHY debug |
| `config` | Show stored flash settings |
| `save` | Save settings to flash |
| `reboot` | NVIC_SystemReset |

### CCA subcommands (`cca ...`)
| Command | Description |
|---------|-------------|
| `cca button <dev_id_hex> <name>` | Button press (on/off/fav/raise/lower/scene1-4) |
| `cca level <zone_hex> <target_hex> <%> [fade_qs]` | Bridge set-level |
| `cca broadcast <zone_hex> <%> [fade_qs]` | Broadcast level to all devices |
| `cca pico-level <dev_id_hex> <%>` | Pico level control |
| `cca state <dev_id_hex> <%>` | State report |
| `cca beacon <dev_id_hex> [dur]` | Discovery beacon |
| `cca unpair <zone_hex> <target_hex>` | Unpair device |
| `cca led <zone_hex> <target_hex> <0-3>` | LED config |
| `cca fade <zone_hex> <target_hex> <on_qs> <off_qs>` | Fade config |
| `cca trim <zone_hex> <target_hex> <hi%> <lo%>` | Trim config |
| `cca phase <zone_hex> <target_hex> <byte_hex>` | Phase config |
| `cca save-fav <dev_id_hex>` | Save favorite level |
| `cca vive-level <hub_hex> <zone_hex> <%> [fade]` | Vive set-level |
| `cca vive-raise/lower <hub_hex> <zone_hex>` | Vive dim |
| `cca vive-pair <hub_hex> <zone_hex> [dur]` | Vive pairing |
| `cca pair pico <dev_hex> [type] [dur]` | Pico pairing (5btn/2btn/4btn-rl/4btn-scene) |
| `cca pair bridge <id_hex> <target_hex> [dur]` | Bridge pairing |
| `cca identify <target_hex>` | Flash device LED |
| `cca query <target_hex>` | Query device component info |
| `cca tune ...` | CC1101 register/tuning debug |
| `cca log [on\|off]` | CCA RX UART log toggle |

### CCX subcommands (`ccx ...`)
| Command | Description |
|---------|-------------|
| `ccx` | Thread status (role, RX/TX counts) |
| `ccx on <zone>` | Send ON to zone (multicast) |
| `ccx off <zone>` | Send OFF to zone |
| `ccx level <zone> <0-100>` | Set level % (multicast) |
| `ccx scene <id>` | Recall scene |
| `ccx peers` | List known Thread peers (RLOC16 → serial) |
| `ccx promisc [on\|off]` | Promiscuous mode (raw 802.15.4 frames) |
| `ccx log [on\|off]` | CCX RX UART log toggle |
| `ccx coap preset <addr> <dev_id> <preset_id> <level%> [fade_s]` | CoAP preset programming |
| `ccx coap aha <addr> <k4> <k5>` | CoAP AHA LED brightness |
| `ccx coap get <addr> <uri_path>` | CoAP GET |
| `ccx coap put <addr> <uri_path> <hex_payload>` | CoAP PUT |
| `ccx coap post <addr> <uri_path> <hex_payload>` | CoAP POST |

### CCX address resolution (`<addr>` argument)
The CoAP commands accept addresses in three formats:
- Full IPv6: `fd0d:02ef:a82c:0000:abcd:1234:5678:9abc`
- RLOC shorthand: `rloc:2C0C` → builds full RLOC IPv6 from mesh-local prefix
- Serial lookup: `serial:72200096` → looks up RLOC from peer table

### OT subcommands (`ot ...`)
| Command | Description |
|---------|-------------|
| `ot` | Thread state, RLOC16, partition ID |
| `ot extaddr` | Get NCP EUI-64 |
| `ot eui64` | Get factory EUI-64 |
| `ot channel` | Get/set channel |
| `ot panid` | Get/set PAN ID |
| `ot masterkey` | Get/set network master key |
| `ot extpanid` | Get/set extended PAN ID |
| `ot rloc16` | Get RLOC16 |
| `ot leaderdata` | Get leader data |
| `ot netdata` | Get network data |
| `ot addrtable` | Get address table |
| `ot ifconfig [up\|down]` | Interface up/down |
| `ot thread [start\|stop]` | Thread start/stop |
| `ot reset` | **DANGEROUS** — can brick NCP into DFU bootloader. NEVER USE. |

## CLI (Host Side)

```bash
# Connect to Nucleo
npx tsx cli/nucleo.ts              # uses NUCLEO_HOST env var
npx tsx cli/nucleo.ts 10.0.0.3   # direct IP

# Environment
NUCLEO_HOST=10.0.0.3             # default Nucleo IP
```

The CLI connects over UDP port 9433. Features:
- Interactive shell mirroring all firmware commands
- Live CCA/CCX packet display with protocol decoding
- Prefix `!` or use `pass` to send raw text to STM32 shell
- `record` / `stop` for CSV packet capture
- `status` queries firmware status blob
- Auto-reconnect on disconnect
- LEAP data integration for zone/device name lookups

## Key Firmware Source Files

| File | Purpose |
|------|---------|
| `firmware/src/cca/cca_task.cpp` | CCA RX/TX task, command queue, packet processing |
| `firmware/src/cca/cc1101.c` | CC1101 SPI driver, register config, RX/TX |
| `firmware/src/cca/cca_tdma.cpp` | TDMA timing, slot tracking |
| `firmware/src/cca/cca_commands.cpp` | CCA command builders (button, level, pair, config) |
| `firmware/src/cca/cca_pairing.cpp` | CCA pairing engine (bridge, pico, vive, hybrid) |
| `firmware/src/ccx/ccx_task.cpp` | CCX task: Thread join, multicast TX, CoAP unicast, peer table |
| `firmware/src/ccx/coap.c` | CoAP message builder (GET/PUT/POST with CBOR payload) |
| `firmware/src/ccx/ipv6_udp.c` | IPv6/UDP packet construction, checksum |
| `firmware/src/ccx/ccx_msg.c` | CCX CBOR message encoder (LEVEL_CONTROL, SCENE_RECALL) |
| `firmware/src/ccx/ccx_cbor.c` | Minimal CBOR encoder |
| `firmware/src/ccx/smp_serial.c` | SMP DFU over Spinel (nRF firmware update) |
| `firmware/src/net/stream.cpp` | UDP stream server (binary framing, multi-client) |
| `firmware/src/net/eth.c` | lwIP Ethernet init, link management |
| `firmware/src/shell/shell.cpp` | UART shell with line editing, history, all commands |
| `firmware/src/storage/flash_store.cpp` | Flash persistence (device IDs, Thread credentials) |

## Protocol Encoding Quick Reference

### CCA
- Packet types: 0x80-0x9F = 24 bytes (22 data + 2 CRC), 0xA0+ = 53 bytes (51 data + 2 CRC)
- Level encoding: `level16 = percent * 0xFEFF / 100`
- Fade encoding: `byte = seconds * 4` (quarter-seconds)
- IDs are 32-bit hex (device_id, zone_id, target_id)

### CCX
- Multicast: UDP to `ff03::1` port 9190, CBOR payload
- LEVEL_CONTROL: `[0, { 0: {0: level, 3: fade, 4: delay}, 1: [16, zoneId], 5: seq }]`
- SCENE_RECALL: `[1, { 1: sceneId, 5: seq }]`
- CoAP unicast: port 5683, to device primary ML-EID
- AHA LED brightness: path `/cg/db/ct/c/AHA`, payload `[108, {4: <active>, 5: <inactive>}]`
- Level encoding same as CCA: `level16 = percent * 0xFEFF / 100`
- Zone type always 16 in LEVEL_CONTROL key 1

## NCP Firmware — Build & Recovery

### Pre-built (use this first)
A known-working DFU zip is saved at `firmware/ncp/ot-ncp-ftd-dfu.zip`.

### Recovering NCP from DFU Bootloader (Red Pulsing LED)
1. **Plug the NCP dongle's USB into the Mac** — appears as `/dev/tty.usbmodemXXXX`
2. **Flash**: `nrfutil nrf5sdk-tools dfu usb-serial -pkg firmware/ncp/ot-ncp-ftd-dfu.zip -p /dev/tty.usbmodemXXXX`
3. **Unplug dongle USB from Mac**
4. **Reboot the Nucleo** (`reboot` command or power cycle)
5. **Wait ~45s** for NCP probe + Thread join + router promotion

### Building from source (only if needed)
Source: `~/lutron-tools/src/ot-nrf528xx/`

Key config in `src/nrf52840/transport-config.h` (must be modified from defaults):
```c
#define UART_HWFC_ENABLED 0     // disabled (default is 1)
#define UART_PIN_TX 20          // P0.20 (default is 6 = LED1!)
#define UART_PIN_RX 24          // P0.24 (default is 8 = LED2!)
```

Build commands (EXACT — do not change):
```bash
export PATH="/Applications/ArmGNUToolchain/15.2.rel1/arm-none-eabi/bin:$PATH"
cd ~/lutron-tools/src/ot-nrf528xx
cmake -B build -GNinja \
  -DCMAKE_TOOLCHAIN_FILE=src/nrf52840/arm-none-eabi.cmake \
  -DCMAKE_BUILD_TYPE=Release \
  -DOT_APP_NCP=ON -DOT_APP_CLI=OFF -DOT_APP_RCP=OFF \
  -DOT_BOOTLOADER=USB -DNRF_PLATFORM=nrf52840 -DOT_PLATFORM=external \
  -DOT_UART_BAUDRATE=460800
ninja -C build ot-ncp-ftd

# Convert + package
arm-none-eabi-objcopy -O ihex build/bin/ot-ncp-ftd /tmp/ot-ncp-ftd-dfu.hex
nrfutil nrf5sdk-tools pkg generate \
  --hw-version 52 --sd-req 0x00 \
  --application /tmp/ot-ncp-ftd-dfu.hex \
  --application-version 7 \
  /tmp/ot-ncp-ftd-dfu.zip
```

**CRITICAL build notes:**
- Must use `-DOT_BOOTLOADER=USB` — this selects the correct linker script (app at 0x1000, after MBR)
- Using `-DOT_BOOTLOADER=UART` or no bootloader flag = app at 0x0000 = **WILL NOT BOOT** on PCA10059
- Pins MUST be overridden in transport-config.h (defaults are P0.06/P0.08 which are LEDs)
- The `script/build` wrapper does NOT work for our config — use cmake directly

## Network

| Host | IP | Purpose |
|------|-----|---------|
| Nucleo | 10.0.0.3 | STM32 (TCP/UDP :9433) |
| RA3 Processor | 10.0.0.1 | LEAP API (:8081), Thread border router |
| Caseta | 10.0.0.2 | LEAP API (:8081) |
| Designer VM | 10.0.0.5 | SSH (user/pass), Designer + SQL Server |

Thread mesh-local prefix: `fd0d:2ef:a82c:0::/64`
Thread channel: 25, PAN ID: <your-panid>

## Common Workflows

### Build and flash firmware change
```bash
cd firmware && make flash
```

### Test a CCA command
```bash
npx tsx cli/nucleo.ts
# In CLI: cca level <zone> <target> 50
```

### Test a CCX command
```bash
npx tsx cli/nucleo.ts
# In CLI: ccx level <zone> 75
```

### Send CoAP to a device
```bash
npx tsx cli/nucleo.ts
# In CLI: ccx coap aha fd0d:02ef:a82c:0000:XXXX:XXXX:XXXX:XXXX 150 20
```

### Check Thread network status
```bash
npx tsx cli/nucleo.ts
# In CLI: ccx
# In CLI: ot
# In CLI: ccx peers
```

### Debug CC1101 radio
```bash
npx tsx cli/nucleo.ts
# In CLI: status
# In CLI: cca tune show
# In CLI: cca tune reg get 0x04
```
