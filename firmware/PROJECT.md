# Nucleo H723ZG Firmware

## Overview

STM32H723ZG firmware that bridges Lutron CCA (CC1101 radio) and CCX (Thread via nRF52840 NCP) to a host application over UDP. Replaces the earlier ESP32+ESPHome approach for deterministic SPI/interrupt handling.

### Architecture

```
┌──────────────────────────────────────────────┐
│  Nucleo H723ZG (firmware)                    │
│                                              │
│  CC1101 ──SPI1──► CCA Task ──┐              │
│                               ├──► Stream ──► Ethernet (TCP:9433)
│  nRF52840 ─UART2─► CCX Task ─┘     Task     ◄── Ethernet (TCP:9433)
│                                              │
│  USART3 ──► Shell (debug via ST-LINK VCP)    │
└───────────────────────┬──────────────────────┘
                        │ RJ45
                        ▼
         Docker Host (lutron-bridge)
```

## Current Status (Feb 2026)

| Feature | Status |
|---------|--------|
| Build system (CMake + FreeRTOS + lwIP + HAL) | Working |
| Flash via OpenOCD ST-LINK/V3 | Working |
| FreeRTOS (4 tasks: CCA, CCX, Stream, Shell) | Working |
| Debug shell (USART3 VCP, 115200) | Working |
| nRF52840 NCP Spinel/HDLC (USART2, 460800) | Working |
| NCP probe (protocol version, firmware, EUI-64) | Working |
| CC1101 SPI driver | Built, not wired/tested |
| CCA protocol layer (decoder/encoder) | Ported, not tested |
| Ethernet (lwIP + LAN8742A) | Built, not tested (need cable) |
| TCP stream server (port 9433) | Built, not tested |
| nRF DFU over UART (MCUboot SMP) | Stub only |
| CCX Thread join / data exchange | Stub only |

## Project Structure

```
firmware/
├── CMakeLists.txt                      # FetchContent: STM32CubeH7 v1.11.2, FreeRTOS v11.1.0, lwIP
├── Makefile                            # make build | flash | monitor | reset
├── openocd.cfg                         # ST-LINK/V3, SWD, 4 MHz
├── cmake/arm-none-eabi.cmake           # Cortex-M7 toolchain (arm-none-eabi-gcc)
├── linker/STM32H723ZGTx_FLASH.ld      # 1MB flash, 320+32KB RAM
├── include/
│   ├── FreeRTOSConfig.h                # 1000 Hz tick, 64KB heap, 4 task priorities
│   ├── lwipopts.h                      # lwIP options for FreeRTOS
│   └── stm32h7xx_hal_conf.h            # HAL module enables
└── src/
    ├── main.cpp                        # BSP init → task creation → vTaskStartScheduler
    ├── syscalls.c                      # _write (→ USART3), _sbrk, etc.
    ├── stm32h7xx_it.c                  # SysTick → FreeRTOS, EXTI for GDO0
    ├── system_stm32h7xx.c              # SystemInit, PLL config, CMSIS globals
    ├── bsp/
    │   ├── bsp.h                       # Pin defs, peripheral handles (hspi1, huart2, huart3)
    │   ├── clock.c                     # HSE 8MHz → PLL1 → 550 MHz SYSCLK
    │   ├── gpio.c                      # SPI1, USART2/3, GDO0 EXTI, LEDs, ETH RMII
    │   ├── spi.c                       # SPI1: 4 MHz, CPOL=0 CPHA=0, software CS
    │   └── uart.c                      # USART2: 460800 (NCP), USART3: 115200 (shell)
    ├── cca/
    │   ├── cc1101.h / cc1101.c         # CC1101 register defs + HAL SPI driver
    │   ├── cca_task.cpp / cca_task.h   # FreeRTOS task: GDO0 EXTI → RX, TX queue
    │   ├── cca_types.h                 # Lutron CCA packet types (from ESPHome)
    │   ├── cca_crc.h                   # CRC-8 lookup table
    │   ├── cca_n81.h                   # N81 bit encoding/decoding
    │   ├── cca_encoder.h              # Packet → N81 → raw bytes
    │   └── cca_decoder.h              # Raw bytes → N81 → decoded packet
    ├── ccx/
    │   ├── ccx_task.cpp                # Spinel/HDLC NCP driver + DFU state machine
    │   └── ccx_task.h                  # Public API: start, DFU, is_running
    ├── net/
    │   ├── eth.c / eth.h               # ETH MAC + LAN8742A, lwIP netif, DHCP
    │   ├── stream.cpp / stream.h       # TCP:9433 server, binary framing, heartbeat
    │   └── lwip_arch/sys_arch.c        # lwIP ↔ FreeRTOS glue
    └── shell/
        ├── shell.cpp                   # Command parser: status, rx, tx, reboot, help
        └── shell.h
```

## Hardware Wiring

### CC1101 Module → Nucleo

| CC1101 Pin | Nucleo Pin | Header | Signal |
|---|---|---|---|
| VCC | 3V3 | CN8-7 | Power (3.3V) |
| GND | GND | CN8-11 | Ground |
| SCK | PA5 | CN7-10 | SPI1_SCK |
| MISO (SO) | PA6 | CN7-12 | SPI1_MISO |
| MOSI (SI) | **PD7** | CN9-2 | SPI1_MOSI (AF5) |
| CSN | PA4 | CN7-17 | GPIO software CS |
| GDO0 | PC7 | CN7-11 | EXTI7 (sync detect) |

> **PA7 conflict**: PA7 is hard-wired to ETH_RMII_CRS_DV on the Nucleo, so SPI1_MOSI uses PD7 (AF5) instead.

### nRF52840 Dongle (PCA10059) → Nucleo

| nRF Pin | Nucleo Pin | Header | Signal |
|---|---|---|---|
| VDD | 3V3 | CN8-7 | Power (3.3V) |
| GND | GND | CN8-11 | Ground |
| P0.20 (TX) | PD6 | CN9-4 | USART2_RX (nRF TX → STM RX) |
| P0.24 (RX) | PD5 | CN9-6 | USART2_TX (STM TX → nRF RX) |

> UART: 460800 baud, 8N1, **no hardware flow control**

### Ethernet (on-board)

LAN8742A PHY is hard-wired on the Nucleo board via RMII. Just plug in an RJ45 cable.

## nRF52840 NCP Firmware

Build script: `tools/nrf-ncp/build.sh` — clones OpenThread ot-nrf528xx, applies the
Nucleo UART patch (`tools/nrf-ncp/nucleo-uart.patch`), builds, and packages a DFU zip.

### Key Configuration (transport-config.h)

Patch modifies `src/nrf52840/transport-config.h` defaults for Nucleo wiring:
```c
#define UART_HWFC_ENABLED 0           // disabled (was 1 — CTS/RTS not wired)
#define UART_BAUDRATE NRF_UARTE_BAUDRATE_460800  // (was 115200)
#define UART_PIN_TX 20                // P0.20 (was 6 — LED1 on PCA10059!)
#define UART_PIN_RX 24                // P0.24 (was 8 — LED2 on PCA10059!)
```

### Build & Flash

```bash
# Build NCP firmware (clones repo, applies patch, produces DFU zip)
tools/nrf-ncp/build.sh
# Output: build/ot-ncp-ftd-nucleo.zip

# Flash via USB DFU (put dongle in DFU mode: press side button)
nrfutil nrf5sdk-tools dfu usb-serial \
  --package build/ot-ncp-ftd-nucleo.zip \
  --port /dev/cu.usbmodemXXXXX

# Or flash via Nucleo TCP stream
bun run tools/nrf-dfu-flash.ts /tmp/ot-ncp-ftd-nucleo.bin --host $NUCLEO_HOST
```

### Verified NCP Info
- Protocol: Spinel 4.3
- Firmware: `OPENTHREAD/thread-reference-20250612-551-gdd19659ab; NRF52840`
- EUI-64: `F4:CE:36:70:D6:82:E5:33`

## STM32 Firmware

### Build & Flash

```bash
# Prerequisites (macOS)
brew install cmake openocd
# ARM toolchain: download from https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads

cd ~/lutron-tools/firmware

# Build
make build     # or: cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/arm-none-eabi.cmake && cmake --build build

# Flash
make flash     # or: openocd -f openocd.cfg -c "program build/nucleo-firmware.elf verify reset exit"

# Serial monitor (ST-LINK VCP, 115200 baud)
make monitor   # or: screen /dev/cu.usbmodem* 115200
```

### Memory Usage
```
FLASH: ~136 KB / 1 MB (13%)
RAM:   ~131 KB / 352 KB (37%)
```

### Shell Commands

```
status    — CC1101 state, Ethernet status, CCX state, FreeRTOS heap
rx on|off — enable/disable CCA RX with live packet logging
tx <hex>  — transmit raw CCA packet
reboot    — NVIC_SystemReset
help      — list commands
```

## Key Lessons Learned

1. **PA7 conflict**: Nucleo-H723ZG hard-wires PA7 to ETH_RMII_CRS_DV. SPI1_MOSI must use PD7 (AF5).
2. **STM32H7 ETH HAL**: v1.11.2 uses callback-based RX (`rxAllocateCallback`, `rxLinkCallback`), not `HAL_ETH_DescAssignMemory`.
3. **nRF52840 dongle UART pins**: Default pins 6/8 are LEDs on PCA10059. Must change to P0.20/P0.24.
4. **UART HW flow control**: nRF transport-config.h defaults to `UART_HWFC_ENABLED 1`. Must disable if CTS/RTS aren't wired.
5. **Spinel TID**: TID=0 (`0x80` header) means unsolicited — NCP won't respond. Use TID >= 1 for queries.
6. **CMAKE_C_FLAGS_INIT vs #ifndef**: `-D` flags via CMAKE_C_FLAGS_INIT don't reliably override `#ifndef` guards in headers. Edit the source directly.

## Ethernet Stream Protocol (TCP:9433)

Binary framing (same as ESP32 UDP protocol):

**RX packet (STM32 → host):**
```
[FLAGS:1][LEN:1][DATA:N]
  FLAGS bit 7 = direction (0=RX, 1=TX echo)
  FLAGS bit 6 = protocol (0=CCA, 1=CCX)
  FLAGS bits 0-5 = |RSSI| for RX packets
```

**TX command (host → STM32):**
```
[CMD:1][LEN:1][DATA:N]
  0x01 = CCA TX
  0x02 = CCA set channel
  0x03 = NRF DFU start [size_le32]
  0x04 = NRF DFU data [chunk]
```

**Heartbeat:** `[0xFF][0x00]` every 5 seconds.

## What's Next

- [ ] Wire and test CC1101 (SPI1 + GDO0 EXTI)
- [ ] Connect Ethernet and test TCP stream
- [ ] Test CCA RX with live Lutron Pico remote
- [ ] Test CCA TX (dim command → Lutron dimmer)
- [ ] Implement CCX Thread network join (Spinel dataset config)
- [ ] Implement CCX UDP TX/RX on port 9190
- [ ] Build lutron-bridge Docker service (TCP client → MQTT)
- [ ] Implement MCUboot SMP for nRF DFU over UART
