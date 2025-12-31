#!/usr/bin/env python3
"""
Demodulate RTL-SDR IQ captures and decode Lutron packets for comparison.
Uses only standard library - no numpy required.
"""

import array
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from lutron_cca.encoding import decode_bitstream
from lutron_cca.packet import LutronPacket


def load_iq(filename):
    """Load RTL-SDR IQ data (interleaved uint8 I/Q)."""
    with open(filename, 'rb') as f:
        raw = f.read()

    # Convert to I/Q pairs centered at 127.5
    iq = []
    for i in range(0, len(raw) - 1, 2):
        i_val = raw[i] - 127.5
        q_val = raw[i + 1] - 127.5
        iq.append((i_val, q_val))
    return iq


def fm_demodulate(iq):
    """Simple FM demodulation using phase difference."""
    freq = []
    prev_phase = 0

    for i_val, q_val in iq:
        # Compute phase
        phase = math.atan2(q_val, i_val)

        # Phase difference (with wrapping)
        diff = phase - prev_phase
        if diff > math.pi:
            diff -= 2 * math.pi
        elif diff < -math.pi:
            diff += 2 * math.pi

        freq.append(diff)
        prev_phase = phase

    return freq


def find_signal_bursts(signal, threshold_ratio=0.3, min_samples=500):
    """Find signal bursts above threshold."""
    # Calculate max magnitude
    max_mag = max(abs(s) for s in signal)
    threshold = threshold_ratio * max_mag

    bursts = []
    in_burst = False
    start = 0

    for i, val in enumerate(signal):
        if abs(val) > threshold and not in_burst:
            in_burst = True
            start = i
        elif abs(val) <= threshold and in_burst:
            if i - start >= min_samples:
                bursts.append((start, i))
            in_burst = False

    if in_burst and len(signal) - start >= min_samples:
        bursts.append((start, len(signal)))

    return bursts


def demod_to_bits(fm_signal, sample_rate=250000, baud_rate=62500):
    """Convert FM demodulated signal to bit stream."""
    samples_per_bit = sample_rate / baud_rate  # ~4 samples per bit

    # Calculate mean for normalization
    mean_val = sum(fm_signal) / len(fm_signal)

    # Simple threshold-based bit extraction
    bits = []
    pos = 0.0
    while pos < len(fm_signal):
        # Average over one bit period
        start_idx = int(pos)
        end_idx = min(int(pos + samples_per_bit), len(fm_signal))

        if end_idx > start_idx:
            bit_avg = sum(fm_signal[start_idx:end_idx]) / (end_idx - start_idx)
            bits.append('1' if bit_avg > mean_val else '0')

        pos += samples_per_bit

    return ''.join(bits)


def analyze_capture(filename, label):
    """Analyze an IQ capture file."""
    print(f"\n{'='*60}")
    print(f"Analyzing: {label}")
    print(f"File: {filename}")
    print('='*60)

    # Load IQ data
    iq = load_iq(filename)
    print(f"Loaded {len(iq)} IQ samples")

    # FM demodulate
    fm = fm_demodulate(iq)
    print(f"FM demodulated: {len(fm)} samples")

    # Find signal bursts
    bursts = find_signal_bursts(fm, threshold_ratio=0.15, min_samples=800)
    print(f"Found {len(bursts)} signal bursts")

    all_packets = []

    for i, (start, end) in enumerate(bursts[:6]):  # Process up to 6 bursts
        print(f"\n--- Burst {i+1}: samples {start}-{end} ({end-start} samples) ---")

        burst_signal = fm[start:end]
        bitstream = demod_to_bits(burst_signal)
        print(f"Bitstream length: {len(bitstream)} bits")

        # Show first 100 bits
        print(f"First 100 bits: {bitstream[:100]}")

        # Try to decode
        packets = decode_bitstream(bitstream, verbose=False)

        if packets:
            for pkt_raw in packets:
                pkt = LutronPacket.from_bytes(pkt_raw)
                if pkt:
                    all_packets.append(pkt)
                    print(f"Decoded: {pkt}")
                    print(f"Raw hex: {' '.join(f'{b:02X}' for b in pkt_raw)}")
        else:
            print("No valid packets decoded from this burst")

    return all_packets


def main():
    if len(sys.argv) < 3:
        print("Usage: python demod_compare.py <real_pico.raw> <cc1101.raw>")
        sys.exit(1)

    real_file = sys.argv[1]
    cc1101_file = sys.argv[2]

    real_packets = analyze_capture(real_file, "REAL PICO")
    cc1101_packets = analyze_capture(cc1101_file, "CC1101 TX")

    print("\n" + "="*60)
    print("COMPARISON SUMMARY")
    print("="*60)
    print(f"Real Pico packets decoded: {len(real_packets)}")
    print(f"CC1101 packets decoded: {len(cc1101_packets)}")

    if real_packets and cc1101_packets:
        print("\nFirst packet from each:")
        print(f"  Real: {real_packets[0]}")
        print(f"  CC1101: {cc1101_packets[0]}")

        # Compare raw bytes
        print("\nByte comparison:")
        real_raw = real_packets[0].raw
        cc1101_raw = cc1101_packets[0].raw

        print(f"  Real:   {' '.join(f'{b:02X}' for b in real_raw)}")
        print(f"  CC1101: {' '.join(f'{b:02X}' for b in cc1101_raw)}")


if __name__ == '__main__':
    main()
