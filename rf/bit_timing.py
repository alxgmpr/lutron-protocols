#!/usr/bin/env python3
"""Analyze bit timing in captures."""

import sys
import numpy as np
from scipy import signal as scipy_signal
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

SAMPLE_RATE = 2_000_000
BIT_RATE = 62_500
SAMPLES_PER_BIT = SAMPLE_RATE / BIT_RATE  # 32

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

def main():
    if len(sys.argv) < 3:
        print("Usage: bit_timing.py <real.cu8> <esp32.cu8>")
        sys.exit(1)

    real_iq = load_cu8(sys.argv[1])
    esp32_iq = load_cu8(sys.argv[2])

    real_txs = find_transmissions(real_iq)
    esp32_txs = find_transmissions(esp32_iq)

    fig, axes = plt.subplots(4, 1, figsize=(14, 12))

    # Real Pico first transmission - first 200 bits worth
    start, end = real_txs[0]
    pad_start = max(0, start - 200)
    segment = real_iq[pad_start:pad_start + int(200 * SAMPLES_PER_BIT)]
    freq = demodulate_fsk(segment)

    # First 100 bits
    samples = int(100 * SAMPLES_PER_BIT)
    time_us = np.arange(len(freq[:samples])) / SAMPLE_RATE * 1e6

    ax = axes[0]
    ax.plot(time_us, freq[:samples]/1000)
    ax.set_title('Real Pico TX1 - First 100 bit periods')
    ax.set_xlabel('Time (µs)')
    ax.set_ylabel('Freq (kHz)')
    ax.axhline(0, color='k', linestyle='--', alpha=0.3)
    # Add bit period markers
    for i in range(100):
        bit_time = i * SAMPLES_PER_BIT / SAMPLE_RATE * 1e6
        ax.axvline(bit_time, color='gray', linestyle=':', alpha=0.2)

    # Zoom into preamble area (bits 10-50)
    ax = axes[1]
    zoom_start = int(10 * SAMPLES_PER_BIT)
    zoom_end = int(50 * SAMPLES_PER_BIT)
    zoom_time = np.arange(zoom_end - zoom_start) / SAMPLE_RATE * 1e6
    ax.plot(zoom_time, freq[zoom_start:zoom_end]/1000)
    ax.set_title('Real Pico TX1 - Preamble area (bits 10-50)')
    ax.set_xlabel('Time (µs)')
    ax.set_ylabel('Freq (kHz)')
    ax.axhline(np.median(freq[zoom_start:zoom_end])/1000, color='r', linestyle='--', label='Median')
    ax.legend()
    for i in range(40):
        bit_time = i * SAMPLES_PER_BIT / SAMPLE_RATE * 1e6
        ax.axvline(bit_time, color='gray', linestyle=':', alpha=0.2)

    # ESP32 first transmission
    start, end = esp32_txs[0]
    pad_start = max(0, start - 200)
    segment = esp32_iq[pad_start:pad_start + int(200 * SAMPLES_PER_BIT)]
    freq = demodulate_fsk(segment)

    ax = axes[2]
    ax.plot(time_us, freq[:samples]/1000)
    ax.set_title('ESP32 TX1 - First 100 bit periods')
    ax.set_xlabel('Time (µs)')
    ax.set_ylabel('Freq (kHz)')
    ax.axhline(0, color='k', linestyle='--', alpha=0.3)
    for i in range(100):
        bit_time = i * SAMPLES_PER_BIT / SAMPLE_RATE * 1e6
        ax.axvline(bit_time, color='gray', linestyle=':', alpha=0.2)

    ax = axes[3]
    ax.plot(zoom_time, freq[zoom_start:zoom_end]/1000)
    ax.set_title('ESP32 TX1 - Preamble area (bits 10-50)')
    ax.set_xlabel('Time (µs)')
    ax.set_ylabel('Freq (kHz)')
    ax.axhline(np.median(freq[zoom_start:zoom_end])/1000, color='r', linestyle='--', label='Median')
    ax.legend()
    for i in range(40):
        bit_time = i * SAMPLES_PER_BIT / SAMPLE_RATE * 1e6
        ax.axvline(bit_time, color='gray', linestyle=':', alpha=0.2)

    plt.tight_layout()
    plt.savefig('~/lutron-tools/lutron-tools/rf/bit_timing.png', dpi=100)
    print("Saved bit timing plot to rf/bit_timing.png")

    # Also print raw frequency values at bit centers
    print("\n=== Real Pico bit center frequencies (first 60 bits) ===")
    segment = real_iq[pad_start:pad_start + int(200 * SAMPLES_PER_BIT)]
    freq = demodulate_fsk(real_iq[real_txs[0][0]-200:real_txs[0][0]+int(200*SAMPLES_PER_BIT)])
    threshold = np.median(freq)
    print(f"Threshold: {threshold/1000:.1f} kHz")
    bits = []
    for i in range(60):
        center = int((i + 0.5) * SAMPLES_PER_BIT)
        if center < len(freq):
            f = freq[center]
            bit = 1 if f > threshold else 0
            bits.append(str(bit))
    print(f"Bits: {''.join(bits)}")

    print("\n=== ESP32 bit center frequencies (first 60 bits) ===")
    freq = demodulate_fsk(esp32_iq[esp32_txs[0][0]-200:esp32_txs[0][0]+int(200*SAMPLES_PER_BIT)])
    threshold = np.median(freq)
    print(f"Threshold: {threshold/1000:.1f} kHz")
    bits = []
    for i in range(60):
        center = int((i + 0.5) * SAMPLES_PER_BIT)
        if center < len(freq):
            f = freq[center]
            bit = 1 if f > threshold else 0
            bits.append(str(bit))
    print(f"Bits: {''.join(bits)}")

if __name__ == "__main__":
    main()
