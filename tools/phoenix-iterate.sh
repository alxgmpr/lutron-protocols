#!/bin/bash
# Phoenix UART Boot — one-command build → deploy → test cycle
# Usage: ./tools/phoenix-iterate.sh [timeout_secs]
#
# Builds custom SPL on Mac, deploys to Pi, power-cycles Phoenix,
# sends via XMODEM, captures output.

set -e

PI="alex@10.0.0.6"
PI_KEY="$HOME/.ssh/id_ed25519_pi"
SSH="ssh -i $PI_KEY $PI"
SCP="scp -i $PI_KEY"
TIMEOUT="${1:-15}"

echo "=== Phoenix UART Boot Iterate ==="

# Step 1: Build SPL (if source changed)
if [ -f /tmp/u-boot-2017.01/spl/u-boot-spl.bin ]; then
    echo "[1/4] Rebuilding SPL..."
    make -C /tmp/u-boot-2017.01 CROSS_COMPILE=arm-none-eabi- ARCH=arm \
         HOSTLDFLAGS="-Wl,-ld_classic" -j8 spl/u-boot-spl.bin 2>&1 | \
         grep -E "\.o|\.bin|Error" | tail -5
else
    echo "[1/4] SPL not found, skipping build"
fi

# Step 2: Package with ARM stub
echo "[2/4] Packaging with entry stub..."
python3 /tmp/phoenix-boot/build-custom-spl.py

# Step 3: Deploy to Pi
echo "[3/4] Deploying to Pi..."
$SCP /tmp/phoenix-boot/custom-spl.bin $PI:~/

# Step 4: Run test
echo "[4/4] Running test (${TIMEOUT}s capture)..."
$SSH "python3 ~/phoenix-test.py ~/custom-spl.bin $TIMEOUT"
