#!/usr/bin/env python3
"""
Compare packet durations between real Pico and ESP32 captures.
Uses amplitude-based detection with higher threshold to avoid false triggers.
"""

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
    """
    Find packets using robust detection.
    Real Lutron packets are 8-10ms in duration.
    """
    magnitude = np.abs(samples)

    # Use larger moving average for cleaner signal
    window = int(sample_rate * 0.002)  # 2ms window
    kernel = np.ones(window) / window
    smooth_mag = np.convolve(magnitude, kernel, mode='same')

    # Find the signal level for strong packets (top 10% of peaks)
    # This helps set a good threshold
    peaks = smooth_mag[smooth_mag > 50]  # Initial filter
    if len(peaks) > 100:
        threshold = np.percentile(peaks, 25)  # Use 25th percentile as threshold
    else:
        threshold = 50

    # Find signal regions
    signal_mask = smooth_mag > threshold

    # Find transitions
    changes = np.diff(signal_mask.astype(int))
    starts = np.where(changes == 1)[0]
    ends = np.where(changes == -1)[0]

    if len(starts) == 0:
        return []

    # Align starts and ends
    if len(ends) == 0 or (len(starts) > 0 and (len(ends) == 0 or ends[0] < starts[0])):
        if len(ends) > 0:
            ends = np.append([starts[0] + 100], ends[1:] if len(ends) > 1 else [])
    if len(starts) > len(ends):
        ends = np.append(ends, [len(samples) - 1])

    # Minimum samples to combine nearby regions
    min_gap = int(sample_rate * 0.001)  # 1ms minimum gap

    packets = []
    current_start = starts[0] if len(starts) > 0 else 0
    current_end = ends[0] if len(ends) > 0 else 0

    for i in range(1, min(len(starts), len(ends))):
        gap = starts[i] - current_end
        if gap < min_gap:
            # Combine regions
            current_end = ends[i]
        else:
            # Record current region
            duration_ms = (current_end - current_start) / sample_rate * 1000
            if min_duration_ms <= duration_ms <= max_duration_ms:
                packets.append({
                    'start': current_start,
                    'end': current_end,
                    'duration_ms': duration_ms
                })
            current_start = starts[i]
            current_end = ends[i]

    # Don't forget the last region
    if current_start is not None and current_end is not None:
        duration_ms = (current_end - current_start) / sample_rate * 1000
        if min_duration_ms <= duration_ms <= max_duration_ms:
            packets.append({
                'start': current_start,
                'end': current_end,
                'duration_ms': duration_ms
            })

    return packets


def analyze_capture(filepath, sample_rate=2000000):
    """Analyze a capture file and return packet statistics."""
    print(f"\n{'='*60}")
    print(f"Analyzing: {filepath.name}")
    print(f"{'='*60}")

    samples = load_cu8(filepath, max_samples=sample_rate * 30)  # First 30 seconds
    print(f"Loaded {len(samples)} samples ({len(samples)/sample_rate:.1f}s)")

    packets = find_packets_robust(samples, sample_rate)
    print(f"Found {len(packets)} valid packets (7-15ms duration)")

    if not packets:
        return None

    durations = [p['duration_ms'] for p in packets]

    print(f"\nPacket duration statistics:")
    print(f"  Min:    {min(durations):.2f}ms")
    print(f"  Max:    {max(durations):.2f}ms")
    print(f"  Mean:   {np.mean(durations):.2f}ms")
    print(f"  Median: {np.median(durations):.2f}ms")
    print(f"  Std:    {np.std(durations):.2f}ms")

    # Calculate estimated bits at 62.5 kbaud
    mean_bits = (np.mean(durations) / 1000) * 62500
    print(f"\nAt 62.5 kbaud:")
    print(f"  Mean bits: {mean_bits:.0f}")

    # Show first 10 packet durations
    print(f"\nFirst 10 packets:")
    for i, p in enumerate(packets[:10]):
        bits = (p['duration_ms'] / 1000) * 62500
        print(f"  {i}: {p['duration_ms']:.2f}ms ({bits:.0f} bits)")

    return {
        'count': len(packets),
        'mean_duration_ms': np.mean(durations),
        'median_duration_ms': np.median(durations),
        'std_duration_ms': np.std(durations),
        'mean_bits': mean_bits
    }


def calculate_framing(bits, overhead_bits=78):
    """
    Calculate likely packet length and framing from total bit count.

    Standard overhead (N81):
      Preamble: 32 bits
      Sync (0xFF): 10 bits
      Prefix (0xFA 0xDE): 20 bits
      Trailing: 16 bits
      Total: 78 bits

    N82 overhead adds 1 bit per byte.
    """
    data_bits_n81 = bits - overhead_bits
    data_bytes_n81 = data_bits_n81 / 10

    # For N82, overhead is 32 + 11 + 22 + 16 = 81 bits
    data_bits_n82 = bits - 81
    data_bytes_n82 = data_bits_n82 / 11

    return {
        'n81_bytes': data_bytes_n81,
        'n82_bytes': data_bytes_n82
    }


def main():
    captures_dir = Path(__file__).parent / 'captures'

    # Analyze real Pico
    real_pico = captures_dir / 'real_pico_pair2.cu8'
    result_pico = None
    if real_pico.exists():
        result_pico = analyze_capture(real_pico)

    # Analyze ESP32
    esp32 = captures_dir / 'esp32_pico_pair.cu8'
    result_esp32 = None
    if esp32.exists():
        result_esp32 = analyze_capture(esp32)

    # Comparison
    print(f"\n{'='*60}")
    print("COMPARISON")
    print(f"{'='*60}")

    if result_pico and result_esp32:
        diff = result_pico['mean_duration_ms'] - result_esp32['mean_duration_ms']
        print(f"\nReal Pico: {result_pico['mean_duration_ms']:.2f}ms mean ({result_pico['mean_bits']:.0f} bits)")
        print(f"ESP32:     {result_esp32['mean_duration_ms']:.2f}ms mean ({result_esp32['mean_bits']:.0f} bits)")
        print(f"Difference: {diff:.2f}ms ({diff / 1000 * 62500:.0f} bits)")

        # Framing analysis
        print(f"\nFraming analysis:")

        print(f"\nReal Pico ({result_pico['mean_bits']:.0f} bits):")
        framing_pico = calculate_framing(result_pico['mean_bits'])
        print(f"  If N81 (10 bits/byte): {framing_pico['n81_bytes']:.1f} data bytes")
        print(f"  If N82 (11 bits/byte): {framing_pico['n82_bytes']:.1f} data bytes")

        print(f"\nESP32 ({result_esp32['mean_bits']:.0f} bits):")
        framing_esp32 = calculate_framing(result_esp32['mean_bits'])
        print(f"  If N81 (10 bits/byte): {framing_esp32['n81_bytes']:.1f} data bytes")
        print(f"  If N82 (11 bits/byte): {framing_esp32['n82_bytes']:.1f} data bytes")

        # Expected values
        print(f"\nExpected bit counts for 47-byte packets:")
        print(f"  N81: 32 + 10 + 20 + (47×10) + 16 = 548 bits = 8.77ms")
        print(f"  N82: 32 + 11 + 22 + (47×11) + 16 = 598 bits = 9.57ms")
        print(f"\nExpected bit counts for 48-byte packets:")
        print(f"  N81: 32 + 10 + 20 + (48×10) + 16 = 558 bits = 8.93ms")
        print(f"  N82: 32 + 11 + 22 + (48×11) + 16 = 609 bits = 9.74ms")


if __name__ == '__main__':
    main()
