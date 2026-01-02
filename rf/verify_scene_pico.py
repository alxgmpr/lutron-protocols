#!/usr/bin/env python3
"""Verify ESP32 Scene Pico transmission with correct threshold."""

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

def get_center_threshold(freq):
    """Get center threshold from FSK peaks."""
    hist, bins = np.histogram(freq, bins=100)
    bin_centers = (bins[:-1] + bins[1:]) / 2
    peak_idx = np.argsort(hist)[-2:]
    peak_freqs = bin_centers[peak_idx]
    return (peak_freqs[0] + peak_freqs[1]) / 2

def sample_bits(freq, threshold):
    bits = []
    pos = 0.0
    while pos < len(freq):
        center = int(pos + SAMPLES_PER_BIT / 2)
        if center >= len(freq):
            break
        bits.append(1 if freq[center] > threshold else 0)
        pos += SAMPLES_PER_BIT
    return bits

def decode_n81(bits, start):
    """Decode N81 byte starting at bit position."""
    if start + 10 > len(bits):
        return None, False
    if bits[start] != 0:  # Start bit must be 0
        return None, False
    if bits[start + 9] != 1:  # Stop bit must be 1
        return None, False

    # Data bits LSB first
    value = 0
    for i in range(8):
        if bits[start + 1 + i]:
            value |= (1 << i)
    return value, True

def find_sync_and_decode(bits):
    """Find sync 0xFF and decode packet."""
    bit_str = ''.join(str(b) for b in bits)

    # Find sync pattern (0xFF encoded = 0111111111)
    sync = "0111111111"
    fa_de = "00101111110011110111"

    sync_pos = bit_str.find(sync)
    if sync_pos < 0:
        return None

    prefix_pos = sync_pos + 10
    if bit_str[prefix_pos:prefix_pos+20] != fa_de:
        print(f"  Prefix mismatch at {prefix_pos}")
        print(f"  Expected: {fa_de}")
        print(f"  Got:      {bit_str[prefix_pos:prefix_pos+20]}")
        return None

    # Decode payload after prefix
    data_start = prefix_pos + 20
    payload = []
    pos = data_start
    while len(payload) < 24:
        byte_val, valid = decode_n81(bits, pos)
        if not valid:
            break
        payload.append(byte_val)
        pos += 10

    return payload

# Load and analyze the original ESP32 Scene Pico capture
print("="*70)
print("Re-analyzing ESP32 Scene Pico capture with correct threshold")
print("="*70)

iq = load_cu8("captures/esp32_scene_pico_bright.cu8")
txs = find_transmissions(iq)

print(f"\nFound {len(txs)} transmissions\n")

decoded_count = 0
for i, (start, end) in enumerate(txs[:6]):  # First 6 transmissions
    print(f"=== TX {i+1} at {start/SAMPLE_RATE:.3f}s ===")

    pad_start = max(0, start - 200)
    pad_end = min(len(iq), end + 500)
    segment = iq[pad_start:pad_end]

    freq = demodulate_fsk(segment)
    center = get_center_threshold(freq)
    median = np.median(freq)

    print(f"Center threshold: {center/1000:.1f} kHz, Median: {median/1000:.1f} kHz")

    bits = sample_bits(freq, center)
    bit_str = ''.join(str(b) for b in bits[:80])
    print(f"First 80 bits: {bit_str}")

    payload = find_sync_and_decode(bits)
    if payload:
        decoded_count += 1
        print(f"✓ Decoded {len(payload)} bytes:")
        print(f"  {' '.join(f'{b:02X}' for b in payload)}")

        # Parse packet
        if len(payload) >= 12:
            pkt_type = payload[0]
            seq = payload[1]
            dev_id = (payload[2] << 24) | (payload[3] << 16) | (payload[4] << 8) | payload[5]
            if len(payload) > 10:
                button = payload[10]
                print(f"  Type: 0x{pkt_type:02X}, Seq: {seq}, DevID: {dev_id:08X}, Button: 0x{button:02X}")
    else:
        print(f"✗ Failed to decode")

    print()

print(f"Decoded {decoded_count}/{min(6, len(txs))} transmissions")
