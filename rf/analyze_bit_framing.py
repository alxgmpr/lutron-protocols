#!/usr/bin/env python3
"""
Analyze actual bit framing in Lutron captures to determine N81 vs N82.
Examines stop bit patterns to determine if 1 or 2 stop bits are used.
"""

import numpy as np
import sys
from pathlib import Path


def load_cu8(filepath, max_samples=None):
    """Load IQ samples from .cu8 file."""
    data = np.fromfile(filepath, dtype=np.uint8)
    if max_samples:
        data = data[:max_samples * 2]
    i = data[0::2].astype(np.float32) - 127.5
    q = data[1::2].astype(np.float32) - 127.5
    return i + 1j * q


def find_signal_regions(samples, sample_rate=2000000, threshold=30):
    """Find regions with RF signal."""
    magnitude = np.abs(samples)

    # Moving average
    window = int(sample_rate * 0.0005)  # 0.5ms window
    kernel = np.ones(window) / window
    smooth_mag = np.convolve(magnitude, kernel, mode='same')

    # Find where signal is above threshold
    signal_mask = smooth_mag > threshold

    # Find transitions
    changes = np.diff(signal_mask.astype(int))
    starts = np.where(changes == 1)[0]
    ends = np.where(changes == -1)[0]

    if len(starts) == 0:
        return []

    if len(ends) == 0 or ends[0] < starts[0]:
        ends = np.append([starts[0]], ends)
    if len(starts) > len(ends):
        ends = np.append(ends, [len(samples) - 1])

    regions = []
    for s, e in zip(starts, ends):
        duration = (e - s) / sample_rate * 1000
        if duration > 5:  # At least 5ms
            regions.append((s, e, duration))

    return regions


def fsk_demodulate(samples, sample_rate=2000000):
    """Demodulate FSK to get bit stream."""
    # FM discriminator
    delayed = np.roll(samples, 1)
    delayed[0] = samples[0]
    product = samples * np.conj(delayed)
    freq = np.angle(product)
    return freq


def analyze_byte_timing(freq_signal, sample_rate=2000000, baud_rate=62500):
    """Analyze the timing of individual bits and look for stop bit patterns."""
    samples_per_bit = sample_rate / baud_rate  # 32 samples per bit

    # Find the preamble and sync
    # Preamble is alternating 1,0,1,0 pattern
    # After preamble, we should see the sync byte 0xFF

    # Threshold the signal
    threshold = 0
    bits = (freq_signal > threshold).astype(int)

    # Look for transitions
    transitions = np.where(np.diff(bits) != 0)[0]

    if len(transitions) < 10:
        return None

    # Calculate bit widths
    bit_widths = np.diff(transitions)

    # Filter to only significant widths (ignore noise)
    valid_widths = bit_widths[(bit_widths > samples_per_bit * 0.5) & (bit_widths < samples_per_bit * 3)]

    if len(valid_widths) < 10:
        return None

    # Analyze width distribution
    avg_width = np.mean(valid_widths)

    # Count widths that are ~1 bit, ~2 bits, ~3 bits
    single_bits = np.sum((valid_widths > samples_per_bit * 0.7) & (valid_widths < samples_per_bit * 1.3))
    double_bits = np.sum((valid_widths > samples_per_bit * 1.7) & (valid_widths < samples_per_bit * 2.3))
    triple_bits = np.sum((valid_widths > samples_per_bit * 2.7) & (valid_widths < samples_per_bit * 3.3))

    return {
        'avg_width': avg_width,
        'expected_width': samples_per_bit,
        'single_bit_runs': single_bits,
        'double_bit_runs': double_bits,
        'triple_bit_runs': triple_bits,
        'total_transitions': len(transitions),
        'bit_widths': valid_widths
    }


def extract_packet_duration_detailed(samples, sample_rate=2000000, baud_rate=62500):
    """Get detailed packet timing."""
    regions = find_signal_regions(samples, sample_rate)

    if not regions:
        return None

    durations = []
    for start, end, duration_ms in regions[:20]:  # First 20 packets
        # Calculate actual bits from duration
        bits_from_duration = (duration_ms / 1000) * baud_rate
        durations.append({
            'duration_ms': duration_ms,
            'estimated_bits': bits_from_duration,
        })

    return durations


def analyze_stop_bits(filepath, sample_rate=2000000):
    """Analyze a capture to determine stop bit count."""
    print(f"\n=== Analyzing: {filepath.name} ===")

    samples = load_cu8(filepath, max_samples=sample_rate * 10)  # First 10 seconds

    regions = find_signal_regions(samples, sample_rate)
    print(f"Found {len(regions)} signal regions")

    if not regions:
        return

    # Analyze first few packets in detail
    results = []
    for i, (start, end, duration_ms) in enumerate(regions[:10]):
        # Get this packet's samples
        packet_samples = samples[start:end]

        # Demodulate
        freq = fsk_demodulate(packet_samples, sample_rate)

        # Analyze bit timing
        timing = analyze_byte_timing(freq, sample_rate)

        if timing:
            results.append({
                'packet': i,
                'duration_ms': duration_ms,
                **timing
            })

    if not results:
        print("Could not extract bit timing from any packets")
        return

    # Print analysis
    print(f"\nPacket timing analysis:")
    for r in results[:5]:
        expected_bits_n81 = (r['duration_ms'] / 1000) * 62500

        # If N81 (10 bits/byte), then bytes = bits / 10
        # If N82 (11 bits/byte), then bytes = bits / 11
        bytes_if_n81 = expected_bits_n81 / 10
        bytes_if_n82 = expected_bits_n81 / 11

        # Account for preamble(32) + sync(10 or 11) + prefix(20 or 22) + trailing(16)
        overhead_n81 = 32 + 10 + 20 + 16  # 78 bits
        overhead_n82 = 32 + 11 + 22 + 16  # 81 bits

        data_bits_n81 = expected_bits_n81 - overhead_n81
        data_bits_n82 = expected_bits_n81 - overhead_n82

        data_bytes_n81 = data_bits_n81 / 10
        data_bytes_n82 = data_bits_n82 / 11

        print(f"  Packet {r['packet']}: {r['duration_ms']:.2f}ms = {expected_bits_n81:.0f} bits")
        print(f"    If N81: {data_bytes_n81:.1f} data bytes (expect 47-48)")
        print(f"    If N82: {data_bytes_n82:.1f} data bytes (expect 47-48)")
        print(f"    Bit runs: single={r['single_bit_runs']}, double={r['double_bit_runs']}, triple={r['triple_bit_runs']}")

    # Calculate average and determine likely framing
    avg_duration = np.mean([r['duration_ms'] for r in results])
    bits_at_62500 = (avg_duration / 1000) * 62500

    print(f"\nAverage packet duration: {avg_duration:.2f}ms ({bits_at_62500:.0f} bits)")

    # Calculate expected durations
    # For 47 bytes:
    n81_47 = 32 + 10 + 20 + (47 * 10) + 16  # 548 bits
    n82_47 = 32 + 11 + 22 + (47 * 11) + 16  # 598 bits

    # For 48 bytes:
    n81_48 = 32 + 10 + 20 + (48 * 10) + 16  # 558 bits
    n82_48 = 32 + 11 + 22 + (48 * 11) + 16  # 609 bits

    print(f"\nExpected bit counts:")
    print(f"  47 bytes N81: {n81_47} bits = {n81_47/62500*1000:.2f}ms")
    print(f"  47 bytes N82: {n82_47} bits = {n82_47/62500*1000:.2f}ms")
    print(f"  48 bytes N81: {n81_48} bits = {n81_48/62500*1000:.2f}ms")
    print(f"  48 bytes N82: {n82_48} bits = {n82_48/62500*1000:.2f}ms")

    # Determine closest match
    candidates = [
        (abs(bits_at_62500 - n81_47), '47 bytes, N81'),
        (abs(bits_at_62500 - n82_47), '47 bytes, N82'),
        (abs(bits_at_62500 - n81_48), '48 bytes, N81'),
        (abs(bits_at_62500 - n82_48), '48 bytes, N82'),
    ]
    candidates.sort(key=lambda x: x[0])

    print(f"\nBest match: {candidates[0][1]} (error: {candidates[0][0]:.1f} bits)")

    return {
        'avg_duration_ms': avg_duration,
        'estimated_bits': bits_at_62500,
        'best_match': candidates[0][1]
    }


def main():
    captures_dir = Path(__file__).parent / 'captures'

    # Analyze real Pico capture
    real_pico = captures_dir / 'real_pico_pair2.cu8'
    if real_pico.exists():
        result_pico = analyze_stop_bits(real_pico)

    # Analyze ESP32 capture
    esp32 = captures_dir / 'esp32_pico_pair.cu8'
    if esp32.exists():
        result_esp32 = analyze_stop_bits(esp32)

    # Summary comparison
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    if 'result_pico' in dir() and result_pico:
        print(f"Real Pico: {result_pico['avg_duration_ms']:.2f}ms -> {result_pico['best_match']}")
    if 'result_esp32' in dir() and result_esp32:
        print(f"ESP32: {result_esp32['avg_duration_ms']:.2f}ms -> {result_esp32['best_match']}")


if __name__ == '__main__':
    main()
