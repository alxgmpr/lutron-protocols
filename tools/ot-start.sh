#!/usr/bin/env bash
# Start OpenThread RCP daemon + configure for Lutron Thread network
#
# Usage:
#   Terminal 1:  ./tools/ot-start.sh daemon
#   Terminal 2:  ./tools/ot-start.sh join
#
# The nRF52840 dongle must have the Lutron Thread dataset provisioned
# (network key, channel 25, PAN ID 0xXXXX, etc.)

set -euo pipefail

OT_DIR="$(cd "$(dirname "$0")/../src/ot-nrf528xx/openthread/build/posix/src/posix" && pwd)"
OT_DAEMON="$OT_DIR/ot-daemon"
OT_CTL="$OT_DIR/ot-ctl"

# Auto-detect nRF52840 serial device
SERIAL_DEV=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
if [ -z "$SERIAL_DEV" ]; then
    echo "ERROR: No nRF52840 dongle found (no /dev/cu.usbmodem* device)"
    exit 1
fi

# Find the utun interface created by ot-daemon
find_utun() {
    # Look for the utun interface with our mesh-local prefix
    ifconfig | grep -B5 "fd0d:2ef:a82c" | grep "^utun" | cut -d: -f1 | head -1
}

case "${1:-help}" in
    daemon)
        echo "Starting ot-daemon with $SERIAL_DEV"
        echo "Press Ctrl+C to stop"
        sudo "$OT_DAEMON" -v "spinel+hdlc+uart://${SERIAL_DEV}?uart-baudrate=460800"
        ;;

    join)
        IFACE=$(find_utun)
        if [ -z "$IFACE" ]; then
            echo "ERROR: No utun interface found. Start the daemon first: ./tools/ot-start.sh daemon"
            exit 1
        fi
        echo "Using interface: $IFACE"
        echo "Configuring and joining Thread network..."

        # Send startup commands via ot-ctl
        # mode rdn = Full Thread Device (router-eligible) — required for mesh-wide multicast
        # As a child (mode rn), the Lutron processor won't forward our multicast via MPL
        sudo "$OT_CTL" -I "$IFACE" << 'EOF'
ifconfig up
ccathreshold -45
mode rdn
thread start
EOF

        echo ""
        echo "Waiting for child state..."
        for i in $(seq 1 30); do
            STATE=$(sudo "$OT_CTL" -I "$IFACE" state 2>/dev/null | head -1)
            if [ "$STATE" = "child" ] || [ "$STATE" = "router" ]; then
                echo "Joined as $STATE after ${i}s"

                # Promote to router for mesh-wide multicast propagation
                if [ "$STATE" = "child" ]; then
                    echo "Requesting router promotion..."
                    sudo "$OT_CTL" -I "$IFACE" state router 2>/dev/null
                    sleep 2
                    STATE=$(sudo "$OT_CTL" -I "$IFACE" state 2>/dev/null | head -1)
                    echo "State: $STATE"
                fi

                # Add multicast route if needed
                if ! netstat -rn -f inet6 2>/dev/null | grep -q "ff03::1.*$IFACE"; then
                    echo "Adding multicast route for ff03::1 via $IFACE"
                    sudo route add -inet6 ff03::1 -interface "$IFACE"
                fi

                echo ""
                echo "Ready! Send commands with:"
                echo "  bun run tools/ccx-send.ts on \"Office Light\""
                exit 0
            fi
            if [ "$STATE" = "leader" ]; then
                echo "WARNING: Became leader (own partition, not connected to Lutron mesh)"
                echo "Try: thread stop && thread start"
                exit 1
            fi
            sleep 1
            printf "."
        done
        echo ""
        echo "ERROR: Timed out waiting for child state (still detached after 30s)"
        echo "Check: is the Lutron processor powered on? Is channel 25 correct?"
        exit 1
        ;;

    status)
        IFACE=$(find_utun)
        if [ -z "$IFACE" ]; then
            echo "No utun interface found. Daemon not running?"
            exit 1
        fi
        echo "Interface: $IFACE"
        sudo "$OT_CTL" -I "$IFACE" state
        sudo "$OT_CTL" -I "$IFACE" counters mac
        ;;

    ctl)
        IFACE=$(find_utun)
        if [ -z "$IFACE" ]; then
            echo "No utun interface found. Daemon not running?"
            exit 1
        fi
        echo "Opening ot-ctl on $IFACE (Ctrl+D to exit)"
        sudo "$OT_CTL" -I "$IFACE"
        ;;

    help|*)
        echo "Usage: ./tools/ot-start.sh <command>"
        echo ""
        echo "Commands:"
        echo "  daemon   Start ot-daemon (run in dedicated terminal)"
        echo "  join     Configure radio + join Lutron Thread network"
        echo "  status   Show Thread state and MAC counters"
        echo "  ctl      Open interactive ot-ctl session"
        ;;
esac
