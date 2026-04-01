#!/bin/bash
# U-Boot autoboot interrupt script
# Spams stop characters on serial while you power-cycle the board.
# Usage: ./uboot-catch.sh /dev/cu.usbserial-XXXX
#
# 1. Run this script
# 2. Power-cycle the Phoenix processor
# 3. If U-Boot catches input, you'll see the "=>" prompt
# 4. Press Ctrl+C to stop spamming, then interact manually

PORT="${1:-/dev/tty.usbserial-4240}"
BAUD=115200

if [ ! -c "$PORT" ]; then
  echo "Serial port $PORT not found"
  echo "Available: $(ls /dev/cu.usb* 2>/dev/null)"
  exit 1
fi

echo "=== U-Boot Autoboot Catcher ==="
echo "Port: $PORT @ $BAUD"
echo "Spamming stop characters. Power-cycle the board NOW."
echo "Press Ctrl+C when you see the => prompt."
echo ""

# Configure serial port
stty -f "$PORT" $BAUD cs8 -cstopb -parenb raw -echo -crtscts

# Start reading output in background
cat "$PORT" &
CAT_PID=$!

# Spam various stop characters as fast as possible
# Common U-Boot stop strings: space, Enter, 's', ESC, 'x', any key
trap "kill $CAT_PID 2>/dev/null; exit" INT
while true; do
  # Send a mix of common U-Boot interrupt characters
  printf '\x20\x0d\x0a\x20\x0d\x0a\x20\x0d\x0a' > "$PORT"
  # Tiny sleep to not completely flood (0.01s = 100 chars/sec)
  sleep 0.01
done
