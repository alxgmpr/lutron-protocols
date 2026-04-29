#!/usr/bin/env python3
"""UART proxy that logs all traffic between a program and /dev/ttyS1.
Creates a PTY, passes its name, and forwards data bidirectionally while logging."""
import os, sys, select, termios, time, struct

REAL_UART = "/dev/ttyS1"
LOGFILE = "/tmp/uart-traffic.bin"

def open_uart():
    fd = os.open(REAL_UART, os.O_RDWR | os.O_NOCTTY)
    old = termios.tcgetattr(fd)
    new = list(old)
    new[0] = 0
    new[1] = 0
    new[2] = 0x8B0  # CS8 | CREAD | CLOCAL
    new[3] = 0
    new[4] = termios.B115200
    new[5] = termios.B115200
    new[6][termios.VMIN] = 0
    new[6][termios.VTIME] = 1
    termios.tcsetattr(fd, termios.TCSAFLUSH, new)
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd

def main():
    # Create PTY pair
    master, slave = os.openpty()
    slave_name = os.ttyname(slave)
    print(f"PTY slave: {slave_name}", flush=True)

    # Open real UART
    uart_fd = open_uart()

    # Open log file
    log = open(LOGFILE, "wb")

    def log_data(direction, data):
        # Format: [timestamp:8][direction:1][length:2][data:N]
        ts = struct.pack("<d", time.time())
        hdr = struct.pack("<BH", direction, len(data))
        log.write(ts + hdr + data)
        log.flush()

    print(f"Proxying {slave_name} <-> {REAL_UART}", flush=True)
    print(f"Logging to {LOGFILE}", flush=True)
    print("Ready. Run the updater with this PTY path.", flush=True)

    try:
        while True:
            r, _, _ = select.select([master, uart_fd], [], [], 1.0)
            for fd in r:
                data = os.read(fd, 4096)
                if not data:
                    continue
                if fd == master:
                    # App -> UART (TX)
                    os.write(uart_fd, data)
                    log_data(0, data)  # 0 = TX
                    sys.stderr.write(f"TX({len(data)}): {data[:32].hex()}\n")
                    sys.stderr.flush()
                else:
                    # UART -> App (RX)
                    os.write(master, data)
                    log_data(1, data)  # 1 = RX
                    sys.stderr.write(f"RX({len(data)}): {data[:32].hex()}\n")
                    sys.stderr.flush()
    except KeyboardInterrupt:
        pass
    finally:
        os.close(master)
        os.close(slave)
        os.close(uart_fd)
        log.close()

if __name__ == "__main__":
    main()
