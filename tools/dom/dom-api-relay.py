#!/usr/bin/env python3
"""
TCP -> abstract-unix-socket relay so a gRPC client off-box can reach the
domain-object-manager API at @dom-api.

Self-terminating by design: exits after TTL seconds no matter what, so it can
never be left orphaned on the processor.

  usage: domrelay.py [port] [ttl_seconds]
"""
import os
import socket
import sys
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 19090
TTL = int(sys.argv[2]) if len(sys.argv) > 2 else 180
TARGET = "\0dom-api"


def watchdog():
    time.sleep(TTL)
    print(f"[relay] TTL {TTL}s reached, exiting", flush=True)
    os._exit(0)


def pump(src, dst):
    try:
        while True:
            b = src.recv(65536)
            if not b:
                break
            dst.sendall(b)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def handle(conn):
    try:
        up = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        up.connect(TARGET)
    except OSError as e:
        print(f"[relay] upstream connect failed: {e}", flush=True)
        conn.close()
        return
    threading.Thread(target=pump, args=(conn, up), daemon=True).start()
    threading.Thread(target=pump, args=(up, conn), daemon=True).start()


def main():
    threading.Thread(target=watchdog, daemon=True).start()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", PORT))
    srv.listen(8)
    print(f"[relay] 127.0.0.1:{PORT} -> @dom-api, ttl={TTL}s", flush=True)
    while True:
        try:
            conn, _ = srv.accept()
        except OSError:
            break
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


main()
