#!/usr/bin/env python3
"""Analyze frequency distribution in captures."""

import sys
import numpy as np
from scipy import signal as scipy_signal
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

SAMPLE_RATE = 2_000_000
BIT_RATE = 62_500

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

def analyze_freq(iq_segment, label):
    if len(iq_segment) < 100:
        return None, None

    freq = demodulate_fsk(iq_segment)

    # Trim edges
    trim = 100
    freq_core = freq[trim:-trim] if len(freq) > 2*trim else freq

    print(f"\n=== {label} ===")
    print(f"Samples: {len(freq_core)}")

    # Statistics
    median = np.median(freq_core)
    mean = np.mean(freq_core)
    std = np.std(freq_core)
    print(f"Median: {median/1000:.1f} kHz")
    print(f"Mean: {mean/1000:.1f} kHz")
    print(f"Std: {std/1000:.1f} kHz")
    print(f"Min: {np.min(freq_core)/1000:.1f} kHz, Max: {np.max(freq_core)/1000:.1f} kHz")

    # Count samples above/below median
    above = np.sum(freq_core > median)
    below = np.sum(freq_core < median)
    print(f"Samples above median: {above} ({100*above/len(freq_core):.1f}%)")
    print(f"Samples below median: {below} ({100*below/len(freq_core):.1f}%)")

    # For 2-FSK, we expect two peaks in the histogram
    # Let's find them
    hist, bins = np.histogram(freq_core, bins=100)
    bin_centers = (bins[:-1] + bins[1:]) / 2

    # Find the two main peaks
    peak_idx = np.argsort(hist)[-2:]
    peak_freqs = bin_centers[peak_idx]
    print(f"Two main frequency peaks: {peak_freqs[0]/1000:.1f} kHz, {peak_freqs[1]/1000:.1f} kHz")
    print(f"FSK deviation (half spread): {abs(peak_freqs[1] - peak_freqs[0])/2000:.1f} kHz")

    return freq_core, (hist, bins)

def main():
    if len(sys.argv) < 3:
        print("Usage: freq_histogram.py <real.cu8> <esp32.cu8>")
        sys.exit(1)

    real_iq = load_cu8(sys.argv[1])
    esp32_iq = load_cu8(sys.argv[2])

    real_txs = find_transmissions(real_iq)
    esp32_txs = find_transmissions(esp32_iq)

    print("="*60)
    print("REAL PICO")
    print("="*60)

    real_freqs = []
    for i, (start, end) in enumerate(real_txs[:3]):
        pad_start = max(0, start - 200)
        pad_end = min(len(real_iq), end + 500)
        segment = real_iq[pad_start:pad_end]
        freq, _ = analyze_freq(segment, f"Real TX {i+1}")
        if freq is not None:
            real_freqs.append(freq)

    print("\n" + "="*60)
    print("ESP32")
    print("="*60)

    esp32_freqs = []
    for i, (start, end) in enumerate(esp32_txs[:3]):
        pad_start = max(0, start - 200)
        pad_end = min(len(esp32_iq), end + 500)
        segment = esp32_iq[pad_start:pad_end]
        freq, _ = analyze_freq(segment, f"ESP32 TX {i+1}")
        if freq is not None:
            esp32_freqs.append(freq)

    # Create comparison plot
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))

    # Real Pico histograms
    if real_freqs:
        for i, freq in enumerate(real_freqs[:2]):
            ax = axes[0, i]
            ax.hist(freq/1000, bins=100, alpha=0.7)
            ax.set_title(f'Real Pico TX {i+1}')
            ax.set_xlabel('Frequency (kHz)')
            ax.axvline(np.median(freq)/1000, color='r', linestyle='--', label='Median')
            ax.legend()

    # ESP32 histograms
    if esp32_freqs:
        for i, freq in enumerate(esp32_freqs[:2]):
            ax = axes[1, i]
            ax.hist(freq/1000, bins=100, alpha=0.7)
            ax.set_title(f'ESP32 TX {i+1}')
            ax.set_xlabel('Frequency (kHz)')
            ax.axvline(np.median(freq)/1000, color='r', linestyle='--', label='Median')
            ax.legend()

    plt.tight_layout()
    plt.savefig('~/lutron-tools/lutron-tools/rf/freq_comparison.png', dpi=100)
    print(f"\nSaved histogram to rf/freq_comparison.png")

if __name__ == "__main__":
    main()
