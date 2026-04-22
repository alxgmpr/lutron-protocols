#!/usr/bin/env bash
#
# Build OpenThread NCP firmware for the nRF52840 soldered to the Nucleo board.
#
# Clones ot-nrf528xx, applies the Nucleo UART patch (pins, baud, no HWFC) and
# the TMF extension patch (6 vendor Spinel props 0x3C00-0x3C05 for diag /
# neighbor / child toolkit), builds ot-ncp-ftd with USB bootloader support and
# OT_NETDIAG_CLIENT enabled, then packages a DFU zip.
#
# Prerequisites:
#   - ARM GCC toolchain (arm-none-eabi-gcc)
#   - CMake + Ninja
#   - nrfutil with nrf5sdk-tools (pip install nrfutil; nrfutil install nrf5sdk-tools)
#
# Outputs:
#   build/ot-ncp-ftd-nucleo-tmf.hex — raw hex (for copy to firmware/ncp/)
#   build/ot-ncp-ftd-nucleo-tmf.zip — DFU zip (for USB DFU or nrf-dfu-flash.ts)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/build/ot-nrf528xx"
OT_REPO="https://github.com/openthread/ot-nrf528xx.git"
OUTPUT_DIR="$PROJECT_ROOT/build"

# ARM toolchain — adjust if installed elsewhere
ARM_GCC="${ARM_GCC_PATH:-/Applications/ArmGNUToolchain/15.2.rel1/arm-none-eabi/bin}"
if [ -d "$ARM_GCC" ]; then
  export PATH="$ARM_GCC:$PATH"
fi

# Verify toolchain
if ! command -v arm-none-eabi-gcc &>/dev/null; then
  echo "Error: arm-none-eabi-gcc not found. Install ARM GCC or set ARM_GCC_PATH." >&2
  exit 1
fi

# Clone or update
if [ -d "$BUILD_DIR/.git" ]; then
  echo "==> Using existing clone at $BUILD_DIR"
  cd "$BUILD_DIR"
  git checkout -- .
  git pull --ff-only || true
else
  echo "==> Cloning ot-nrf528xx..."
  rm -rf "$BUILD_DIR"
  git clone --depth 1 "$OT_REPO" "$BUILD_DIR"
  cd "$BUILD_DIR"
fi

# Init OpenThread submodule
echo "==> Initializing submodules..."
git submodule update --init --depth 1

# Apply Nucleo UART patch (edits ot-nrf528xx/src/nrf52840/transport-config.h)
echo "==> Applying Nucleo UART patch..."
git apply "$SCRIPT_DIR/nucleo-uart.patch"

# Apply TMF extension patch (edits openthread/src/ncp/* — submodule, so cd first)
echo "==> Applying TMF extension patch..."
( cd openthread && git apply "$SCRIPT_DIR/tmf-extension.patch" )

# Build NCP firmware
# -DOT_NETDIAG_CLIENT=ON enables otThreadSendDiagnosticGet / otThreadSendDiagnosticReset
# (required by the TMF extension; default is OFF for NCP-FTD)
echo "==> Building ot-ncp-ftd..."
./script/build nrf52840 USB_trans -DOT_BOOTLOADER=USB -DOT_NETDIAG_CLIENT=ON

# Find the built ELF
ELF="$BUILD_DIR/build/nrf52840-usb/bin/ot-ncp-ftd"
if [ ! -f "$ELF" ]; then
  # Fallback path
  ELF="$BUILD_DIR/build/bin/ot-ncp-ftd"
fi
if [ ! -f "$ELF" ]; then
  echo "Error: ot-ncp-ftd ELF not found after build" >&2
  exit 1
fi

# Convert to HEX (copy into build/ for the commit-tracked artifact)
HEX="$OUTPUT_DIR/ot-ncp-ftd-nucleo-tmf.hex"
echo "==> Converting ELF to HEX..."
mkdir -p "$OUTPUT_DIR"
arm-none-eabi-objcopy -O ihex "$ELF" "$HEX"

# Package DFU zip
DFU_ZIP="$OUTPUT_DIR/ot-ncp-ftd-nucleo-tmf.zip"
echo "==> Packaging DFU zip..."
nrfutil nrf5sdk-tools pkg generate \
  --hw-version 52 \
  --sd-req 0x00 \
  --application "$HEX" \
  --application-version 1 \
  "$DFU_ZIP"

echo ""
echo "==> Done:"
echo "    HEX: $HEX"
echo "    DFU: $DFU_ZIP"
echo ""
echo "Flash via USB DFU (put dongle in bootloader mode first):"
echo "  nrfutil nrf5sdk-tools dfu usb-serial -pkg $DFU_ZIP -p /dev/cu.usbmodem*"
echo ""
echo "Flash via Nucleo TCP stream:"
echo "  arm-none-eabi-objcopy -O binary $ELF /tmp/ot-ncp-ftd-nucleo-tmf.bin"
echo "  bun run tools/nrf-dfu-flash.ts /tmp/ot-ncp-ftd-nucleo-tmf.bin --host \$NUCLEO_HOST"
