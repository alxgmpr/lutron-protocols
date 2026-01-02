#!/usr/bin/env python3
"""Analyze with fixed threshold instead of median."""

import numpy as np
from scipy import signal as scipy_signal

SAMPLE_RATE = 2_000_000
BIT_RATE = 62_500
SAMPLES_PER_BIT = SAMPLE_RATE / BIT_RATE

def load_cu8(filename):
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_transmissions(iq, threshold_factor=6.0, min_duration_ms=3.0):
    mag = np.abs(iq)
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

    min_samples = int(min_duration_ms * SAMPLE_RATE / 1000)
    txs = []
    for start, end in zip(starts, ends):
        if end - start >= min_samples:
            txs.append((int(start), int(end)))

    return txs

def demodulate_fsk(iq):
    phase = np.unwrap(np.angle(iq))
    freq = np.diff(phase) * SAMPLE_RATE / (2 * np.pi)
    b, a = scipy_signal.butter(4, 80000 / (SAMPLE_RATE / 2), btype='low')
    freq_filt = scipy_signal.filtfilt(b, a, freq)
    return freq_filt

def sample_bits_fixed_threshold(binary, threshold=0):
    bits = []
    pos = 0.0
    while pos < len(binary):
        center = int(pos + SAMPLES_PER_BIT / 2)
        if center >= len(binary):
            break
        bits.append(1 if binary[center] > threshold else 0)
        pos += SAMPLES_PER_BIT
    return bits

print("="*60)
print("Comparing threshold methods on debug capture")
print("="*60)

iq = load_cu8("captures/debug_pattern.cu8")
txs = find_transmissions(iq)

for i, (start, end) in enumerate(txs):
    print(f"\n=== Transmission {i+1} ===")

    pad_start = max(0, start - 200)
    pad_end = min(len(iq), end + 500)
    segment = iq[pad_start:pad_end]

    freq = demodulate_fsk(segment)

    # Find the two FSK frequencies using histogram
    hist, bins = np.histogram(freq, bins=100)
    bin_centers = (bins[:-1] + bins[1:]) / 2
    peak_idx = np.argsort(hist)[-2:]
    peak_freqs = sorted(bin_centers[peak_idx])

    # Calculate proper center
    center_freq = (peak_freqs[0] + peak_freqs[1]) / 2

    print(f"FSK peaks: {peak_freqs[0]/1000:.1f} kHz, {peak_freqs[1]/1000:.1f} kHz")
    print(f"Calculated center: {center_freq/1000:.1f} kHz")
    print(f"Median: {np.median(freq)/1000:.1f} kHz")

    # Decode with median threshold
    median_threshold = np.median(freq)
    bits_median = sample_bits_fixed_threshold(freq, median_threshold)
    bits_median_str = ''.join(str(b) for b in bits_median[:100])
    print(f"\nMedian threshold ({median_threshold/1000:.1f} kHz):")
    print(f"  First 100 bits: {bits_median_str}")

    # Count alternating bits at start
    alt_count = 0
    for j in range(min(200, len(bits_median) - 1)):
        if bits_median[j] != bits_median[j+1]:
            alt_count += 1
        else:
            break
    print(f"  Alternating: {alt_count} bits")

    # Decode with center threshold
    bits_center = sample_bits_fixed_threshold(freq, center_freq)
    bits_center_str = ''.join(str(b) for b in bits_center[:100])
    print(f"\nCenter threshold ({center_freq/1000:.1f} kHz):")
    print(f"  First 100 bits: {bits_center_str}")

    alt_count = 0
    for j in range(min(200, len(bits_center) - 1)):
        if bits_center[j] != bits_center[j+1]:
            alt_count += 1
        else:
            break
    print(f"  Alternating: {alt_count} bits")

    # Decode with 0 threshold
    bits_zero = sample_bits_fixed_threshold(freq, 0)
    bits_zero_str = ''.join(str(b) for b in bits_zero[:100])
    print(f"\n0 Hz threshold:")
    print(f"  First 100 bits: {bits_zero_str}")

    alt_count = 0
    for j in range(min(200, len(bits_zero) - 1)):
        if bits_zero[j] != bits_zero[j+1]:
            alt_count += 1
        else:
            break
    print(f"  Alternating: {alt_count} bits")
