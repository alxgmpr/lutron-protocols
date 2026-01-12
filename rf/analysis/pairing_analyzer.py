#!/usr/bin/env python3
"""
Pairing Capture Analyzer

Analyzes RF capture logs to identify bridge <-> dimmer pairing handshakes.
Uses RSSI levels to distinguish between devices and timing to identify exchanges.

Usage:
    python3 pairing_analyzer.py <capture.log>
    python3 pairing_analyzer.py <capture.log> --rssi-threshold -60
    python3 pairing_analyzer.py <capture.log> --pairing-only
    python3 pairing_analyzer.py <capture.log> --timeline
"""

import argparse
import re
import sys
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
from collections import defaultdict
from datetime import datetime, timedelta

# Pairing-related packet types
PAIRING_TYPES = {
    0x91: "BEACON",
    0x92: "BEACON_STOP",
    0x93: "BEACON_93",
    0xB0: "PAIR_B0",
    0xB8: "PAIR_B8",
    0xB9: "PAIR_B9",
    0xBA: "PAIR_BA",
    0xBB: "PAIR_BB",
    0xC0: "PAIR_RESP_C0",
    0xC1: "PAIR_RESP_C1",
    0xC2: "PAIR_RESP_C2",
    0xC8: "PAIR_RESP_C8",
}

# All known packet types for context
PACKET_TYPES = {
    0x81: "STATE_RPT",
    0x82: "STATE_RPT",
    0x83: "STATE_RPT",
    0x88: "BTN_SHORT_A",
    0x89: "BTN_LONG_A",
    0x8A: "BTN_SHORT_B",
    0x8B: "BTN_LONG_B",
    0xA2: "SET_LEVEL",
    0xA3: "LED_CONFIG",
    **PAIRING_TYPES
}


@dataclass
class Packet:
    timestamp: str
    time_ms: float  # milliseconds from start
    packet_type: int
    type_name: str
    device_id: str
    sequence: int
    rssi: int
    raw_bytes: str
    fields: dict = field(default_factory=dict)

    @property
    def is_pairing(self) -> bool:
        return self.packet_type in PAIRING_TYPES


@dataclass
class DeviceCluster:
    """Group of packets from same device based on RSSI"""
    rssi_range: tuple  # (min, max)
    avg_rssi: float
    packet_count: int
    device_ids: set
    packet_types: set
    label: str = ""  # "bridge", "dimmer", "unknown"


def parse_timestamp(ts_str: str) -> Optional[datetime]:
    """Parse ESPHome log timestamp."""
    # Format: [HH:MM:SS] or [HH:MM:SS.mmm]
    match = re.match(r'\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?\]', ts_str)
    if match:
        h, m, s = int(match.group(1)), int(match.group(2)), int(match.group(3))
        ms = int(match.group(4)) if match.group(4) else 0
        return datetime(2000, 1, 1, h, m, s, ms * 1000)
    return None


def parse_log_line(line: str, start_time: Optional[datetime] = None) -> Optional[Packet]:
    """Parse a single log line into a Packet."""
    # Look for RX packet lines
    # Format: [HH:MM:SS][D][lutron_cc1101:XXX]: RX: TYPE | Device: ID | ... | RSSI: -XX

    if "RX:" not in line:
        return None

    # Extract timestamp
    ts_match = re.match(r'(\[\d{2}:\d{2}:\d{2}(?:\.\d{3})?\])', line)
    if not ts_match:
        return None
    timestamp = ts_match.group(1)
    ts = parse_timestamp(timestamp)

    # Calculate time from start
    time_ms = 0.0
    if ts and start_time:
        delta = ts - start_time
        time_ms = delta.total_seconds() * 1000

    # Extract packet type
    type_match = re.search(r'RX: (\w+)', line)
    if not type_match:
        return None
    type_name = type_match.group(1)

    # Find type code from name or raw bytes
    packet_type = 0
    for code, name in PACKET_TYPES.items():
        if name == type_name:
            packet_type = code
            break

    # Extract device ID
    device_match = re.search(r'Device:\s*([0-9A-Fa-f]+)', line)
    device_id = device_match.group(1).upper() if device_match else "UNKNOWN"

    # Extract sequence
    seq_match = re.search(r'Seq:\s*(\d+)', line)
    sequence = int(seq_match.group(1)) if seq_match else 0

    # Extract RSSI
    rssi_match = re.search(r'RSSI:\s*(-?\d+)', line)
    rssi = int(rssi_match.group(1)) if rssi_match else -100

    # Extract raw bytes if present
    raw_match = re.search(r'Raw:\s*([0-9A-Fa-f\s]+)', line)
    raw_bytes = raw_match.group(1).strip() if raw_match else ""

    # If we couldn't find type from name, try from raw bytes
    if packet_type == 0 and raw_bytes:
        first_byte = raw_bytes.split()[0] if raw_bytes else ""
        if first_byte:
            packet_type = int(first_byte, 16)
            type_name = PACKET_TYPES.get(packet_type, f"0x{packet_type:02X}")

    return Packet(
        timestamp=timestamp,
        time_ms=time_ms,
        packet_type=packet_type,
        type_name=type_name,
        device_id=device_id,
        sequence=sequence,
        rssi=rssi,
        raw_bytes=raw_bytes
    )


def parse_log_file(path: Path) -> list[Packet]:
    """Parse entire log file into packets."""
    packets = []
    start_time = None

    with open(path) as f:
        for line in f:
            if start_time is None:
                ts_match = re.match(r'(\[\d{2}:\d{2}:\d{2}(?:\.\d{3})?\])', line)
                if ts_match:
                    start_time = parse_timestamp(ts_match.group(1))

            pkt = parse_log_line(line, start_time)
            if pkt:
                packets.append(pkt)

    return packets


def cluster_by_rssi(packets: list[Packet], threshold: int = 10) -> list[DeviceCluster]:
    """Cluster packets by RSSI to identify different transmitters."""
    if not packets:
        return []

    # Group by RSSI buckets
    rssi_groups = defaultdict(list)
    for pkt in packets:
        # Round RSSI to nearest 5 dB
        bucket = (pkt.rssi // 5) * 5
        rssi_groups[bucket].append(pkt)

    # Build clusters
    clusters = []
    for bucket, pkts in sorted(rssi_groups.items(), reverse=True):
        device_ids = set(p.device_id for p in pkts)
        packet_types = set(p.type_name for p in pkts)
        avg_rssi = sum(p.rssi for p in pkts) / len(pkts)

        # Heuristic labeling
        label = "unknown"
        if any("BEACON" in t for t in packet_types):
            label = "bridge (beacon source)"
        elif any("STATE_RPT" in t for t in packet_types):
            label = "dimmer (state reports)"
        elif any("PAIR_RESP" in t for t in packet_types):
            label = "dimmer (pair response)"
        elif any(t.startswith("PAIR_B") for t in packet_types):
            label = "pico/remote (pair request)"

        clusters.append(DeviceCluster(
            rssi_range=(min(p.rssi for p in pkts), max(p.rssi for p in pkts)),
            avg_rssi=avg_rssi,
            packet_count=len(pkts),
            device_ids=device_ids,
            packet_types=packet_types,
            label=label
        ))

    return clusters


def print_timeline(packets: list[Packet], pairing_only: bool = False):
    """Print timeline of packets."""
    print("\n" + "=" * 80)
    print("TIMELINE")
    print("=" * 80)
    print(f"{'Time':>10}  {'RSSI':>5}  {'Type':<15}  {'Device':<10}  {'Seq':>4}  Notes")
    print("-" * 80)

    for pkt in packets:
        if pairing_only and not pkt.is_pairing:
            continue

        # Color coding for terminal
        color = ""
        reset = "\033[0m"
        if pkt.is_pairing:
            if "BEACON" in pkt.type_name:
                color = "\033[33m"  # Yellow
            elif "RESP" in pkt.type_name:
                color = "\033[32m"  # Green
            else:
                color = "\033[36m"  # Cyan

        time_str = f"{pkt.time_ms/1000:.3f}s" if pkt.time_ms else pkt.timestamp

        notes = ""
        if pkt.packet_type in [0xB9, 0xBB]:
            notes = "PAIRING REQUEST"
        elif pkt.packet_type in [0xC0, 0xC1, 0xC2, 0xC8]:
            notes = "PAIRING RESPONSE"
        elif "BEACON" in pkt.type_name:
            notes = "bridge beacon"

        print(f"{color}{time_str:>10}  {pkt.rssi:>5}  {pkt.type_name:<15}  {pkt.device_id:<10}  {pkt.sequence:>4}  {notes}{reset}")


def print_rssi_analysis(packets: list[Packet]):
    """Analyze RSSI distribution to identify devices."""
    print("\n" + "=" * 80)
    print("RSSI ANALYSIS (Device Identification)")
    print("=" * 80)

    clusters = cluster_by_rssi(packets)

    for i, cluster in enumerate(clusters):
        print(f"\nCluster {i+1}: RSSI {cluster.rssi_range[0]} to {cluster.rssi_range[1]} dB (avg: {cluster.avg_rssi:.1f})")
        print(f"  Packets: {cluster.packet_count}")
        print(f"  Device IDs: {', '.join(sorted(cluster.device_ids)[:5])}" +
              (f" (+{len(cluster.device_ids)-5} more)" if len(cluster.device_ids) > 5 else ""))
        print(f"  Packet types: {', '.join(sorted(cluster.packet_types))}")
        print(f"  Likely: {cluster.label}")


def print_pairing_summary(packets: list[Packet]):
    """Summarize pairing-related packets."""
    print("\n" + "=" * 80)
    print("PAIRING PACKET SUMMARY")
    print("=" * 80)

    pairing_pkts = [p for p in packets if p.is_pairing]

    if not pairing_pkts:
        print("\nNo pairing packets found in capture.")
        return

    # Group by type
    by_type = defaultdict(list)
    for pkt in pairing_pkts:
        by_type[pkt.type_name].append(pkt)

    print(f"\nTotal pairing packets: {len(pairing_pkts)}")
    print("\nBy type:")
    for type_name, pkts in sorted(by_type.items()):
        device_ids = set(p.device_id for p in pkts)
        rssi_range = f"{min(p.rssi for p in pkts)} to {max(p.rssi for p in pkts)}"
        print(f"  {type_name}: {len(pkts)} packets, RSSI {rssi_range}, devices: {', '.join(sorted(device_ids)[:3])}")

    # Identify handshake pairs
    print("\nPotential handshake sequences:")

    # Look for B9/BB followed by C0/C1/C2/C8 within 500ms
    requests = [p for p in pairing_pkts if p.packet_type in [0xB9, 0xBB]]
    responses = [p for p in pairing_pkts if p.packet_type in [0xC0, 0xC1, 0xC2, 0xC8]]

    for req in requests:
        for resp in responses:
            delta_ms = resp.time_ms - req.time_ms
            if 0 < delta_ms < 500:  # Response within 500ms
                print(f"  {req.type_name} ({req.device_id}, RSSI {req.rssi}) -> "
                      f"{resp.type_name} ({resp.device_id}, RSSI {resp.rssi}) "
                      f"[+{delta_ms:.0f}ms]")


def main():
    parser = argparse.ArgumentParser(description="Analyze pairing capture logs")
    parser.add_argument("log_file", type=Path, help="Path to .log file")
    parser.add_argument("--pairing-only", "-p", action="store_true",
                        help="Show only pairing-related packets")
    parser.add_argument("--timeline", "-t", action="store_true",
                        help="Show packet timeline")
    parser.add_argument("--rssi", "-r", action="store_true",
                        help="Show RSSI analysis")
    parser.add_argument("--all", "-a", action="store_true",
                        help="Show all analysis")
    args = parser.parse_args()

    if not args.log_file.exists():
        print(f"Error: File not found: {args.log_file}")
        return 1

    print(f"Parsing {args.log_file}...")
    packets = parse_log_file(args.log_file)
    print(f"Found {len(packets)} RX packets")

    pairing_count = sum(1 for p in packets if p.is_pairing)
    print(f"Pairing-related: {pairing_count}")

    # Default to showing summary if no specific option
    show_all = args.all or not (args.timeline or args.rssi)

    if show_all or args.rssi:
        print_rssi_analysis(packets)

    if show_all:
        print_pairing_summary(packets)

    if args.timeline or args.all:
        print_timeline(packets, args.pairing_only)

    return 0


if __name__ == "__main__":
    sys.exit(main())
