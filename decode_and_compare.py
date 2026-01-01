#!/usr/bin/env python3
"""Decode and compare RF captures between ESP32 and real Pico."""

import numpy as np
from scipy import signal

def load_capture(filename):
    """Load IQ capture file."""
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_packets(iq, sample_rate=2000000):
    """Find packet start positions."""
    mag = np.abs(iq)
    threshold = np.mean(mag) + 3 * np.std(mag)
    peaks = np.where(mag > threshold)[0]

    if len(peaks) == 0:
        return []

    # Find starts of transmissions
    tx_starts = [peaks[0]]
    gaps = np.diff(peaks)
    for i, gap in enumerate(gaps):
        if gap > 10000:  # > 5ms gap
            tx_starts.append(peaks[i+1])

    return tx_starts

def demodulate_fsk(iq, sample_rate=2000000):
    """Demodulate 2-FSK signal to bits."""
    # Instantaneous frequency via phase difference
    phase = np.unwrap(np.angle(iq))
    freq = np.diff(phase) * sample_rate / (2 * np.pi)
    return freq

def extract_packet_bits(iq, start, sample_rate=2000000, baud_rate=62500):
    """Extract bits from a packet starting at given sample."""
    samples_per_bit = sample_rate / baud_rate  # 32 samples per bit

    # Extract region around packet (expect ~80 bytes * 10 bits * 32 samples = 25600 samples)
    # But we need to find the actual end
    packet_len = int(100 * 10 * samples_per_bit)  # ~100 bytes max
    end = min(start + packet_len, len(iq))

    segment = iq[start:end]
    if len(segment) < 1000:
        return None, None

    # Demodulate
    freq = demodulate_fsk(segment, sample_rate)

    # Find the threshold between mark and space
    freq_threshold = np.median(freq)

    # Convert to binary
    binary = (freq > freq_threshold).astype(int)

    return binary, freq

def find_preamble(binary, samples_per_bit=32):
    """Find preamble (alternating 1010...) and return position after it."""
    # Look for alternating pattern
    pattern_len = int(samples_per_bit * 32)  # 32 bits of preamble

    for i in range(0, len(binary) - pattern_len, int(samples_per_bit)):
        segment = binary[i:i+pattern_len]
        # Check for alternation
        transitions = np.sum(np.abs(np.diff(segment)))
        if transitions > pattern_len * 0.8:  # High transition rate = preamble
            return i
    return None

def sample_bits(binary, start, num_bits, samples_per_bit=32):
    """Sample bits at proper intervals."""
    bits = []
    for i in range(num_bits):
        center = int(start + (i + 0.5) * samples_per_bit)
        if center >= len(binary):
            break
        # Sample middle of bit
        bits.append(binary[center])
    return bits

def decode_n81(bits):
    """Decode N81 serial encoding to bytes."""
    bytes_out = []
    i = 0
    while i < len(bits) - 10:
        # Look for start bit (0)
        if bits[i] == 0:
            # Extract 8 data bits LSB first
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

def analyze_packet(iq, start, sample_rate=2000000, baud_rate=62500):
    """Analyze a single packet and extract bytes."""
    samples_per_bit = sample_rate / baud_rate

    # Extract packet region
    packet_len = int(80 * 10 * samples_per_bit)
    end = min(start + packet_len, len(iq))
    segment = iq[start:end]

    if len(segment) < 1000:
        return None

    # Demodulate
    phase = np.unwrap(np.angle(segment))
    freq = np.diff(phase) * sample_rate / (2 * np.pi)

    # Binary threshold
    freq_threshold = np.median(freq)
    binary = (freq > freq_threshold).astype(int)

    # Find preamble
    preamble_pos = find_preamble(binary, samples_per_bit)
    if preamble_pos is None:
        return None

    # Skip preamble (32 bits)
    data_start = preamble_pos + int(32 * samples_per_bit)

    # Sample remaining bits
    remaining_bits = int((len(binary) - data_start) / samples_per_bit)
    bits = sample_bits(binary, data_start, remaining_bits, samples_per_bit)

    # Decode N81
    bytes_out = decode_n81(bits)

    return bytes_out

def compare_packets(pkt1, pkt2, name1="Pkt1", name2="Pkt2"):
    """Compare two packet byte arrays."""
    print(f"\n{'='*60}")
    print(f"Comparing {name1} vs {name2}")
    print(f"{'='*60}")

    if pkt1 is None:
        print(f"  {name1}: Failed to decode")
        return
    if pkt2 is None:
        print(f"  {name2}: Failed to decode")
        return

    print(f"  {name1}: {len(pkt1)} bytes")
    print(f"  {name2}: {len(pkt2)} bytes")

    # Show first 60 bytes of each
    print(f"\n  {name1}: {' '.join(f'{b:02X}' for b in pkt1[:60])}")
    print(f"  {name2}: {' '.join(f'{b:02X}' for b in pkt2[:60])}")

    # Find differences
    min_len = min(len(pkt1), len(pkt2))
    diffs = []
    for i in range(min_len):
        if pkt1[i] != pkt2[i]:
            diffs.append((i, pkt1[i], pkt2[i]))

    if diffs:
        print(f"\n  DIFFERENCES at {len(diffs)} positions:")
        for pos, v1, v2 in diffs[:20]:
            print(f"    Byte {pos}: {name1}=0x{v1:02X} vs {name2}=0x{v2:02X}")
    else:
        print(f"\n  First {min_len} bytes MATCH!")

# Main analysis
print("Loading captures...")
esp32_iq = load_capture('esp32_pairing.cu8')
pico_iq = load_capture('real_pico_pairing.cu8')

print(f"ESP32: {len(esp32_iq):,} samples")
print(f"Pico:  {len(pico_iq):,} samples")

# Find packets
esp32_starts = find_packets(esp32_iq)
pico_starts = find_packets(pico_iq)

print(f"\nESP32: {len(esp32_starts)} packets")
print(f"Pico:  {len(pico_starts)} packets")

# Analyze first few packets from each
print("\n" + "="*60)
print("DECODING PACKETS")
print("="*60)

esp32_packets = []
for i, start in enumerate(esp32_starts[:3]):
    pkt = analyze_packet(esp32_iq, start)
    if pkt and len(pkt) > 5:
        esp32_packets.append(pkt)
        print(f"\nESP32 Pkt {i+1}: {' '.join(f'{b:02X}' for b in pkt[:56])}")

pico_packets = []
for i, start in enumerate(pico_starts[:3]):
    pkt = analyze_packet(pico_iq, start)
    if pkt and len(pkt) > 5:
        pico_packets.append(pkt)
        print(f"\nPico Pkt {i+1}:  {' '.join(f'{b:02X}' for b in pkt[:56])}")

# Compare first packets
if esp32_packets and pico_packets:
    compare_packets(esp32_packets[0], pico_packets[0], "ESP32", "Real Pico")
