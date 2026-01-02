#!/usr/bin/env python3
"""Analyze the fixed ESP32 capture."""

import numpy as np
from pathlib import Path


def load_cu8(filepath, max_samples=None):
    """Load IQ samples from .cu8 file."""
    data = np.fromfile(filepath, dtype=np.uint8)
    if max_samples:
        data = data[:max_samples * 2]
    i = data[0::2].astype(np.float32) - 127.5
    q = data[1::2].astype(np.float32) - 127.5
    return i + 1j * q


def find_packets_robust(samples, sample_rate=2000000, min_duration_ms=7, max_duration_ms=15):
    """Find packets using robust detection."""
    magnitude = np.abs(samples)

    # Use larger moving average for cleaner signal
    window = int(sample_rate * 0.002)
    kernel = np.ones(window) / window
    smooth_mag = np.convolve(magnitude, kernel, mode='same')

    peaks = smooth_mag[smooth_mag > 50]
    if len(peaks) > 100:
        threshold = np.percentile(peaks, 25)
    else:
        threshold = 50

    signal_mask = smooth_mag > threshold
    changes = np.diff(signal_mask.astype(int))
    starts = np.where(changes == 1)[0]
    ends = np.where(changes == -1)[0]

    if len(starts) == 0:
        return []

    if len(ends) == 0 or (len(starts) > 0 and (len(ends) == 0 or ends[0] < starts[0])):
        if len(ends) > 0:
            ends = np.append([starts[0] + 100], ends[1:] if len(ends) > 1 else [])
    if len(starts) > len(ends):
        ends = np.append(ends, [len(samples) - 1])

    min_gap = int(sample_rate * 0.001)

    packets = []
    current_start = starts[0] if len(starts) > 0 else 0
    current_end = ends[0] if len(ends) > 0 else 0

    for i in range(1, min(len(starts), len(ends))):
        gap = starts[i] - current_end
        if gap < min_gap:
            current_end = ends[i]
        else:
            duration_ms = (current_end - current_start) / sample_rate * 1000
            if min_duration_ms <= duration_ms <= max_duration_ms:
                packets.append({
                    'start': current_start,
                    'end': current_end,
                    'duration_ms': duration_ms
                })
            current_start = starts[i]
            current_end = ends[i]

    if current_start is not None and current_end is not None:
        duration_ms = (current_end - current_start) / sample_rate * 1000
        if min_duration_ms <= duration_ms <= max_duration_ms:
            packets.append({
                'start': current_start,
                'end': current_end,
                'duration_ms': duration_ms
            })

    return packets


def main():
    captures_dir = Path('~/lutron-tools/lutron-tools/rf/captures')

    # Analyze the new fixed capture
    fixed = captures_dir / 'esp32_pico_pair_fixed.cu8'
    if not fixed.exists():
        print(f"File not found: {fixed}")
        return

    print(f"\n{'='*60}")
    print(f"Analyzing FIXED ESP32 capture: {fixed.name}")
    print(f"{'='*60}")

    samples = load_cu8(fixed, max_samples=2000000 * 10)
    print(f"Loaded {len(samples)} samples ({len(samples)/2000000:.1f}s)")

    packets = find_packets_robust(samples, 2000000)
    print(f"Found {len(packets)} valid packets (7-15ms duration)")

    if not packets:
        print("No packets found!")
        return

    durations = [p['duration_ms'] for p in packets]

    print(f"\nPacket duration statistics:")
    print(f"  Min:    {min(durations):.2f}ms")
    print(f"  Max:    {max(durations):.2f}ms")
    print(f"  Mean:   {np.mean(durations):.2f}ms")
    print(f"  Median: {np.median(durations):.2f}ms")
    print(f"  Std:    {np.std(durations):.2f}ms")

    mean_bits = (np.mean(durations) / 1000) * 62500
    print(f"\nAt 62.5 kbaud: {mean_bits:.0f} bits mean")

    print(f"\nFirst 10 packets:")
    for i, p in enumerate(packets[:10]):
        bits = (p['duration_ms'] / 1000) * 62500
        print(f"  {i}: {p['duration_ms']:.2f}ms ({bits:.0f} bits)")

    # Expected for 52-byte packet
    expected_bits = 32 + 10 + 20 + (52 * 10) + 16  # 598 bits
    expected_ms = expected_bits / 62500 * 1000
    print(f"\nExpected for 52-byte packet (N81):")
    print(f"  {expected_bits} bits = {expected_ms:.2f}ms")

    diff = mean_bits - expected_bits
    print(f"\nDifference: {diff:.0f} bits ({diff/10:.1f} bytes)")


if __name__ == '__main__':
    main()
