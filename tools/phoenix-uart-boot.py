#!/usr/bin/env python3
"""
AM335x UART Boot Tool for Phoenix Processor

The AM335x ROM bootloader in UART boot mode sends 'CCCC...' waiting for
an XMODEM transfer of the SPL (MLO), then after SPL runs, sends 'CCCC...'
again waiting for U-Boot (u-boot.img).

Usage:
  1. Ground SYSBOOT2 (TP701) on the Phoenix board
  2. Power-cycle the processor
  3. Run: python3 tools/phoenix-uart-boot.py /dev/tty.usbserial-4240

The patched Lutron SPL loads U-Boot from eMMC normally, but shellcode
appended to the SPL scans the loaded U-Boot image in DDR for "bootdelay=0"
and patches it to "bootdelay=5" before jumping, giving us a U-Boot prompt.

After U-Boot loads, the script drops you into an interactive console.
Type:
  setenv bootargs console=ttyS0,115200n8 root=/dev/mmcblk1p16 rw init=/bin/sh
  boot

Then from the root shell:
  cat /etc/ssl/firmwareupgrade/*
"""

import sys
import os
import time

# Use the venv packages
VENV = "/tmp/xmodem-venv/lib"
for d in os.listdir(VENV):
    sp = os.path.join(VENV, d, "site-packages")
    if os.path.isdir(sp) and sp not in sys.path:
        sys.path.insert(0, sp)

import serial
import xmodem

DEFAULT_SPL = "/tmp/phoenix-boot/MLO-patched"  # Lutron SPL patched to set bootdelay=5
BAUD = 115200


def wait_for_cccc(ser, timeout=30):
    """Wait for the 'CCCC' pattern from ROM/SPL bootloader."""
    print("Waiting for CCCC pattern...", flush=True)
    buf = b""
    start = time.time()
    while time.time() - start < timeout:
        data = ser.read(ser.in_waiting or 1)
        if data:
            buf += data
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            if b"CCC" in buf[-10:]:
                print("\nGot CCCC! Starting XMODEM transfer...", flush=True)
                time.sleep(0.5)  # Let a few more C's come in
                ser.reset_input_buffer()
                return True
    print(f"\nTimeout after {timeout}s", flush=True)
    return False


def send_xmodem(ser, filepath):
    """Send a file via XMODEM-1K protocol."""
    filesize = os.path.getsize(filepath)
    print(f"Sending {os.path.basename(filepath)} ({filesize} bytes) via XMODEM...", flush=True)

    def getc(size, timeout=1):
        ser.timeout = timeout
        return ser.read(size) or None

    def putc(data, timeout=1):
        ser.write_timeout = timeout
        return ser.write(data)

    modem = xmodem.XMODEM(getc, putc)
    with open(filepath, "rb") as f:
        result = modem.send(f, retry=10)

    if result:
        print(f"  Sent {os.path.basename(filepath)} OK", flush=True)
    else:
        print(f"  FAILED to send {os.path.basename(filepath)}", flush=True)
    return result


def interactive(ser):
    """Drop into interactive serial console."""
    print("\n=== Interactive console (Ctrl+C to exit) ===\n", flush=True)
    import select
    import tty
    import termios

    old_settings = termios.tcgetattr(sys.stdin)
    try:
        tty.setraw(sys.stdin)
        ser.timeout = 0.1
        while True:
            # Read from serial
            data = ser.read(256)
            if data:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            # Read from stdin
            if select.select([sys.stdin], [], [], 0)[0]:
                ch = sys.stdin.buffer.read(1)
                if ch == b"\x03":  # Ctrl+C
                    break
                ser.write(ch)
    except KeyboardInterrupt:
        pass
    finally:
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old_settings)
        print("\nExited.", flush=True)


def main():
    args = sys.argv[1:]
    port = "/dev/tty.usbserial-4240"
    spl_path = DEFAULT_SPL

    # Parse args: [port] [--spl path]
    i = 0
    while i < len(args):
        if args[i] == "--spl" and i + 1 < len(args):
            spl_path = args[i + 1]
            i += 2
        elif not args[i].startswith("-"):
            port = args[i]
            i += 1
        else:
            i += 1

    if not os.path.exists(spl_path):
        print(f"SPL not found at {spl_path}")
        sys.exit(1)

    spl_size = os.path.getsize(spl_path)
    print(f"SPL image: {spl_path} ({spl_size} bytes)")

    print(f"Opening {port} @ {BAUD}")
    ser = serial.Serial(port, BAUD, timeout=1)
    ser.reset_input_buffer()

    print("Power-cycle the Phoenix processor now (with SYSBOOT2/TP701 grounded)")
    print()

    # Stage 1: ROM bootloader wants SPL via XMODEM
    if not wait_for_cccc(ser, timeout=60):
        print("Never got CCCC from ROM. Check SYSBOOT pin and power cycle.")
        ser.close()
        sys.exit(1)

    if not send_xmodem(ser, spl_path):
        print("SPL transfer failed")
        ser.close()
        sys.exit(1)

    # The patched SPL loads U-Boot from eMMC, patches bootdelay=0 to
    # bootdelay=5 in RAM, then jumps to U-Boot. No second XMODEM stage.
    print("SPL sent. Waiting for SPL init + U-Boot load...")
    print("(Shellcode patches bootdelay=0 -> bootdelay=5 before jumping to U-Boot)")
    print()

    # Blind mode: SPL serial output is broken after XMODEM, but U-Boot
    # might reinitialize UART successfully. Spam Enter to catch autoboot.
    blind = "--blind" in sys.argv

    if blind:
        print("=== BLIND MODE: spamming Enter to catch U-Boot prompt ===")
        print("Waiting 8s for SPL to finish DDR init + load U-Boot...")
        # Drain any output during SPL init
        ser.timeout = 0.1
        start = time.time()
        while time.time() - start < 8:
            data = ser.read(ser.in_waiting or 1)
            if data:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()

        # Spam Enter for 10 seconds to interrupt autoboot
        print("Spamming Enter to interrupt autoboot...", flush=True)
        start = time.time()
        buf = b""
        while time.time() - start < 10:
            ser.write(b"\n")
            time.sleep(0.2)
            data = ser.read(ser.in_waiting or 1)
            if data:
                buf += data
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
                if b"=>" in buf or b"U-Boot>" in buf or b"#" in buf:
                    print("\n*** GOT PROMPT! ***", flush=True)
                    break

        if buf:
            print(f"\nReceived {len(buf)} bytes during blind mode", flush=True)
        else:
            print("\nNo response. U-Boot may not have started.", flush=True)
            print("Dropping to interactive console anyway...", flush=True)
    else:
        time.sleep(3)
        # Monitor for output
        ser.timeout = 0.5
        buf = b""
        start = time.time()
        while time.time() - start < 15:
            data = ser.read(ser.in_waiting or 1)
            if data:
                buf += data
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
                if b"Hit any key" in buf or b"U-Boot>" in buf or b"=>" in buf:
                    print("\n*** U-Boot prompt detected! ***", flush=True)
                    ser.write(b"\n")
                    time.sleep(0.5)
                    break

    interactive(ser)
    ser.close()


if __name__ == "__main__":
    main()
