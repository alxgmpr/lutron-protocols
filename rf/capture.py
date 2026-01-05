#!/usr/bin/env python3
"""
RF Capture Tool - Captures RTL-SDR and ESPHome logs simultaneously.

Usage:
    python3 capture.py <name>           # Start capture with given name
    python3 capture.py <name> --no-sdr  # ESPHome logs only (no RTL-SDR)
    python3 capture.py <name> --no-logs # RTL-SDR only (no ESPHome logs)

Press Enter to stop capturing.

Output files are saved to rf/captures/:
    <name>.cu8  - RTL-SDR IQ data
    <name>.log  - ESPHome logs
"""

import argparse
import subprocess
import signal
import sys
import os
from pathlib import Path
from datetime import datetime

CAPTURES_DIR = Path(__file__).parent / "captures"
ESPHOME_YAML = Path(__file__).parent / "esphome" / "pico-proxy-cc1101.yaml"
ESP_DEVICE = "pico-trigger.local"
RTL_FREQ = 433602844
RTL_SAMPLE_RATE = 2000000
RTL_GAIN = 40


def main():
    parser = argparse.ArgumentParser(description="Capture RF and ESPHome logs")
    parser.add_argument("name", help="Name for the capture files")
    parser.add_argument("--no-sdr", action="store_true", help="Skip RTL-SDR capture")
    parser.add_argument("--no-logs", action="store_true", help="Skip ESPHome logs")
    parser.add_argument("--duration", "-d", type=int, default=0,
                        help="Auto-stop after N seconds (0=manual)")
    args = parser.parse_args()

    CAPTURES_DIR.mkdir(exist_ok=True)

    cu8_path = CAPTURES_DIR / f"{args.name}.cu8"
    log_path = CAPTURES_DIR / f"{args.name}.log"

    processes = []
    log_file = None

    print(f"\n=== RF Capture: {args.name} ===")
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print()

    try:
        # Start RTL-SDR
        if not args.no_sdr:
            print(f"[SDR] Starting RTL-SDR capture -> {cu8_path.name}")
            sdr_proc = subprocess.Popen(
                ["rtl_sdr", "-f", str(RTL_FREQ), "-s", str(RTL_SAMPLE_RATE),
                 "-g", str(RTL_GAIN), str(cu8_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            processes.append(("SDR", sdr_proc))

        # Start ESPHome logs
        if not args.no_logs:
            print(f"[LOG] Starting ESPHome logs -> {log_path.name}")
            log_file = open(log_path, "w")
            log_proc = subprocess.Popen(
                ["esphome", "logs", str(ESPHOME_YAML), "--device", ESP_DEVICE],
                stdout=log_file,
                stderr=subprocess.STDOUT
            )
            processes.append(("LOG", log_proc))

        print()
        if args.duration > 0:
            print(f"Capturing for {args.duration} seconds...")
            import time
            time.sleep(args.duration)
        else:
            print(">>> Press ENTER to stop capturing <<<")
            print()
            input()

    except KeyboardInterrupt:
        print("\n[!] Interrupted")
    finally:
        # Stop all processes
        print("\nStopping captures...")
        for name, proc in processes:
            proc.terminate()
            try:
                proc.wait(timeout=3)
                print(f"[{name}] Stopped")
            except subprocess.TimeoutExpired:
                proc.kill()
                print(f"[{name}] Killed")

        if log_file:
            log_file.close()

        # Show results
        print()
        print("=== Capture Complete ===")
        if not args.no_sdr and cu8_path.exists():
            size = cu8_path.stat().st_size
            print(f"  {cu8_path.name}: {size:,} bytes ({size/1024/1024:.1f} MB)")
        if not args.no_logs and log_path.exists():
            lines = sum(1 for _ in open(log_path))
            print(f"  {log_path.name}: {lines} lines")
        print()


if __name__ == "__main__":
    main()
