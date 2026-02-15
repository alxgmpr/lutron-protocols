#!/usr/bin/env python3
"""Automated CCA tune benchmark runner for the STM32 shell.

This drives `cca tune` commands over the shell serial port, asks the user to
press Pico traffic during fixed windows, and captures status/score output for
all scenarios in one run.

Example:
  python3 tools/cca-tune-bench.py --duration 45
  python3 tools/cca-tune-bench.py --port /dev/cu.usbmodem11103 --duration 60
"""

from __future__ import annotations

import argparse
import dataclasses
import glob
import os
import re
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import serial
from serial.serialutil import SerialException
from serial.tools import list_ports


DEFAULT_BASE_COMMANDS = [
    "cca tune profile noisy",
    "cca tune param set fifothr 7",
    "cca tune param set miss_streak 8",
    "cca tune param set miss_ring 16",
    "cca tune param set timeout_ms 12",
    "cca tune param set max_packets 10",
    "cca tune param set drain_passes 12",
]

DEFAULT_SCENARIOS: List[Tuple[str, str]] = [
    ("iocfg0_06", "0x06"),
    ("iocfg0_46", "0x46"),
]


@dataclasses.dataclass
class ScenarioResult:
    name: str
    iocfg0: str
    raw_lines: List[str]
    status: Dict[str, float]
    score: Dict[str, float]


class SerialShell:
    def __init__(self, port: str, baud: int, echo: bool = True):
        self.port = port
        self.baud = baud
        self.echo = echo
        self.ser = serial.Serial(port, baudrate=baud, timeout=0.1)
        self._lock = threading.Lock()
        self._lines: List[Tuple[float, str]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)
        self.ser.close()

    def _reader(self) -> None:
        buf = ""
        while not self._stop.is_set():
            try:
                chunk = self.ser.read(self.ser.in_waiting or 1)
            except Exception:
                break
            if not chunk:
                continue
            text = chunk.decode("utf-8", errors="ignore")
            buf += text
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.replace("\r", "")
                ts = time.time()
                with self._lock:
                    self._lines.append((ts, line))
                if self.echo:
                    print(line)

    def send(self, cmd: str, delay_s: float = 0.25) -> None:
        print(f"\\n>>> {cmd}")
        self.ser.write((cmd + "\r\n").encode("utf-8"))
        self.ser.flush()
        time.sleep(delay_s)

    def send_checked(
        self,
        cmd: str,
        expect_any: List[str],
        timeout_s: float = 2.0,
        retries: int = 3,
        char_delay_s: float = 0.0015,
    ) -> bool:
        for attempt in range(1, retries + 1):
            # Cancel any partial line in shell editor first.
            self.ser.write(b"\x03")
            self.ser.flush()
            time.sleep(0.05)

            mark = self.mark()
            print(f"\\n>>> {cmd}  (attempt {attempt}/{retries})")

            # Slow-send to avoid dropped chars under async log contention.
            for ch in (cmd + "\r\n"):
                self.ser.write(ch.encode("utf-8"))
                self.ser.flush()
                time.sleep(char_delay_s)

            deadline = time.time() + timeout_s
            while time.time() < deadline:
                text = "\n".join(self.lines_since(mark))
                if any(tok in text for tok in expect_any):
                    return True
                if "Unknown command:" in text:
                    break
                time.sleep(0.05)

            print(f"  warning: no expected response for '{cmd}'")
        return False

    def mark(self) -> int:
        with self._lock:
            return len(self._lines)

    def lines_since(self, mark: int) -> List[str]:
        with self._lock:
            return [ln for _, ln in self._lines[mark:]]


def auto_port() -> Optional[str]:
    ports = list(list_ports.comports())

    # Prefer STLINK VCP first.
    for p in ports:
        desc = (p.description or "").lower()
        dev = (p.device or "").lower()
        if "stlink" in desc or "st-link" in desc:
            return p.device
        if "usbmodem" in dev and "bluetooth" not in dev:
            return p.device

    # Fallback by common device patterns.
    for pat in ("/dev/cu.usbmodem*", "/dev/ttyACM*", "COM*"):
        matches = sorted(glob.glob(pat))
        if matches:
            return matches[0]
    return None


def parse_scenarios(text: str) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    for raw in text.split(","):
        item = raw.strip()
        if not item:
            continue
        if "=" in item:
            name, val = item.split("=", 1)
            out.append((name.strip(), val.strip()))
        else:
            safe = item.lower().replace("0x", "")
            out.append((f"iocfg0_{safe}", item))
    return out


def wait_with_countdown(seconds: int, label: str) -> None:
    print(f"\\n*** PRESS PICO NOW: {label} ({seconds}s window) ***")
    print("\a", end="", flush=True)
    end = time.time() + seconds
    last_shown = -1
    while True:
        remain = int(end - time.time())
        if remain < 0:
            break
        if remain != last_shown and (remain % 5 == 0 or remain <= 3):
            print(f"  {label}: {remain}s remaining")
            last_shown = remain
        time.sleep(0.2)


def extract_last_block(lines: List[str], header: str) -> List[str]:
    idx = -1
    for i, ln in enumerate(lines):
        if header in ln:
            idx = i
    if idx < 0:
        return []
    return lines[idx : idx + 12]


def last_match_float(text: str, pattern: str) -> Optional[float]:
    matches = re.findall(pattern, text)
    if not matches:
        return None
    val = matches[-1]
    if isinstance(val, tuple):
        if not val:
            return None
        val = val[0]
    try:
        return float(val)
    except Exception:
        return None


def parse_status(lines: List[str]) -> Dict[str, float]:
    text = "\n".join(lines)
    out: Dict[str, float] = {}

    pats = {
        "rx": r"CCA \(ISM\):\s+\w+\s+RX=(\d+)",
        "drops": r"drops=(\d+)",
        "crc_fail": r"crc_fail=(\d+)",
        "n81_err": r"n81_err=(\d+)",
        "ack": r"ack=(\d+)",
        "overflows": r"overflows=(\d+)",
        "short": r"short=(\d+)",
        "irq": r"irq=(\d+)",
        "exti_gdo0": r"exti:\s+gdo0=(\d+)",
        "exti_gdo2": r"exti:\s+gdo0=\d+\s+gdo2=(\d+)",
        "sync_hit": r"sync:\s+hit=(\d+)",
        "sync_miss": r"sync:\s+hit=\d+\s+miss=(\d+)",
    }
    for k, pat in pats.items():
        v = last_match_float(text, pat)
        if v is not None:
            out[k] = v

    if out.get("sync_hit", 0) + out.get("sync_miss", 0) > 0:
        total = out["sync_hit"] + out["sync_miss"]
        out["sync_hit_rate_pct"] = (out["sync_hit"] * 100.0) / total

    return out


def parse_score(lines: List[str]) -> Dict[str, float]:
    text = "\n".join(lines)
    out: Dict[str, float] = {}

    patterns = {
        "window_ms": r"CCA tune score window:\s+(\d+)\s+ms",
        "delta_rx": r"delta:\s+rx=(\d+)",
        "delta_drop": r"delta:\s+rx=\d+\s+ack=\d+\s+drop=(\d+)",
        "delta_crc_fail": r"crc_fail=(\d+)",
        "delta_n81": r"n81=(\d+)",
        "sync_hit": r"sync:\s+hit=(\d+)",
        "sync_miss": r"sync:\s+hit=\d+\s+miss=(\d+)",
        "sync_hit_rate_pct": r"hit_rate=([0-9]+(?:\.[0-9]+)?)%",
        "irq": r"irq=(\d+)",
        "rx_rate_per_min": r"rx_rate=(\d+)/min",
        "quality_pct": r"quality:\s+(\d+)%",
        "net_score": r"net_score=(-?\d+)",
    }

    for key, pat in patterns.items():
        v = last_match_float(text, pat)
        if v is not None:
            out[key] = v

    return out


def summarize(results: List[ScenarioResult]) -> None:
    print("\n==================== BENCH SUMMARY ====================")
    print("name        iocfg0  quality  net_score  rx/min  sync_hit%  irq exti0 exti2  drops  crc")
    ranked = sorted(
        results,
        key=lambda r: (
            r.score.get("quality_pct", -1),
            r.score.get("net_score", -1),
            r.score.get("rx_rate_per_min", -1),
        ),
        reverse=True,
    )
    for r in ranked:
        print(
            f"{r.name:<11} {r.iocfg0:<6} "
            f"{int(r.score.get('quality_pct', -1)):>7}% "
            f"{int(r.score.get('net_score', -999999)):>10} "
            f"{int(r.score.get('rx_rate_per_min', -1)):>7} "
            f"{r.score.get('sync_hit_rate_pct', -1):>9.1f} "
            f"{int(r.score.get('irq', -1)):>4} "
            f"{int(r.status.get('exti_gdo0', -1)):>5} "
            f"{int(r.status.get('exti_gdo2', -1)):>5} "
            f"{int(r.score.get('delta_drop', -1)):>6} "
            f"{int(r.score.get('delta_crc_fail', -1)):>4}"
        )

    best = ranked[0] if ranked else None
    if best:
        print("-------------------------------------------------------")
        print(
            f"BEST: {best.name} ({best.iocfg0}) "
            f"quality={best.score.get('quality_pct', 0):.0f}% "
            f"net_score={best.score.get('net_score', 0):.0f} "
            f"irq={best.score.get('irq', 0):.0f}"
        )

    if ranked:
        all_irq_zero = all(int(r.score.get("irq", 0)) == 0 for r in ranked)
        all_exti_zero = all(
            (int(r.status.get("exti_gdo0", 0)) + int(r.status.get("exti_gdo2", 0))) == 0
            for r in ranked
        )
        if all_irq_zero and all_exti_zero:
            print("WARN: irq=0 for all scenarios (EXTI path appears inactive).")
            print("      Verify CC1101 GDO wiring matches firmware pin map in firmware/src/bsp/bsp.h.")
        elif all_irq_zero:
            print("NOTE: irq delta is 0 but EXTI counters are non-zero.")
            print("      This usually means IRQ edges occurred before score baseline reset.")


def save_logs(results: List[ScenarioResult], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"cca_tune_bench_{ts}.log"
    with out_path.open("w", encoding="utf-8") as f:
        for r in results:
            f.write(f"## {r.name} ({r.iocfg0})\n")
            for ln in r.raw_lines:
                f.write(ln + "\n")
            f.write("\n")
    return out_path


def main() -> int:
    ap = argparse.ArgumentParser(description="Automated CCA tune benchmark runner")
    ap.add_argument("--port", help="Serial port (default: auto-detect STLINK VCP)")
    ap.add_argument("--baud", type=int, default=115200, help="Shell baud rate (default 115200)")
    ap.add_argument("--duration", type=int, default=45, help="Press window per scenario in seconds")
    ap.add_argument(
        "--scenarios",
        default=",".join([f"{n}={v}" for n, v in DEFAULT_SCENARIOS]),
        help="Comma list: name=0x06,name2=0x46 (default IOCFG0 sweep)",
    )
    ap.add_argument(
        "--echo-serial",
        action="store_true",
        help="Print all serial lines while running",
    )
    ap.add_argument(
        "--skip-base-commands",
        action="store_true",
        help="Do not apply default tune/profile commands before scenarios",
    )
    ap.add_argument(
        "--log-dir",
        default="captures/cca-tune-bench",
        help="Output directory for raw run logs",
    )
    args = ap.parse_args()

    port = args.port or auto_port()
    if not port:
        print("No serial port found. Pass --port explicitly.", file=sys.stderr)
        return 2

    scenarios = parse_scenarios(args.scenarios)
    if not scenarios:
        print("No scenarios parsed", file=sys.stderr)
        return 2

    print(f"Using serial port: {port} @ {args.baud}")
    print("Scenarios:")
    for name, val in scenarios:
        print(f"  - {name}: IOCFG0={val}")

    try:
        shell = SerialShell(port=port, baud=args.baud, echo=args.echo_serial)
    except SerialException as exc:
        print(f"Failed to open serial port {port}: {exc}", file=sys.stderr)
        print("Close any existing serial monitor (screen/miniterm/IDE terminal) and retry.", file=sys.stderr)
        print("You can also pass an explicit port with --port.", file=sys.stderr)
        return 3
    results: List[ScenarioResult] = []

    try:
        # Let boot logs settle.
        time.sleep(1.0)

        # Base tuning setup.
        if not args.skip_base_commands:
            for cmd in DEFAULT_BASE_COMMANDS:
                ok = shell.send_checked(
                    cmd,
                    expect_any=["Set ", "Applied CCA tune profile", "CCA tune params:"],
                    timeout_s=2.5,
                    retries=4,
                )
                if not ok:
                    print(f"Failed to apply base command: {cmd}", file=sys.stderr)
                    return 4

        for idx, (name, iocfg) in enumerate(scenarios, start=1):
            print(f"\n========== [{idx}/{len(scenarios)}] {name} IOCFG0={iocfg} ==========")
            start_mark = shell.mark()

            if not shell.send_checked(
                f"cca tune reg set 0x02 {iocfg}",
                expect_any=["CC1101 reg[0x02] <="],
                timeout_s=2.5,
                retries=5,
            ):
                print(f"Scenario {name}: failed to set IOCFG0={iocfg}", file=sys.stderr)
                continue

            if not shell.send_checked(
                "cca tune stats reset",
                expect_any=["CCA tune telemetry counters reset"],
                timeout_s=2.5,
                retries=5,
            ):
                print(f"Scenario {name}: failed stats reset", file=sys.stderr)
                continue

            if not shell.send_checked(
                "cca tune score reset",
                expect_any=["CCA tune score baseline reset"],
                timeout_s=2.5,
                retries=5,
            ):
                print(f"Scenario {name}: failed score reset", file=sys.stderr)
                continue

            wait_with_countdown(args.duration, name)

            if not shell.send_checked(
                "status",
                expect_any=["--- Nucleo Firmware Status ---"],
                timeout_s=3.0,
                retries=5,
            ):
                print(f"Scenario {name}: status query failed", file=sys.stderr)
                continue

            if not shell.send_checked(
                "cca tune score",
                expect_any=["CCA tune score window:"],
                timeout_s=3.5,
                retries=5,
            ):
                print(f"Scenario {name}: score query failed", file=sys.stderr)
                continue

            # Allow trailing lines to arrive.
            time.sleep(0.8)
            lines = shell.lines_since(start_mark)

            status_block = extract_last_block(lines, "--- Nucleo Firmware Status ---")
            score_block = extract_last_block(lines, "CCA tune score window:")
            status_metrics = parse_status(status_block)
            score_metrics = parse_score(score_block)

            result = ScenarioResult(
                name=name,
                iocfg0=iocfg,
                raw_lines=lines,
                status=status_metrics,
                score=score_metrics,
            )
            results.append(result)

            print(f"Result {name}: quality={score_metrics.get('quality_pct', -1):.0f}% "
                  f"net={score_metrics.get('net_score', -999999):.0f} "
                  f"rx/min={score_metrics.get('rx_rate_per_min', -1):.0f} "
                  f"irq={score_metrics.get('irq', -1):.0f} "
                  f"sync_hit%={score_metrics.get('sync_hit_rate_pct', -1):.1f}")

        summarize(results)
        log_path = save_logs(results, Path(args.log_dir))
        print(f"\nRaw run log saved: {log_path}")

    finally:
        shell.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
