# STM32 ARM Toolchain & Flashing Guide

Reference for agents and developers: how the STM32H723ZG firmware is built, flashed, and debugged.

## Prerequisites

### macOS

```bash
# ARM cross-compiler (installs to /Applications/ArmGNUToolchain/)
brew install --cask gcc-arm-embedded

# Build system + flash tool
brew install cmake openocd

# Optional: linting and formatting
brew install clang-format cppcheck
```

### Linux

```bash
# Debian/Ubuntu
sudo apt install gcc-arm-none-eabi cmake openocd clang-format cppcheck
```

The toolchain file (`firmware/cmake/arm-none-eabi.cmake`) auto-discovers the compiler in this priority order:
1. `/Applications/ArmGNUToolchain/{15.2,14.2,13.3}.rel1/arm-none-eabi/bin/` (macOS .app bundle)
2. `/opt/homebrew/bin/` (Homebrew)
3. `/usr/local/bin/`
4. System PATH (fallback)

If none are found, CMake fails with an install instruction.

## Building

All commands run from `firmware/`:

```bash
cd firmware

# Debug build (default)
make build

# Release build (optimized, no debug symbols)
make release

# Clean
make clean
```

Under the hood, `make build` runs:
```bash
mkdir -p build
cd build && cmake -DCMAKE_BUILD_TYPE=Debug .. && cmake --build . -j$(nproc)
```

CMake automatically downloads dependencies via FetchContent on first configure:
- **STM32CubeH7** v1.11.2 — HAL drivers, startup assembly, CMSIS headers
- **FreeRTOS-Kernel** v11.1.0 — RTOS scheduler

### Build Output

All artifacts land in `firmware/build/`:

| File | Purpose |
|------|---------|
| `nucleo-firmware.elf` | Main executable (debug symbols, ~1.2 MB) |
| `nucleo-firmware.bin` | Raw binary for flash (~264 KB) |
| `nucleo-firmware.hex` | Intel HEX format |

CMake also prints memory usage after each build (flash and RAM consumption).

## Flashing

**CRITICAL: Always use `make flash`. Never use `st-flash`.**

```bash
make flash
```

This builds first (if needed), then runs:
```bash
openocd -f openocd.cfg -c "program build/nucleo-firmware.elf verify reset exit"
```

### What OpenOCD Does

The config (`firmware/openocd.cfg`) connects via:
- **Adapter**: ST-LINK/V3 (built into the Nucleo board) over SWD at 4 MHz
- **Target**: `stm32h7x` (Cortex-M7)
- **Reset**: `srst_only srst_nogate connect_assert_srst` — asserts system reset during connection to handle locked-up chips

The `program` command writes the ELF to flash, verifies the image, then resets the MCU to start running.

### Reset Without Reflashing

```bash
make reset
# Runs: openocd -f openocd.cfg -c "init; reset run; shutdown"
```

## Serial Monitor (Debug Shell)

The Nucleo's ST-LINK exposes a Virtual COM Port (VCP) on USART3 at 115200 baud:

```bash
make monitor
# Auto-discovers /dev/cu.usbmodem* and opens with `screen`
```

Exit screen with `Ctrl-A` then `K`, confirm with `Y`.

Shell commands available over this serial connection: `status`, `rx on|off`, `tx <hex>`, `reboot`, `help`.

## Cross-Compilation Details

### Compiler Flags

| Category | Flags |
|----------|-------|
| MCU | `-mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard` |
| C | `-std=c11 -Wall -Wextra -fdata-sections -ffunction-sections` |
| C++ | `-std=c++17 -fno-exceptions -fno-rtti` |
| Linker | `--gc-sections --specs=nano.specs --print-memory-usage` |

Key choices:
- **Hard float** (`fpv5-d16`) — uses the Cortex-M7 FPU
- **No exceptions/RTTI** — standard for embedded C++ (saves ~50 KB)
- **Nano specs** — uses newlib-nano for smaller printf/malloc
- **GC sections** — dead-code elimination (linker discards unused functions)

### Memory Map (from linker script)

| Region | Address | Size | Used For |
|--------|---------|------|----------|
| FLASH | `0x08000000` | 896 KB | Code + read-only data |
| FLASH_STORAGE | `0x080E0000` | 128 KB | Persistent config (device IDs, Thread params) |
| DTCMRAM | `0x20000000` | 128 KB | Main stack (zero wait state, no DMA) |
| RAM_D1 | `0x24000000` | 320 KB | FreeRTOS heap, .bss, .data |
| RAM_D2 | `0x30000000` | 32 KB | Ethernet DMA buffers (must be here — DMA can't reach D1) |

## Unit Tests

Tests compile with the **host** compiler (not ARM cross-compiler):

```bash
make test
# Uses clang++ -std=c++17, runs CRC, N81, decoder, and CBOR tests
```

## Code Quality

```bash
make format        # clang-format in-place
make format-check  # dry-run (CI-friendly, exits non-zero on diff)
make lint          # cppcheck with project-specific suppressions
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `arm-none-eabi-gcc not found` | Install toolchain: `brew install --cask gcc-arm-embedded` |
| `No ST-LINK VCP found` | Check USB cable is plugged into the ST-LINK USB port (not the user USB) |
| OpenOCD can't connect | Ensure no other debugger (STM32CubeIDE, another OpenOCD) is connected |
| Flash verify fails | Try `make clean && make flash` — stale build artifacts can cause this |
| Chip is locked up | OpenOCD's `connect_assert_srst` handles this — just re-run `make flash` |

## Key Files

```
firmware/
├── Makefile                        # Build/flash/monitor convenience targets
├── CMakeLists.txt                  # Full build config, FetchContent deps
├── cmake/arm-none-eabi.cmake       # Toolchain auto-discovery
├── openocd.cfg                     # ST-LINK SWD debugger config
├── linker/STM32H723ZGTx_FLASH.ld  # Memory layout and section placement
├── include/
│   ├── FreeRTOSConfig.h            # 550 MHz, 1 kHz tick, 64 KB heap
│   ├── lwipopts.h                  # lwIP tuning for FreeRTOS
│   └── stm32h7xx_hal_conf.h       # HAL module enables
└── tests/                          # Host-compiled unit tests
```
