#!/usr/bin/env bash
set -euo pipefail

# Capture and summarize Lutron app <-> processor traffic.
#
# Usage:
#   tools/capture-lutron-leap.sh [duration_seconds] [interface] [host_ip]
#
# Examples:
#   tools/capture-lutron-leap.sh
#   tools/capture-lutron-leap.sh 120 en0
#   tools/capture-lutron-leap.sh 180 en0 10.0.0.2

DURATION="${1:-90}"
IFACE="${2:-en0}"
HOST_IP="${3:-}"

if ! command -v tshark >/dev/null 2>&1; then
  echo "tshark is required but not found in PATH." >&2
  exit 1
fi

if ! [[ "$DURATION" =~ ^[0-9]+$ ]] || [ "$DURATION" -le 0 ]; then
  echo "duration must be a positive integer (seconds)." >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="captures/lutron-runtime/$TS"
mkdir -p "$OUT_DIR"

PCAP="$OUT_DIR/capture.pcapng"
SUMMARY="$OUT_DIR/summary.txt"
HTTP_REQ="$OUT_DIR/http-requests.tsv"
TLS_SNI="$OUT_DIR/tls-sni.tsv"
MDNS="$OUT_DIR/mdns.txt"
TCP_STREAMS="$OUT_DIR/tcp-streams.tsv"
PATH_CANDIDATES="$OUT_DIR/path-candidates.txt"

if [ -n "$HOST_IP" ]; then
  CAP_FILTER="host $HOST_IP and (tcp port 8081 or tcp port 8080 or tcp port 80 or udp port 5353)"
else
  CAP_FILTER="tcp port 8081 or tcp port 8080 or tcp port 80 or udp port 5353"
fi

echo "Starting capture"
echo "  interface : $IFACE"
echo "  duration  : ${DURATION}s"
echo "  host      : ${HOST_IP:-<all>}"
echo "  out       : $OUT_DIR"
echo "  filter    : $CAP_FILTER"

tshark \
  -i "$IFACE" \
  -f "$CAP_FILTER" \
  -a "duration:$DURATION" \
  -w "$PCAP" \
  >/dev/null 2>&1

{
  echo "Capture file: $PCAP"
  echo
  echo "[Packet Counters]"
  tshark -r "$PCAP" -q -z io,phs 2>/dev/null || true
  echo
  echo "[TCP Conversations]"
  tshark -r "$PCAP" -q -z conv,tcp 2>/dev/null || true
} >"$SUMMARY"

tshark -r "$PCAP" \
  -Y "http.request" \
  -T fields \
  -e frame.time \
  -e ip.src \
  -e tcp.srcport \
  -e ip.dst \
  -e tcp.dstport \
  -e http.request.method \
  -e http.host \
  -e http.request.uri \
  >"$HTTP_REQ" 2>/dev/null || true

tshark -r "$PCAP" \
  -Y "tls.handshake.extensions_server_name" \
  -T fields \
  -e frame.time \
  -e ip.src \
  -e tcp.srcport \
  -e ip.dst \
  -e tcp.dstport \
  -e tls.handshake.extensions_server_name \
  >"$TLS_SNI" 2>/dev/null || true

tshark -r "$PCAP" \
  -Y "mdns" \
  >"$MDNS" 2>/dev/null || true

tshark -r "$PCAP" \
  -Y "tcp" \
  -T fields \
  -e tcp.stream \
  -e ip.src \
  -e tcp.srcport \
  -e ip.dst \
  -e tcp.dstport \
  | sort -u >"$TCP_STREAMS" 2>/dev/null || true

# Best-effort plaintext path extraction for non-TLS payloads.
strings "$PCAP" \
  | rg -N '^/[A-Za-z0-9][A-Za-z0-9_./?%=&:-]*$' \
  | sort -u >"$PATH_CANDIDATES" 2>/dev/null || true

echo
echo "Capture complete."
echo "  summary        : $SUMMARY"
echo "  http requests  : $HTTP_REQ"
echo "  tls sni        : $TLS_SNI"
echo "  mdns           : $MDNS"
echo "  tcp streams    : $TCP_STREAMS"
echo "  path candidates: $PATH_CANDIDATES"
