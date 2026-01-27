#!/usr/bin/env python3
"""
RF Capture Tool - Captures RTL-SDR and ESPHome logs simultaneously.

Usage:
    python3 capture.py <name>           # Capture with ESPHome logs (RTL-SDR if available)
    python3 capture.py <name> --no-sdr  # ESPHome logs only
    python3 capture.py <name> --no-logs # RTL-SDR only (no ESPHome)
    python3 capture.py <name> --quiet   # Don't stream logs to terminal

Press Ctrl+C to stop capturing.

Output files are saved to rf/captures/:
    <name>.cu8  - RTL-SDR IQ data
    <name>.log  - ESPHome logs
"""

import argparse
import subprocess
import sys
import os
import threading
import time
import re
from pathlib import Path
from datetime import datetime

CAPTURES_DIR = Path(__file__).parent / "captures"
ESPHOME_YAML = Path(__file__).parent / "esphome" / "pico-proxy-cc1101.yaml"
ESP_DEVICE = "pico-trigger.local"
RTL_FREQ = 433602844
RTL_SAMPLE_RATE = 2000000
RTL_GAIN = 40


class CaptureStats:
    def __init__(self):
        self.rx_count = 0
        self.log_lines = 0
        self.sdr_bytes = 0
        self.last_packet = ""


def check_rtl_sdr():
    """Check if RTL-SDR device is connected."""
    try:
        result = subprocess.run(
            ["rtl_test", "-t"],
            capture_output=True,
            timeout=5
        )
        if b"No supported devices found" in result.stderr:
            return False, "No RTL-SDR device found"
        if b"Found" in result.stderr:
            return True, "RTL-SDR ready"
        return False, "RTL-SDR check failed"
    except FileNotFoundError:
        return False, "rtl_test not installed"
    except subprocess.TimeoutExpired:
        return False, "RTL-SDR check timed out"


def check_esphome():
    """Check if ESPHome device is reachable."""
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", "2", ESP_DEVICE],
            capture_output=True,
            timeout=5
        )
        return result.returncode == 0, ESP_DEVICE
    except:
        return False, "ping failed"


def stream_esphome_logs(yaml_path, device, log_file, stats, quiet=False):
    """Stream ESPHome logs to file and optionally terminal."""
    try:
        proc = subprocess.Popen(
            ["esphome", "logs", str(yaml_path), "--device", device],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )

        for line in proc.stdout:
            # Write to file
            log_file.write(line)
            log_file.flush()
            stats.log_lines += 1

            # Count RX packets
            if "RX:" in line:
                stats.rx_count += 1
                # Extract packet type for display
                match = re.search(r'RX: (\S+)', line)
                if match:
                    stats.last_packet = match.group(1)

            # Stream to terminal if not quiet
            if not quiet:
                # Color code based on content
                if "RX:" in line:
                    sys.stdout.write(f"\033[32m{line}\033[0m")  # Green for RX
                elif "TX:" in line:
                    sys.stdout.write(f"\033[36m{line}\033[0m")  # Cyan for TX
                elif "ERROR" in line or "error" in line:
                    sys.stdout.write(f"\033[31m{line}\033[0m")  # Red for errors
                elif "WARNING" in line or "warning" in line:
                    sys.stdout.write(f"\033[33m{line}\033[0m")  # Yellow for warnings
                else:
                    sys.stdout.write(line)
                sys.stdout.flush()

        proc.wait()
        return proc.returncode
    except Exception as e:
        print(f"\n[LOG] Error: {e}", file=sys.stderr)
        return -1


def run_rtl_sdr(cu8_path, stats, stop_event):
    """Run RTL-SDR capture in background."""
    try:
        proc = subprocess.Popen(
            ["rtl_sdr", "-f", str(RTL_FREQ), "-s", str(RTL_SAMPLE_RATE),
             "-g", str(RTL_GAIN), str(cu8_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

        # Monitor file size
        while not stop_event.is_set():
            if cu8_path.exists():
                stats.sdr_bytes = cu8_path.stat().st_size
            time.sleep(0.5)

        proc.terminate()
        proc.wait(timeout=3)
    except Exception as e:
        print(f"\n[SDR] Error: {e}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description="Capture RF signals and ESPHome logs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Press Ctrl+C to stop capturing."
    )
    parser.add_argument("name", help="Name for capture files")
    parser.add_argument("--no-sdr", action="store_true", help="Skip RTL-SDR capture")
    parser.add_argument("--no-logs", action="store_true", help="Skip ESPHome logs")
    parser.add_argument("--quiet", "-q", action="store_true", help="Don't stream logs to terminal")
    parser.add_argument("--duration", "-d", type=int, default=0,
                        help="Auto-stop after N seconds (0=manual)")
    args = parser.parse_args()

    CAPTURES_DIR.mkdir(exist_ok=True)
    cu8_path = CAPTURES_DIR / f"{args.name}.cu8"
    log_path = CAPTURES_DIR / f"{args.name}.log"

    stats = CaptureStats()
    stop_event = threading.Event()
    threads = []

    print(f"\n{'='*50}")
    print(f"  RF Capture: {args.name}")
    print(f"  Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*50}\n")

    # Check devices
    if not args.no_sdr:
        sdr_ok, sdr_msg = check_rtl_sdr()
        if sdr_ok:
            print(f"[SDR] {sdr_msg}")
        else:
            print(f"[SDR] {sdr_msg} - skipping SDR capture")
            args.no_sdr = True

    if not args.no_logs:
        esp_ok, esp_msg = check_esphome()
        if esp_ok:
            print(f"[ESP] Found {esp_msg}")
        else:
            print(f"[ESP] Cannot reach {ESP_DEVICE} - skipping logs")
            args.no_logs = True

    if args.no_sdr and args.no_logs:
        print("\n[!] Nothing to capture. Exiting.")
        return 1

    print()

    # Start captures
    log_file = None

    try:
        # Start RTL-SDR in background thread
        if not args.no_sdr:
            print(f"[SDR] Capturing to {cu8_path.name}")
            sdr_thread = threading.Thread(
                target=run_rtl_sdr,
                args=(cu8_path, stats, stop_event)
            )
            sdr_thread.start()
            threads.append(sdr_thread)

        # Start ESPHome logs (blocking, streams to terminal)
        if not args.no_logs:
            print(f"[LOG] Streaming from {ESP_DEVICE} to {log_path.name}")
            if args.quiet:
                print("[LOG] Quiet mode - logs saved to file only")
            print()
            print("-" * 50)

            log_file = open(log_path, "w")

            if args.duration > 0:
                # Run with timeout
                log_thread = threading.Thread(
                    target=stream_esphome_logs,
                    args=(ESPHOME_YAML, ESP_DEVICE, log_file, stats, args.quiet)
                )
                log_thread.daemon = True
                log_thread.start()
                time.sleep(args.duration)
            else:
                # Run until Ctrl+C
                stream_esphome_logs(ESPHOME_YAML, ESP_DEVICE, log_file, stats, args.quiet)
        else:
            # SDR only mode
            print("\n>>> Press Ctrl+C to stop capturing <<<\n")
            if args.duration > 0:
                time.sleep(args.duration)
            else:
                while True:
                    time.sleep(1)
                    if stats.sdr_bytes > 0:
                        print(f"\r[SDR] Captured {stats.sdr_bytes/1024/1024:.1f} MB", end="")

    except KeyboardInterrupt:
        print("\n\n[!] Stopping capture...")
    finally:
        stop_event.set()

        # Wait for threads
        for t in threads:
            t.join(timeout=3)

        if log_file:
            log_file.close()

        # Results
        print()
        print("=" * 50)
        print("  Capture Complete")
        print("=" * 50)

        if not args.no_sdr and cu8_path.exists():
            size = cu8_path.stat().st_size
            if size > 0:
                print(f"  [SDR] {cu8_path.name}: {size:,} bytes ({size/1024/1024:.1f} MB)")
            else:
                print(f"  [SDR] {cu8_path.name}: empty (RTL-SDR may have failed)")

        if not args.no_logs and log_path.exists():
            lines = sum(1 for _ in open(log_path))
            print(f"  [LOG] {log_path.name}: {lines} lines, {stats.rx_count} RX packets")

        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
