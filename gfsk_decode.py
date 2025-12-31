#!/usr/bin/env python3
"""
GFSK demodulation and Lutron packet decoding for RTL-SDR captures.
"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from lutron_cca.encoding import decode_bitstream, encode_byte_n81
from lutron_cca.packet import LutronPacket


def load_iq(filename):
    """Load RTL-SDR IQ data."""
    with open(filename, 'rb') as f:
        raw = f.read()
    iq = []
    for i in range(0, len(raw) - 1, 2):
        i_val = raw[i] - 127.5
        q_val = raw[i + 1] - 127.5
        iq.append((i_val, q_val))
    return iq


def magnitude(iq_sample):
    i, q = iq_sample
    return math.sqrt(i*i + q*q)


def fm_demod(iq):
    """FM demodulation using phase difference."""
    freq = []
    prev_phase = 0
    for i_val, q_val in iq:
        phase = math.atan2(q_val, i_val)
        diff = phase - prev_phase
        if diff > math.pi:
            diff -= 2 * math.pi
        elif diff < -math.pi:
            diff += 2 * math.pi
        freq.append(diff)
        prev_phase = phase
    return freq


def find_bursts(iq, threshold_mult=2.0, min_samples=500):
    """Find signal bursts in IQ data."""
    mags = [magnitude(s) for s in iq]
    avg_mag = sum(mags) / len(mags)
    threshold = avg_mag * threshold_mult

    bursts = []
    in_burst = False
    start = 0

    for i, m in enumerate(mags):
        if m > threshold and not in_burst:
            in_burst = True
            start = i
        elif m <= threshold and in_burst:
            if i - start > min_samples:
                bursts.append((start, i))
            in_burst = False

    return bursts


def bits_from_fm(fm_signal, sample_rate=250000, baud_rate=62500):
    """Convert FM signal to bits using zero-crossing detection."""
    samples_per_bit = sample_rate / baud_rate  # ~4

    # Normalize around mean
    mean_val = sum(fm_signal) / len(fm_signal)
    normalized = [f - mean_val for f in fm_signal]

    # Simple slicer - sample at bit centers
    bits = []
    pos = samples_per_bit / 2  # Start at center of first bit

    while pos < len(normalized):
        idx = int(pos)
        if idx < len(normalized):
            # Average a few samples around the center for robustness
            start = max(0, idx - 1)
            end = min(len(normalized), idx + 2)
            avg = sum(normalized[start:end]) / (end - start)
            bits.append('1' if avg > 0 else '0')
        pos += samples_per_bit

    return ''.join(bits)


def decode_burst(iq_burst, label=""):
    """Decode a single burst to packet data."""
    # FM demodulate
    fm = fm_demod(iq_burst)

    # Convert to bits
    bits = bits_from_fm(fm)

    print(f"\n  {label}")
    print(f"  IQ samples: {len(iq_burst)}, FM samples: {len(fm)}, bits: {len(bits)}")

    # Try to find sync pattern
    # 0xFF encoded as N81: 0 + 11111111 + 1 = 0111111111
    sync_pattern = encode_byte_n81(0xFF)  # 0111111111

    # Also try inverted (in case polarity is flipped)
    sync_inv = ''.join('1' if b == '0' else '0' for b in sync_pattern)

    sync_pos = bits.find(sync_pattern)
    sync_inv_pos = bits.find(sync_inv)

    print(f"  First 80 bits: {bits[:80]}")

    if sync_pos >= 0:
        print(f"  Found sync at bit {sync_pos}")
        # Decode from sync position
        packets = decode_bitstream(bits[max(0, sync_pos-32):], verbose=False)
        if packets:
            return packets[0]
    elif sync_inv_pos >= 0:
        print(f"  Found INVERTED sync at bit {sync_inv_pos}")
        # Invert entire bitstream and decode
        bits_inv = ''.join('1' if b == '0' else '0' for b in bits)
        packets = decode_bitstream(bits_inv[max(0, sync_inv_pos-32):], verbose=False)
        if packets:
            return packets[0]
    else:
        print(f"  No sync pattern found")
        # Try decoding anyway
        packets = decode_bitstream(bits, verbose=False)
        if packets:
            return packets[0]
        # Try inverted
        bits_inv = ''.join('1' if b == '0' else '0' for b in bits)
        packets = decode_bitstream(bits_inv, verbose=False)
        if packets:
            print("  (decoded from inverted bitstream)")
            return packets[0]

    return None


def analyze_file(filename, label):
    """Analyze a capture file."""
    print(f"\n{'='*60}")
    print(f"{label}")
    print(f"File: {filename}")
    print('='*60)

    iq = load_iq(filename)
    print(f"Loaded {len(iq)} IQ samples")

    bursts = find_bursts(iq, threshold_mult=2.0, min_samples=800)
    print(f"Found {len(bursts)} signal bursts")

    packets = []
    for i, (start, end) in enumerate(bursts[:6]):  # First 6 bursts
        iq_burst = iq[start:end]
        pkt_raw = decode_burst(iq_burst, f"Burst {i+1} (samples {start}-{end})")

        if pkt_raw:
            pkt = LutronPacket.from_bytes(pkt_raw)
            if pkt:
                packets.append(pkt)
                print(f"  DECODED: {pkt}")
                print(f"  Raw: {' '.join(f'{b:02X}' for b in pkt_raw)}")

    return packets


def main():
    if len(sys.argv) < 2:
        print("Usage: python gfsk_decode.py <capture.raw> [capture2.raw]")
        sys.exit(1)

    all_results = []
    for filename in sys.argv[1:]:
        label = Path(filename).stem.upper()
        packets = analyze_file(filename, label)
        all_results.append((label, packets))

    if len(all_results) == 2 and all_results[0][1] and all_results[1][1]:
        print(f"\n{'='*60}")
        print("COMPARISON")
        print('='*60)

        pkt1 = all_results[0][1][0]
        pkt2 = all_results[1][1][0]

        print(f"{all_results[0][0]}: {pkt1}")
        print(f"{all_results[1][0]}: {pkt2}")

        print(f"\nByte-by-byte comparison:")
        print(f"  {all_results[0][0]}: {' '.join(f'{b:02X}' for b in pkt1.raw)}")
        print(f"  {all_results[1][0]}: {' '.join(f'{b:02X}' for b in pkt2.raw)}")

        # Highlight differences
        diffs = []
        for i in range(min(len(pkt1.raw), len(pkt2.raw))):
            if pkt1.raw[i] != pkt2.raw[i]:
                diffs.append(i)
        if diffs:
            print(f"\n  Differences at bytes: {diffs}")
        else:
            print(f"\n  PACKETS MATCH!")


if __name__ == '__main__':
    main()
