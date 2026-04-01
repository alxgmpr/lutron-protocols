#!/bin/bash
# Build phoenix-emmc-read.S → emmc-read.bin (with GP header for AM335x UART boot)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Assembling phoenix-emmc-read.S..."
arm-none-eabi-as -mcpu=cortex-a8 -o emmc-read.o phoenix-emmc-read.S

echo "Linking..."
arm-none-eabi-ld -Ttext 0x402F0400 --entry 0x402F0400 -o emmc-read.elf emmc-read.o

echo "Extracting binary..."
arm-none-eabi-objcopy -O binary emmc-read.elf emmc-read.raw

echo "Adding GP header..."
python3 -c "
import struct
with open('emmc-read.raw', 'rb') as f:
    data = f.read()
with open('emmc-read.bin', 'wb') as f:
    f.write(struct.pack('<II', len(data), 0x402F0400))
    f.write(data)
print(f'  emmc-read.bin: {len(data)+8} bytes ({len(data)} code + 8 header)')
"

# Cleanup
rm -f emmc-read.o emmc-read.elf emmc-read.raw

echo "Done."
ls -la emmc-read.bin
