#!/usr/bin/env python3
"""Listen for STM32 stream UDP mirror frames and print decoded summaries.

Frame format matches TCP stream framing:
  [FLAGS:1][LEN:1][DATA:LEN]

FLAGS:
  bit7: TX (1=tx echo, 0=rx)
  bit6: protocol (1=CCX, 0=CCA)
  bits0-5: |RSSI| for RX packets
"""

from __future__ import annotations

import argparse
import datetime as dt
import socket


def fmt_ts() -> str:
    return dt.datetime.now().strftime("%H:%M:%S.%f")[:-3]


def parse_frame(frame: bytes) -> str:
    if len(frame) < 2:
        return f"short datagram ({len(frame)} bytes)"

    flags = frame[0]
    ln = frame[1]
    payload = frame[2 : 2 + ln]
    if len(payload) != ln:
        return f"bad len: hdr={ln} actual={len(payload)} total={len(frame)}"

    proto = "CCX" if (flags & 0x40) else "CCA"
    is_tx = bool(flags & 0x80)
    direction = "TX" if is_tx else "RX"
    if is_tx:
        rssi_part = ""
    else:
        rssi = -(flags & 0x3F)
        rssi_part = f" rssi={rssi}dBm"

    return f"{proto} {direction}{rssi_part} len={ln} hex={payload.hex().upper()}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Listen for STM32 UDP stream mirror packets")
    ap.add_argument("--bind", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    ap.add_argument("--port", type=int, default=9434, help="UDP port (default: 9434)")
    args = ap.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((args.bind, args.port))

    print(f"Listening UDP on {args.bind}:{args.port}")
    while True:
        data, (ip, port) = sock.recvfrom(2048)
        print(f"[{fmt_ts()}] {ip}:{port}  {parse_frame(data)}")


if __name__ == "__main__":
    raise SystemExit(main())

