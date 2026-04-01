#!/bin/bash
# Send a command to serial port and capture output
# Usage: ./serial-cmd.sh "command" [timeout_seconds] [port]
PORT="${3:-/dev/tty.usbserial-4240}"
BAUD=115200
TIMEOUT="${2:-5}"
CMD="$1"

# Configure serial port
stty -f "$PORT" $BAUD cs8 -cstopb -parenb raw -echo -echoe -echok

# Start background reader
cat "$PORT" &
CAT_PID=$!

# Send command
printf "%s\r" "$CMD" > "$PORT"

# Wait for output
sleep "$TIMEOUT"

# Kill reader
kill $CAT_PID 2>/dev/null
wait $CAT_PID 2>/dev/null
