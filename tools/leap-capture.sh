#!/bin/bash
# LEAP Traffic Capture — decrypt Lutron app ↔ processor TLS traffic
#
# Three approaches (try in order):
#   1. SSLKEYLOGFILE: App dumps TLS session keys → Wireshark decrypts
#   2. LEAP Event Monitor: Subscribe to processor events via our certs
#   3. MITM Proxy: Full bidirectional interception
#
# Usage:
#   ./tools/leap-capture.sh keylog      # Start Wireshark + app with keylog
#   ./tools/leap-capture.sh monitor     # Start LEAP event monitor
#   ./tools/leap-capture.sh mitm-setup  # Generate MITM certs + setup
#   ./tools/leap-capture.sh mitm        # Start MITM proxy

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CAPTURE_DIR="$PROJECT_DIR/captures/leap-commissioning"
SSL_KEYLOG="$CAPTURE_DIR/ssl-keys.log"
PCAP_FILE="$CAPTURE_DIR/leap-$(date +%Y%m%d-%H%M%S).pcap"

mkdir -p "$CAPTURE_DIR"

case "${1:-help}" in

keylog)
  echo "=== SSLKEYLOGFILE Approach ==="
  echo ""
  echo "This sets SSLKEYLOGFILE so the Lutron app dumps TLS session keys."
  echo "Wireshark can then decrypt the captured traffic."
  echo ""
  echo "Step 1: Set env var for all new apps"
  launchctl setenv SSLKEYLOGFILE "$SSL_KEYLOG"
  echo "  Set SSLKEYLOGFILE=$SSL_KEYLOG"
  echo ""

  echo "Step 2: Kill existing Lutron app (if running)"
  pkill -f "Lutron.app" 2>/dev/null || true
  sleep 1

  echo "Step 3: Start packet capture on processor traffic"
  echo "  Capturing to: $PCAP_FILE"
  echo "  (You may need to enter your password for tcpdump)"
  sudo tcpdump -i en0 -w "$PCAP_FILE" "host 10.0.0.1 and port 8081" &
  TCPDUMP_PID=$!
  echo "  tcpdump PID: $TCPDUMP_PID"
  sleep 1

  echo ""
  echo "Step 4: Launching Lutron app..."
  open -a "Lutron"
  echo ""

  echo "=== CAPTURING ==="
  echo ""
  echo "Now do the following in the Lutron app:"
  echo "  1. Navigate to the device you want to pair"
  echo "  2. Start the pairing/commissioning process"
  echo "  3. Complete the pairing"
  echo ""
  echo "When done, press Ctrl+C to stop capture."
  echo ""

  # Wait for Ctrl+C
  trap "echo ''; echo 'Stopping capture...'; sudo kill $TCPDUMP_PID 2>/dev/null; launchctl unsetenv SSLKEYLOGFILE; echo ''; echo 'Files:'; echo '  PCAP: $PCAP_FILE'; echo '  Keys: $SSL_KEYLOG'; echo ''; echo 'To decrypt in Wireshark:'; echo '  1. Open $PCAP_FILE in Wireshark'; echo '  2. Edit → Preferences → Protocols → TLS'; echo '  3. Set \"(Pre)-Master-Secret log filename\" to:'; echo '     $SSL_KEYLOG'; echo '  4. Apply — you should see decrypted LEAP JSON'; exit 0" INT
  wait $TCPDUMP_PID 2>/dev/null
  ;;

monitor)
  echo "=== LEAP Event Monitor ==="
  echo ""
  echo "Subscribes to processor events via our LEAP certs."
  echo "No MITM needed — watches from the processor side."
  echo ""
  exec bun run "$SCRIPT_DIR/leap-commission-watch.ts" \
    --log "$CAPTURE_DIR/events-$(date +%Y%m%d-%H%M%S).jsonl" \
    "$@"
  ;;

mitm-setup)
  echo "=== MITM Proxy Setup ==="
  echo ""
  echo "Step 1: Generate certificates"
  bun run "$SCRIPT_DIR/leap-mitm-proxy.ts" --gen-certs
  echo ""

  echo "Step 2: Trust the MITM CA (requires sudo)"
  echo "Running: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain $PROJECT_DIR/data/mitm-ca-cert.pem"
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$PROJECT_DIR/data/mitm-ca-cert.pem"
  echo "  CA trusted."
  echo ""

  echo "Step 3: Setup complete. To start the proxy:"
  echo "  ./tools/leap-capture.sh mitm"
  echo ""
  echo "NOTE: Traffic redirect is the hard part on same-host macOS."
  echo "Options:"
  echo "  a) Use Proxyman app (easiest — handles system extension + MITM)"
  echo "  b) Use mitmproxy in transparent mode"
  echo "  c) Run the proxy on a different machine and ARP spoof"
  echo "  d) Use 'networksetup' to set system SOCKS proxy"
  echo ""
  echo "For option (a):"
  echo "  1. Install Proxyman: brew install --cask proxyman"
  echo "  2. Enable SSL Proxying for 10.0.0.1:8081"
  echo "  3. Proxyman handles all the certificate + redirect work"
  ;;

mitm)
  echo "=== MITM Proxy ==="
  echo ""
  exec bun run "$SCRIPT_DIR/leap-mitm-proxy.ts" \
    --log "$CAPTURE_DIR/mitm-$(date +%Y%m%d-%H%M%S).jsonl" \
    "$@"
  ;;

help|*)
  echo "LEAP Traffic Capture Toolkit"
  echo ""
  echo "Usage: ./tools/leap-capture.sh <command> [options]"
  echo ""
  echo "Commands:"
  echo "  keylog       Best approach: SSLKEYLOGFILE + Wireshark"
  echo "               Sets env var, starts tcpdump, launches app."
  echo "               Then open .pcap in Wireshark with the key file."
  echo ""
  echo "  monitor      Easy approach: LEAP event subscription"
  echo "               Watches processor events via our LEAP certs."
  echo "               No MITM/redirect needed."
  echo ""
  echo "  mitm-setup   Generate MITM certs and trust CA"
  echo "  mitm         Start MITM proxy (needs traffic redirect)"
  echo ""
  echo "Recommended flow:"
  echo "  1. Try 'keylog' first — simplest if SSLKEYLOGFILE works"
  echo "  2. Run 'monitor' in parallel — catches processor-side events"
  echo "  3. If keylog doesn't work, try Proxyman or mitmproxy"
  ;;
esac
