#!/usr/bin/env python3
"""Decode RF capture to extract exact bytes."""

import numpy as np
import sys

def load_cu8(filename):
    """Load IQ capture file."""
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def demodulate_fsk(iq, sample_rate=2000000):
    """Demodulate 2-FSK using instantaneous frequency."""
    phase = np.unwrap(np.angle(iq))
    freq = np.diff(phase) * sample_rate / (2 * np.pi)
    return freq

def sample_bits(binary, samples_per_bit, offset=0):
    """Sample bits at center of each bit period."""
    bits = []
    for i in range(int((len(binary) - offset) / samples_per_bit)):
        center = int(offset + (i + 0.5) * samples_per_bit)
        if center >= len(binary):
            break
        bits.append(int(binary[center]))
    return bits

def decode_n81(bits):
    """Decode async N81 serial to bytes."""
    bytes_out = []
    i = 0
    while i < len(bits) - 10:
        # Look for start bit (0)
        if bits[i] == 0:
            # Next 8 bits are data, LSB first
            data_bits = bits[i+1:i+9]
            if len(data_bits) == 8:
                byte_val = 0
                for j, b in enumerate(data_bits):
                    byte_val |= (b << j)
                bytes_out.append(byte_val)
            i += 10  # Skip to after stop bit
        else:
            i += 1
    return bytes_out

def find_signal_start(iq, threshold_mult=2.0):
    """Find where the RF signal starts."""
    mag = np.abs(iq)
    threshold = np.mean(mag[:10000]) + threshold_mult * np.std(mag[:10000])
    starts = np.where(mag > threshold)[0]
    if len(starts) > 0:
        return starts[0]
    return 0

def decode_packet(iq, sample_rate=2000000, baud_rate=62500):
    """Decode a packet from IQ samples."""
    samples_per_bit = sample_rate / baud_rate  # 32 samples per bit

    # Demodulate
    freq = demodulate_fsk(iq, sample_rate)

    # Binary threshold (median frequency)
    threshold = np.median(freq)
    binary = (freq > threshold).astype(int)

    # Find preamble (alternating pattern)
    # Look for where we get lots of transitions
    window = int(samples_per_bit * 8)
    transitions = []
    for i in range(0, len(binary) - window, int(samples_per_bit)):
        t = np.sum(np.abs(np.diff(binary[i:i+window])))
        transitions.append((i, t))

    if not transitions:
        return None

    # Find highest transition region (preamble)
    transitions.sort(key=lambda x: -x[1])
    preamble_start = transitions[0][0]

    # Sample bits starting from preamble
    bits = sample_bits(binary, samples_per_bit, preamble_start)

    # Find sync byte 0xFF (start bit = 0, then 8 ones, stop bit = 1)
    # After N81 encoding: 0-11111111-1 = start(0) + data(FF) + stop(1)
    sync_pattern = [0, 1, 1, 1, 1, 1, 1, 1, 1, 1]  # Start bit + 0xFF + stop bit

    sync_pos = None
    for i in range(len(bits) - 10):
        if bits[i:i+10] == sync_pattern:
            sync_pos = i
            break

    if sync_pos is None:
        # Also look for FA DE pattern after preamble ends
        print("  Sync 0xFF not found, trying FA DE...")
        fa_pattern = [0, 0, 1, 0, 1, 1, 1, 1, 1, 1]  # Start bit + 0xFA LSB first + stop
        for i in range(len(bits) - 10):
            if bits[i:i+10] == fa_pattern:
                sync_pos = i
                print(f"  Found FA at bit position {i}")
                break

    if sync_pos is not None:
        # Decode all bytes from sync position
        decoded_bytes = decode_n81(bits[sync_pos:])
        return decoded_bytes

    return None

# Main
if len(sys.argv) < 2:
    filename = 'real_pico_pairing.cu8'
else:
    filename = sys.argv[1]

print(f"Loading {filename}...")
iq = load_cu8(filename)
print(f"Loaded {len(iq):,} samples")

# Find signal
sig_start = find_signal_start(iq)
print(f"Signal starts at sample {sig_start}")

# Find all transmissions (gaps > 5ms)
SAMPLE_RATE = 2000000
mag = np.abs(iq)
threshold = np.mean(mag) + 2 * np.std(mag)
active = mag > threshold
active_samples = np.where(active)[0]

if len(active_samples) == 0:
    print("No signal found!")
    sys.exit(1)

# Find starts of each transmission
tx_starts = [active_samples[0]]
gaps = np.diff(active_samples)
for i, gap in enumerate(gaps):
    if gap > 10000:  # > 5ms gap
        tx_starts.append(active_samples[i+1])

print(f"Found {len(tx_starts)} transmissions")

# Decode first few transmissions
for t, start in enumerate(tx_starts[:5]):
    print(f"\n=== Transmission {t+1} at sample {start} ===")

    # Extract segment (enough for ~100 bytes * 10 bits * 32 samples)
    end = min(start + 40000, len(iq))
    segment = iq[start:end]

    decoded = decode_packet(segment)

    if decoded and len(decoded) > 3:
        print(f"Decoded {len(decoded)} bytes:")
        print("  " + " ".join(f"{b:02X}" for b in decoded))

        # Look for FA DE
        for i in range(len(decoded) - 1):
            if decoded[i] == 0xFA and decoded[i+1] == 0xDE:
                print(f"\nFound FA DE at position {i}")
                payload = decoded[i+2:]
                print(f"Payload after FA DE ({len(payload)} bytes):")
                print("  " + " ".join(f"{b:02X}" for b in payload))

                # Calculate CRC on payload minus last 2 bytes
                if len(payload) >= 3:
                    data = payload[:-2]
                    crc_bytes = payload[-2:]
                    crc_in_packet = (crc_bytes[0] << 8) | crc_bytes[1]

                    # Calculate expected CRC
                    def calc_crc(data):
                        table = []
                        for i in range(256):
                            crc = i << 8
                            for _ in range(8):
                                if crc & 0x8000:
                                    crc = ((crc << 1) ^ 0xCA0F) & 0xFFFF
                                else:
                                    crc = (crc << 1) & 0xFFFF
                            table.append(crc)

                        crc_reg = 0
                        for byte in data:
                            crc_upper = crc_reg >> 8
                            crc_reg = (((crc_reg << 8) & 0xFF00) + byte) ^ table[crc_upper]
                        return crc_reg

                    calc = calc_crc(bytes(data))
                    print(f"\nCRC analysis:")
                    print(f"  Last 2 bytes: {crc_bytes[0]:02X} {crc_bytes[1]:02X}")
                    print(f"  As big-endian: 0x{crc_in_packet:04X}")
                    print(f"  Calculated:    0x{calc:04X}")
                    if calc == crc_in_packet:
                        print("  ✓ CRC MATCHES!")
                    else:
                        # Try different data lengths
                        for offset in range(-3, 4):
                            if len(payload) + offset > 2:
                                test_data = payload[:len(data)+offset]
                                test_crc = calc_crc(bytes(test_data))
                                if test_crc == crc_in_packet:
                                    print(f"  ✓ CRC matches with {offset:+d} bytes adjustment")
                                    break
                break
    else:
        print("  Failed to decode or too short")
