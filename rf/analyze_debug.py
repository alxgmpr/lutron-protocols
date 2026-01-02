#!/usr/bin/env python3
"""Analyze all transmissions in debug capture."""

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
    threshold = np.median(freq_filt)
    binary = (freq_filt > threshold).astype(int)
    return binary

def sample_bits(binary):
    bits = []
    pos = 0.0
    while pos < len(binary):
        center = int(pos + SAMPLES_PER_BIT / 2)
        if center >= len(binary):
            break
        bits.append(binary[center])
        pos += SAMPLES_PER_BIT
    return bits

iq = load_cu8("captures/debug_pattern.cu8")
txs = find_transmissions(iq)

print(f"Found {len(txs)} transmissions in debug capture\n")

for i, (start, end) in enumerate(txs):
    print(f"=== Transmission {i+1} ===")
    print(f"Time: {start/SAMPLE_RATE:.3f}s - {end/SAMPLE_RATE:.3f}s")
    print(f"Duration: {(end-start)/SAMPLE_RATE*1000:.1f} ms")

    pad_start = max(0, start - 200)
    pad_end = min(len(iq), end + 500)
    segment = iq[pad_start:pad_end]

    binary = demodulate_fsk(segment)
    bits = sample_bits(binary)
    bit_str = ''.join(str(b) for b in bits)

    print(f"Bits: {len(bits)}")
    print(f"First 100 bits: {bit_str[:100]}")

    # Check for preamble
    alt_count = 0
    for j in range(min(200, len(bits) - 1)):
        if bits[j] != bits[j+1]:
            alt_count += 1
        else:
            break

    print(f"Alternating bits at start: {alt_count}")

    # Look for sync pattern 0xFF = 0111111111
    sync_pattern = "0111111111"
    fa_de = "0010111111" + "0011110111"

    sync_pos = bit_str.find(sync_pattern)
    if sync_pos >= 0:
        print(f"Sync 0xFF found at bit {sync_pos}")
        after_sync = bit_str[sync_pos+10:sync_pos+30]
        print(f"After sync: {after_sync}")
        if after_sync == fa_de:
            print("  ✓ Prefix 0xFA 0xDE matches!")
        else:
            print(f"  ✗ Prefix mismatch! Expected: {fa_de}")
    else:
        print("Sync 0xFF NOT found")

    print()
