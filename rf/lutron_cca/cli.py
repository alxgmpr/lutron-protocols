#!/usr/bin/env python3
"""
Lutron Clear Connect Type A RF Analysis CLI

Capture, decode, and analyze Lutron RF communications.
"""

import argparse
import sys
import os
import json
import time
import subprocess
import signal
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy import signal as scipy_signal

# Constants
SAMPLE_RATE = 2_000_000
BIT_RATE = 62_500
CENTER_FREQ = 433_602_844
SAMPLES_PER_BIT = SAMPLE_RATE / BIT_RATE

# Packet types
PKT_TYPES = {
    0x80: "LEVEL_81",
    0x81: "LEVEL_81",
    0x82: "LEVEL_82",
    0x83: "LEVEL_83",
    0x88: "BTN_SHORT_A",
    0x89: "BTN_LONG_A",
    0x8A: "BTN_SHORT_B",
    0x8B: "BTN_LONG_B",
    0xB9: "PAIRING",
}

# Button names
BUTTONS = {
    0x02: "ON",
    0x03: "FAVORITE",
    0x04: "OFF",
    0x05: "RAISE",
    0x06: "LOWER",
    # Scene Pico buttons
    0x08: "SCENE_1/BRIGHT",
    0x09: "SCENE_2/ENTERTAIN",
    0x0A: "SCENE_3/RELAX",
    0x0B: "SCENE_4/OFF",
}

# Known devices database
KNOWN_DEVICES = {}
DEVICES_FILE = Path(__file__).parent / "known_devices.json"


def load_devices():
    """Load known devices from file."""
    global KNOWN_DEVICES
    if DEVICES_FILE.exists():
        with open(DEVICES_FILE) as f:
            KNOWN_DEVICES = json.load(f)


def save_devices():
    """Save known devices to file."""
    with open(DEVICES_FILE, 'w') as f:
        json.dump(KNOWN_DEVICES, f, indent=2)


def add_device(device_id: str, name: str = None, device_type: str = None):
    """Add or update a known device."""
    if device_id not in KNOWN_DEVICES:
        KNOWN_DEVICES[device_id] = {}
    if name:
        KNOWN_DEVICES[device_id]['name'] = name
    if device_type:
        KNOWN_DEVICES[device_id]['type'] = device_type
    KNOWN_DEVICES[device_id]['last_seen'] = datetime.now().isoformat()
    save_devices()


def get_device_name(device_id: str) -> str:
    """Get friendly name for a device."""
    if device_id in KNOWN_DEVICES:
        return KNOWN_DEVICES[device_id].get('name', device_id)
    return device_id


def load_cu8(filename: str) -> np.ndarray:
    """Load IQ data from .cu8 file."""
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq


def find_transmissions(iq: np.ndarray, threshold_factor: float = 6.0, min_duration_ms: float = 3.0):
    """Find transmission bursts in IQ data."""
    mag = np.abs(iq)

    # Calculate threshold from noise floor
    noise_samples = min(50000, len(mag) // 10)
    noise_mean = np.mean(mag[:noise_samples])
    noise_std = np.std(mag[:noise_samples])
    threshold = noise_mean + threshold_factor * noise_std

    above = mag > threshold
    diff = np.diff(above.astype(int))
    starts = np.where(diff == 1)[0]
    ends = np.where(diff == -1)[0]

    if len(starts) == 0:
        return []

    if above[0]:
        starts = np.concatenate([[0], starts])
    if above[-1]:
        ends = np.concatenate([ends, [len(above) - 1]])

    # Filter by duration
    min_samples = int(min_duration_ms * SAMPLE_RATE / 1000)
    txs = []
    for start, end in zip(starts, ends):
        if end - start >= min_samples:
            txs.append((int(start), int(end)))

    return txs


def demodulate_fsk(iq: np.ndarray) -> np.ndarray:
    """Demodulate FSK to binary."""
    phase = np.unwrap(np.angle(iq))
    freq = np.diff(phase) * SAMPLE_RATE / (2 * np.pi)

    # Low-pass filter
    b, a = scipy_signal.butter(4, 80000 / (SAMPLE_RATE / 2), btype='low')
    freq_filt = scipy_signal.filtfilt(b, a, freq)

    # Threshold at median
    threshold = np.median(freq_filt)
    binary = (freq_filt > threshold).astype(int)

    return binary


def sample_bits(binary: np.ndarray) -> list:
    """Sample binary signal at bit centers."""
    bits = []
    pos = 0.0
    while pos < len(binary):
        center = int(pos + SAMPLES_PER_BIT / 2)
        if center >= len(binary):
            break
        bits.append(binary[center])
        pos += SAMPLES_PER_BIT
    return bits


def find_preamble(bits: list) -> tuple:
    """Find alternating preamble pattern. Returns (start_pos, length)."""
    best_pos, best_run = 0, 0

    for p in range(min(100, len(bits) - 16)):
        run = 0
        expected = bits[p] if p < len(bits) else 0
        for j in range(min(128, len(bits) - p)):
            if bits[p + j] == (expected + j) % 2:
                run += 1
            else:
                break
        if run > best_run:
            best_run = run
            best_pos = p

    return best_pos, best_run


def decode_n81(bits: list) -> list:
    """Decode N81 serial encoding (start=0, 8 data LSB first, stop=1)."""
    decoded = []
    pos = 0

    while pos < len(bits) - 10 and len(decoded) < 64:
        # Look for start bit (0)
        if bits[pos] == 0:
            # Read 8 data bits LSB first
            byte_val = 0
            valid = True
            for i in range(8):
                if pos + 1 + i < len(bits):
                    if bits[pos + 1 + i]:
                        byte_val |= (1 << i)
                else:
                    valid = False
                    break

            # Check stop bit (1)
            if valid and pos + 9 < len(bits) and bits[pos + 9] == 1:
                decoded.append(byte_val)
                pos += 10
            else:
                pos += 1
        else:
            pos += 1

    return decoded


def find_sync(decoded: list) -> int:
    """Find FA DE sync pattern in decoded bytes. Returns index after sync, or -1."""
    for i in range(len(decoded) - 1):
        if decoded[i] == 0xFA and decoded[i + 1] == 0xDE:
            return i + 2
    return -1


def decode_packet(iq_segment: np.ndarray) -> dict:
    """Decode a single packet from IQ segment."""
    if len(iq_segment) < 100:
        return None

    try:
        binary = demodulate_fsk(iq_segment)
        bits = sample_bits(binary)

        preamble_pos, preamble_len = find_preamble(bits)
        if preamble_len < 10:
            return None

        after_preamble = bits[preamble_pos + preamble_len:]
        decoded = decode_n81(after_preamble)

        sync_pos = find_sync(decoded)
        if sync_pos < 0:
            return None

        payload = decoded[sync_pos:]
        if len(payload) < 12:
            return None

        return parse_payload(payload)

    except Exception as e:
        return None


def parse_payload(payload: list) -> dict:
    """Parse packet payload into structured data."""
    if len(payload) < 12:
        return None

    pkt_type = payload[0]
    seq = payload[1]

    # Device ID (bytes 2-5, little-endian in our reading)
    # But Lutron uses big-endian, so we read as big-endian
    device_id = (payload[2] << 24) | (payload[3] << 16) | (payload[4] << 8) | payload[5]
    device_id_str = f"{device_id:08X}".lower()

    result = {
        'type': pkt_type,
        'type_name': PKT_TYPES.get(pkt_type, f"0x{pkt_type:02X}"),
        'seq': seq,
        'device_id': device_id_str,
        'device_name': get_device_name(device_id_str),
        'raw': payload[:min(48, len(payload))],
    }

    # Parse button packets
    if pkt_type in [0x88, 0x89, 0x8A, 0x8B]:
        result['format'] = 'short' if pkt_type in [0x88, 0x8A] else 'long'
        result['variant'] = 'A' if pkt_type in [0x88, 0x89] else 'B'
        if len(payload) > 10:
            btn = payload[10]
            result['button'] = btn
            result['button_name'] = BUTTONS.get(btn, f"0x{btn:02X}")
        if len(payload) > 7:
            result['byte7'] = payload[7]
        if len(payload) > 11:
            result['byte11'] = payload[11]

    # Parse level packets
    elif pkt_type in [0x80, 0x81, 0x82, 0x83]:
        if len(payload) > 17:
            level_high = payload[16]
            level_low = payload[17]
            level_raw = (level_high << 8) | level_low
            level_pct = round(level_raw / 65279 * 100, 1) if level_raw <= 65279 else 100
            result['level_raw'] = level_raw
            result['level_percent'] = level_pct

    # Parse pairing packets
    elif pkt_type == 0xB9:
        result['format'] = 'pairing'
        if len(payload) > 30:
            result['button'] = payload[30]
            result['button_name'] = BUTTONS.get(payload[30], f"0x{payload[30]:02X}")

    return result


def format_packet(pkt: dict, verbose: bool = False) -> str:
    """Format packet for display."""
    if pkt is None:
        return "[decode failed]"

    parts = []

    # Type
    parts.append(f"{pkt['type_name']:12s}")

    # Device
    dev_display = pkt['device_name'] if pkt['device_name'] != pkt['device_id'] else pkt['device_id']
    parts.append(f"dev={dev_display:12s}")

    # Sequence
    parts.append(f"seq={pkt['seq']:3d}")

    # Button (if present)
    if 'button_name' in pkt:
        parts.append(f"btn={pkt['button_name']}")

    # Level (if present)
    if 'level_percent' in pkt:
        parts.append(f"level={pkt['level_percent']:5.1f}%")

    # Format/variant for button packets
    if 'format' in pkt and pkt['format'] != 'pairing':
        parts.append(f"({pkt['format']}/{pkt['variant']})")

    result = " ".join(parts)

    if verbose:
        raw_hex = " ".join(f"{b:02X}" for b in pkt['raw'][:24])
        result += f"\n    raw: {raw_hex}"

    return result


def cmd_capture(args):
    """Capture RF to file."""
    duration = args.duration
    output = args.output or f"capture_{datetime.now().strftime('%Y%m%d_%H%M%S')}.cu8"

    if not output.endswith('.cu8'):
        output += '.cu8'

    print(f"Capturing {duration}s to {output}...")
    print(f"Frequency: {CENTER_FREQ / 1e6:.6f} MHz")
    print(f"Sample rate: {SAMPLE_RATE / 1e6:.1f} MS/s")
    print("Press Ctrl+C to stop early\n")

    cmd = [
        'rtl_sdr',
        '-f', str(CENTER_FREQ),
        '-s', str(SAMPLE_RATE),
        '-g', str(args.gain),
        output
    ]

    try:
        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE)
        time.sleep(duration)
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=2)
    except KeyboardInterrupt:
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=2)
    except Exception as e:
        print(f"Error: {e}")
        return 1

    if os.path.exists(output):
        size = os.path.getsize(output)
        print(f"\nCaptured {size / 1e6:.1f} MB to {output}")

    if args.decode:
        print("\nDecoding...\n")
        args.input = output
        cmd_decode(args)

    return 0


def cmd_decode(args):
    """Decode packets from capture file."""
    if not os.path.exists(args.input):
        print(f"Error: File not found: {args.input}")
        return 1

    print(f"Loading {args.input}...")
    iq = load_cu8(args.input)
    duration = len(iq) / SAMPLE_RATE
    print(f"Duration: {duration:.1f}s ({len(iq):,} samples)\n")

    txs = find_transmissions(iq)
    print(f"Found {len(txs)} transmissions\n")

    if len(txs) == 0:
        return 0

    # Track devices seen
    devices_seen = {}
    packets = []

    for i, (start, end) in enumerate(txs):
        time_s = start / SAMPLE_RATE

        # Add padding
        pad_start = max(0, start - 200)
        pad_end = min(len(iq), end + 500)
        segment = iq[pad_start:pad_end]

        pkt = decode_packet(segment)
        if pkt:
            pkt['time'] = time_s
            pkt['tx_index'] = i
            packets.append(pkt)

            # Track device
            dev_id = pkt['device_id']
            if dev_id not in devices_seen:
                devices_seen[dev_id] = {'count': 0, 'types': set()}
            devices_seen[dev_id]['count'] += 1
            devices_seen[dev_id]['types'].add(pkt['type_name'])

    print(f"Decoded {len(packets)} packets\n")

    # Show packets
    if not args.summary:
        print("=" * 80)
        for pkt in packets:
            time_str = f"[{pkt['time']:7.3f}s]"
            print(f"{time_str} {format_packet(pkt, args.verbose)}")
        print("=" * 80)

    # Show device summary
    print(f"\nDevices seen: {len(devices_seen)}")
    for dev_id, info in sorted(devices_seen.items(), key=lambda x: -x[1]['count']):
        name = get_device_name(dev_id)
        name_str = f" ({name})" if name != dev_id else ""
        types = ", ".join(sorted(info['types']))
        print(f"  {dev_id}{name_str}: {info['count']} packets [{types}]")

    # Save to JSON if requested
    if args.json:
        out_file = args.json if args.json != True else args.input.replace('.cu8', '.json')
        with open(out_file, 'w') as f:
            json.dump(packets, f, indent=2, default=str)
        print(f"\nSaved to {out_file}")

    return 0


def cmd_live(args):
    """Live capture and decode."""
    print("Starting live capture...")
    print(f"Frequency: {CENTER_FREQ / 1e6:.6f} MHz")
    print("Press Ctrl+C to stop\n")

    # Use a temp file for streaming
    import tempfile

    with tempfile.NamedTemporaryFile(suffix='.cu8', delete=False) as tmp:
        tmp_path = tmp.name

    cmd = [
        'rtl_sdr',
        '-f', str(CENTER_FREQ),
        '-s', str(SAMPLE_RATE),
        '-g', str(args.gain),
        tmp_path
    ]

    try:
        proc = subprocess.Popen(cmd, stderr=subprocess.DEVNULL)

        last_size = 0
        last_decoded = 0

        while True:
            time.sleep(0.5)

            if not os.path.exists(tmp_path):
                continue

            size = os.path.getsize(tmp_path)
            if size <= last_size + SAMPLE_RATE:  # Need at least 0.5s of new data
                continue

            # Load and decode new portion
            try:
                iq = load_cu8(tmp_path)
                if len(iq) < SAMPLE_RATE:
                    continue

                # Only look at recent data
                start_sample = max(0, len(iq) - 2 * SAMPLE_RATE)
                recent_iq = iq[start_sample:]

                txs = find_transmissions(recent_iq)

                for start, end in txs:
                    global_start = start_sample + start
                    if global_start <= last_decoded:
                        continue

                    time_s = global_start / SAMPLE_RATE
                    pad_start = max(0, start - 200)
                    pad_end = min(len(recent_iq), end + 500)
                    segment = recent_iq[pad_start:pad_end]

                    pkt = decode_packet(segment)
                    if pkt:
                        pkt['time'] = time_s
                        print(f"[{time_s:7.3f}s] {format_packet(pkt, args.verbose)}")
                        last_decoded = global_start + (end - start)

                last_size = size

            except Exception as e:
                pass

    except KeyboardInterrupt:
        print("\nStopping...")
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=2)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    return 0


def cmd_devices(args):
    """Manage known devices."""
    load_devices()

    if args.add:
        dev_id = args.add.lower()
        add_device(dev_id, args.name, args.type)
        print(f"Added/updated device {dev_id}")

    elif args.remove:
        dev_id = args.remove.lower()
        if dev_id in KNOWN_DEVICES:
            del KNOWN_DEVICES[dev_id]
            save_devices()
            print(f"Removed device {dev_id}")
        else:
            print(f"Device {dev_id} not found")

    else:
        # List devices
        if not KNOWN_DEVICES:
            print("No known devices")
        else:
            print("Known devices:")
            for dev_id, info in sorted(KNOWN_DEVICES.items()):
                name = info.get('name', '')
                dev_type = info.get('type', '')
                last_seen = info.get('last_seen', '')
                print(f"  {dev_id}: {name:20s} type={dev_type:15s} last={last_seen}")

    return 0


def cmd_analyze(args):
    """Analyze capture for patterns."""
    if not os.path.exists(args.input):
        print(f"Error: File not found: {args.input}")
        return 1

    print(f"Analyzing {args.input}...\n")
    iq = load_cu8(args.input)
    duration = len(iq) / SAMPLE_RATE

    txs = find_transmissions(iq)

    packets = []
    for i, (start, end) in enumerate(txs):
        time_s = start / SAMPLE_RATE
        pad_start = max(0, start - 200)
        pad_end = min(len(iq), end + 500)
        segment = iq[pad_start:pad_end]

        pkt = decode_packet(segment)
        if pkt:
            pkt['time'] = time_s
            packets.append(pkt)

    print(f"Duration: {duration:.1f}s")
    print(f"Transmissions: {len(txs)}")
    print(f"Decoded packets: {len(packets)}")

    if not packets:
        return 0

    # Group by device
    by_device = {}
    for pkt in packets:
        dev = pkt['device_id']
        if dev not in by_device:
            by_device[dev] = []
        by_device[dev].append(pkt)

    print(f"\n{'='*80}")
    print("DEVICE ANALYSIS")
    print('='*80)

    for dev_id, dev_pkts in sorted(by_device.items(), key=lambda x: -len(x[1])):
        name = get_device_name(dev_id)
        print(f"\n## Device {dev_id}" + (f" ({name})" if name != dev_id else ""))
        print(f"   Packets: {len(dev_pkts)}")

        # Packet type distribution
        type_counts = {}
        for pkt in dev_pkts:
            t = pkt['type_name']
            type_counts[t] = type_counts.get(t, 0) + 1
        print(f"   Types: {dict(sorted(type_counts.items()))}")

        # Button distribution (if button packets)
        btn_counts = {}
        for pkt in dev_pkts:
            if 'button_name' in pkt:
                b = pkt['button_name']
                btn_counts[b] = btn_counts.get(b, 0) + 1
        if btn_counts:
            print(f"   Buttons: {dict(sorted(btn_counts.items()))}")

        # Level values (if level packets)
        levels = [pkt['level_percent'] for pkt in dev_pkts if 'level_percent' in pkt]
        if levels:
            print(f"   Levels: min={min(levels):.1f}% max={max(levels):.1f}% unique={len(set(levels))}")

        # Timing analysis
        times = [pkt['time'] for pkt in dev_pkts]
        if len(times) > 1:
            gaps = np.diff(times) * 1000  # ms
            print(f"   Timing: gaps min={min(gaps):.1f}ms max={max(gaps):.1f}ms mean={np.mean(gaps):.1f}ms")

        # Sequence analysis
        seqs = [pkt['seq'] for pkt in dev_pkts]
        if len(seqs) > 1:
            seq_diffs = []
            for i in range(1, len(seqs)):
                diff = (seqs[i] - seqs[i-1]) % 256
                if diff < 128:
                    seq_diffs.append(diff)
            if seq_diffs:
                unique_diffs = sorted(set(seq_diffs))
                print(f"   Sequence steps: {unique_diffs}")

    # Timeline
    if args.timeline:
        print(f"\n{'='*80}")
        print("TIMELINE")
        print('='*80)

        for pkt in packets:
            print(f"[{pkt['time']:7.3f}s] {format_packet(pkt)}")

    return 0


def main():
    parser = argparse.ArgumentParser(
        description='Lutron Clear Connect Type A RF Analysis',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s capture -d 15                    # Capture 15 seconds
  %(prog)s capture -d 30 -o pico_test.cu8   # Capture to specific file
  %(prog)s capture -d 10 --decode           # Capture and decode
  %(prog)s decode capture.cu8               # Decode existing capture
  %(prog)s decode capture.cu8 -v            # Verbose decode with raw bytes
  %(prog)s decode capture.cu8 --json        # Save decoded packets to JSON
  %(prog)s live                             # Live capture and decode
  %(prog)s analyze capture.cu8              # Detailed analysis
  %(prog)s analyze capture.cu8 --timeline   # With full timeline
  %(prog)s devices                          # List known devices
  %(prog)s devices --add 084b1ebb --name "Living Room Pico"
"""
    )

    subparsers = parser.add_subparsers(dest='command', help='Commands')

    # Capture command
    cap = subparsers.add_parser('capture', aliases=['cap', 'c'], help='Capture RF to file')
    cap.add_argument('-d', '--duration', type=int, default=10, help='Duration in seconds (default: 10)')
    cap.add_argument('-o', '--output', help='Output filename')
    cap.add_argument('-g', '--gain', type=int, default=40, help='RTL-SDR gain (default: 40)')
    cap.add_argument('--decode', action='store_true', help='Decode after capture')
    cap.add_argument('-v', '--verbose', action='store_true', help='Verbose output')
    cap.add_argument('--json', nargs='?', const=True, help='Save to JSON')
    cap.add_argument('--summary', action='store_true', help='Summary only')

    # Decode command
    dec = subparsers.add_parser('decode', aliases=['dec', 'd'], help='Decode capture file')
    dec.add_argument('input', help='Input .cu8 file')
    dec.add_argument('-v', '--verbose', action='store_true', help='Show raw bytes')
    dec.add_argument('--json', nargs='?', const=True, help='Save to JSON')
    dec.add_argument('--summary', action='store_true', help='Summary only, no packet list')

    # Live command
    live = subparsers.add_parser('live', aliases=['l'], help='Live capture and decode')
    live.add_argument('-g', '--gain', type=int, default=40, help='RTL-SDR gain')
    live.add_argument('-v', '--verbose', action='store_true', help='Verbose output')

    # Analyze command
    ana = subparsers.add_parser('analyze', aliases=['ana', 'a'], help='Analyze capture patterns')
    ana.add_argument('input', help='Input .cu8 file')
    ana.add_argument('--timeline', '-t', action='store_true', help='Show full timeline')

    # Devices command
    dev = subparsers.add_parser('devices', aliases=['dev'], help='Manage known devices')
    dev.add_argument('--add', metavar='ID', help='Add/update device')
    dev.add_argument('--remove', metavar='ID', help='Remove device')
    dev.add_argument('--name', help='Device name (with --add)')
    dev.add_argument('--type', help='Device type (with --add)')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    load_devices()

    if args.command in ['capture', 'cap', 'c']:
        return cmd_capture(args)
    elif args.command in ['decode', 'dec', 'd']:
        return cmd_decode(args)
    elif args.command in ['live', 'l']:
        return cmd_live(args)
    elif args.command in ['analyze', 'ana', 'a']:
        return cmd_analyze(args)
    elif args.command in ['devices', 'dev']:
        return cmd_devices(args)

    return 0


if __name__ == '__main__':
    sys.exit(main())
