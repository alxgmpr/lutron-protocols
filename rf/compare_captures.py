#!/usr/bin/env python3
"""Compare two RF captures to find differences."""

import sys
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
    return binary, freq_filt

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

def bits_to_hex(bits, start=0, count=32):
    """Convert bits to hex string for display."""
    result = []
    for i in range(start, min(start + count * 8, len(bits)), 8):
        byte = 0
        for j in range(8):
            if i + j < len(bits):
                byte = (byte << 1) | bits[i + j]
        result.append(f"{byte:02X}")
    return " ".join(result)

def analyze_transmission(iq_segment, label):
    if len(iq_segment) < 100:
        return None

    binary, freq = demodulate_fsk(iq_segment)
    bits = sample_bits(binary)

    print(f"\n=== {label} ===")
    print(f"Duration: {len(iq_segment) / SAMPLE_RATE * 1000:.1f} ms")
    print(f"Bits: {len(bits)}")

    # Find preamble
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

    print(f"Preamble: {best_run} bits at pos {best_pos}")

    # Show first 200 bits
    bit_str = ''.join(str(b) for b in bits[:200])
    print(f"First 200 bits:\n  {bit_str[:50]}")
    print(f"  {bit_str[50:100]}")
    print(f"  {bit_str[100:150]}")
    print(f"  {bit_str[150:200]}")

    # Look for sync pattern 0xFF encoded = 0111111111
    sync_pattern = "0111111111"
    fa_pattern = "0010111111"  # 0xFA encoded
    de_pattern = "0011110111"  # 0xDE encoded

    sync_pos = bit_str.find(sync_pattern)
    print(f"Sync (0xFF) at bit: {sync_pos}")

    if sync_pos >= 0:
        after_sync = bit_str[sync_pos+10:sync_pos+30]
        print(f"After sync (20 bits): {after_sync}")
        print(f"Expected 0xFA+0xDE: {fa_pattern}{de_pattern}")
        if after_sync == fa_pattern + de_pattern:
            print("  ✓ Prefix matches!")
        else:
            print("  ✗ Prefix mismatch!")

    # Show frequency deviation
    freq_in_tx = freq[100:-100] if len(freq) > 200 else freq
    print(f"Freq deviation: min={np.min(freq_in_tx)/1000:.1f} kHz, max={np.max(freq_in_tx)/1000:.1f} kHz")
    print(f"Freq spread: {(np.max(freq_in_tx) - np.min(freq_in_tx))/1000:.1f} kHz")

    return bits

def main():
    if len(sys.argv) < 3:
        print("Usage: compare_captures.py <real_capture.cu8> <esp32_capture.cu8>")
        sys.exit(1)

    real_file = sys.argv[1]
    esp32_file = sys.argv[2]

    print("Loading captures...")
    real_iq = load_cu8(real_file)
    esp32_iq = load_cu8(esp32_file)

    print(f"Real capture: {len(real_iq)/SAMPLE_RATE:.1f}s")
    print(f"ESP32 capture: {len(esp32_iq)/SAMPLE_RATE:.1f}s")

    # Find transmissions
    real_txs = find_transmissions(real_iq)
    esp32_txs = find_transmissions(esp32_iq)

    print(f"\nReal transmissions: {len(real_txs)}")
    print(f"ESP32 transmissions: {len(esp32_txs)}")

    # Analyze first few from each
    print("\n" + "="*80)
    print("REAL PICO TRANSMISSIONS")
    print("="*80)

    for i, (start, end) in enumerate(real_txs[:3]):
        pad_start = max(0, start - 200)
        pad_end = min(len(real_iq), end + 500)
        segment = real_iq[pad_start:pad_end]
        analyze_transmission(segment, f"Real TX {i+1}")

    print("\n" + "="*80)
    print("ESP32 TRANSMISSIONS")
    print("="*80)

    for i, (start, end) in enumerate(esp32_txs[:3]):
        pad_start = max(0, start - 200)
        pad_end = min(len(esp32_iq), end + 500)
        segment = esp32_iq[pad_start:pad_end]
        analyze_transmission(segment, f"ESP32 TX {i+1}")

if __name__ == "__main__":
    main()
