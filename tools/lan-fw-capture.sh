#!/bin/bash
#
# LAN Firmware Update Capture
#
# Captures all traffic between Designer VM (10.0.0.5) and RA3 processor (10.0.0.1)
# during a firmware update via Designer.
#
# Designer firmware push flow:
#   1. Designer downloads firmware ZIP from firmware-downloads.iot.lutron.io (HTTPS)
#   2. Designer pushes firmware to processor via SSH (port 22)
#   3. Processor reboots, comes back with new firmware
#   4. Processor pushes CCX device firmware over Thread (capture separately with ccx-fw-capture.ts)
#
# Usage:
#   ./tools/lan-fw-capture.sh                    # Capture Designer ↔ Processor traffic
#   ./tools/lan-fw-capture.sh --all              # Capture ALL processor traffic
#   ./tools/lan-fw-capture.sh --iface en0        # Specify interface
#   ./tools/lan-fw-capture.sh --duration 600     # Capture for 10 minutes
#
# Requires: tshark or tcpdump, run as root for live capture
#

set -euo pipefail

DESIGNER_IP="10.0.0.5"
PROCESSOR_IP="10.0.0.1"
OUT_DIR="/tmp/lan-fw-capture"
IFACE=""
DURATION="600"
CAPTURE_ALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --iface)   IFACE="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --all)     CAPTURE_ALL=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--iface <interface>] [--duration <secs>] [--all]"
      echo ""
      echo "Captures LAN traffic during Designer firmware update to RA3 processor."
      echo ""
      echo "Options:"
      echo "  --iface <name>    Network interface (auto-detected if not specified)"
      echo "  --duration <secs> Capture duration in seconds (default: 600)"
      echo "  --all             Capture ALL processor traffic, not just Designer↔Processor"
      echo ""
      echo "Key IPs:"
      echo "  Designer VM:    $DESIGNER_IP"
      echo "  RA3 Processor:  $PROCESSOR_IP"
      echo ""
      echo "What you'll capture:"
      echo "  - SSH session (encrypted, but you see connection timing/size)"
      echo "  - LEAP commands (TLS:8081 — firmware session management)"
      echo "  - IPL/Designer sync (TLS:8902)"
      echo "  - Cloud firmware download (if Designer downloads during capture)"
      echo "  - Post-update LEAP/Thread activity"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

mkdir -p "$OUT_DIR"

# Auto-detect interface if not specified
if [[ -z "$IFACE" ]]; then
  # Find the interface with a route to the processor
  IFACE=$(route -n get "$PROCESSOR_IP" 2>/dev/null | awk '/interface:/{print $2}' || true)
  if [[ -z "$IFACE" ]]; then
    IFACE="en0"
  fi
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PCAP_FILE="$OUT_DIR/lan-fw-${TIMESTAMP}.pcapng"

if $CAPTURE_ALL; then
  FILTER="host $PROCESSOR_IP"
else
  FILTER="(host $DESIGNER_IP and host $PROCESSOR_IP) or (host $PROCESSOR_IP and port 443)"
fi

echo "=============================="
echo "LAN Firmware Update Capture"
echo "=============================="
echo "  Interface:  $IFACE"
echo "  Filter:     $FILTER"
echo "  Duration:   ${DURATION}s"
echo "  Output:     $PCAP_FILE"
echo "  Designer:   $DESIGNER_IP"
echo "  Processor:  $PROCESSOR_IP"
echo ""
echo "Expected traffic:"
echo "  Port 22   = SSH (Designer pushes firmware)"
echo "  Port 8081 = LEAP (firmware session commands)"
echo "  Port 8902 = IPL (Designer sync)"
echo "  Port 443  = HTTPS (cloud firmware download)"
echo ""
echo "Start the Designer firmware update now. Press Ctrl+C to stop."
echo ""

# Prefer tshark for pcapng format, fall back to tcpdump
if command -v tshark &>/dev/null; then
  echo "[tshark] Starting capture..."
  sudo tshark -i "$IFACE" -f "$FILTER" -w "$PCAP_FILE" -a "duration:$DURATION"
elif command -v tcpdump &>/dev/null; then
  echo "[tcpdump] Starting capture..."
  sudo tcpdump -i "$IFACE" "$FILTER" -w "$PCAP_FILE" -G "$DURATION" -W 1
else
  echo "ERROR: Neither tshark nor tcpdump found. Install Wireshark or tcpdump."
  exit 1
fi

echo ""
echo "Capture saved to: $PCAP_FILE"
echo ""
echo "Quick analysis:"
echo "  # Overview"
echo "  tshark -r '$PCAP_FILE' -q -z conv,tcp"
echo ""
echo "  # SSH traffic volume (firmware size estimate)"
echo "  tshark -r '$PCAP_FILE' -Y 'tcp.port==22' -q -z io,stat,1"
echo ""
echo "  # LEAP commands during update"
echo "  tshark -r '$PCAP_FILE' -Y 'tcp.port==8081' -q -z io,stat,1"
echo ""
echo "  # Cloud firmware download (if captured)"
echo "  tshark -r '$PCAP_FILE' -Y 'tcp.port==443' -T fields -e tls.handshake.extensions_server_name"
