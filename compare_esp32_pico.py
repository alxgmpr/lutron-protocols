#!/usr/bin/env python3
"""Compare ESP32 and real Pico RF transmissions bit by bit."""

import numpy as np
import sys

def load_cu8(filename):
    """Load IQ capture file."""
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_transmissions(iq, sample_rate=2000000, min_gap_ms=3):
    """Find start positions of transmissions."""
    mag = np.abs(iq)
    # Adaptive threshold
    noise = np.mean(mag[:10000])
    threshold = noise + 2 * np.std(mag[:10000])

    active = mag > threshold
    active_samples = np.where(active)[0]

    if len(active_samples) == 0:
        return []

    min_gap_samples = int(min_gap_ms * sample_rate / 1000)

    starts = [active_samples[0]]
    for i in range(1, len(active_samples)):
        if active_samples[i] - active_samples[i-1] > min_gap_samples:
            starts.append(active_samples[i])

    return starts

def demod_and_sample(iq, sample_rate=2000000, baud_rate=62500):
    """Demodulate FSK and sample bits."""
    samples_per_bit = sample_rate / baud_rate

    # FM demod via phase derivative
    phase = np.unwrap(np.angle(iq))
    freq = np.diff(phase) * sample_rate / (2 * np.pi)

    # Binary threshold
    threshold = np.median(freq)
    binary = freq > threshold

    # Sample at bit centers
    bits = []
    pos = 0
    while pos < len(binary):
        center = int(pos + samples_per_bit / 2)
        if center >= len(binary):
            break
        bits.append(1 if binary[center] else 0)
        pos += samples_per_bit

    return bits

def bits_to_hex(bits):
    """Convert bit array to hex bytes (for display)."""
    # Each byte is: start(0) + 8 data LSB first + stop(1) = 10 bits
    bytes_out = []
    i = 0
    while i < len(bits) - 9:
        # Look for start bit
        if bits[i] == 0:
            byte_val = 0
            for j in range(8):
                if bits[i + 1 + j]:
                    byte_val |= (1 << j)
            bytes_out.append(byte_val)
            i += 10
        else:
            i += 1
    return bytes_out

def analyze_capture(filename, name):
    """Analyze a capture file and return decoded packets."""
    print(f"\n{'='*60}")
    print(f"Analyzing: {name}")
    print(f"File: {filename}")
    print(f"{'='*60}")

    try:
        iq = load_cu8(filename)
    except Exception as e:
        print(f"  Error loading: {e}")
        return []

    print(f"Loaded {len(iq):,} samples ({len(iq)/2000000:.2f}s)")

    starts = find_transmissions(iq)
    print(f"Found {len(starts)} transmissions")

    packets = []

    for i, start in enumerate(starts[:8]):
        # Extract segment for this transmission
        end = min(start + 30000, len(iq))
        segment = iq[start:end]

        bits = demod_and_sample(segment)

        if len(bits) < 50:
            continue

        hex_bytes = bits_to_hex(bits)

        if len(hex_bytes) < 5:
            continue

        # Look for FA DE
        for j in range(len(hex_bytes) - 1):
            if hex_bytes[j] == 0xFA and hex_bytes[j+1] == 0xDE:
                payload = hex_bytes[j+2:]
                if len(payload) >= 3:
                    packets.append({
                        'tx_num': i,
                        'full': hex_bytes,
                        'payload': payload
                    })
                    print(f"\n  TX {i+1}: {len(payload)} bytes after FA DE")
                    print(f"    Type: 0x{payload[0]:02X}")
                    print(f"    Seq:  0x{payload[1]:02X}")
                    if len(payload) >= 6:
                        dev_id = payload[2] | (payload[3]<<8) | (payload[4]<<16) | (payload[5]<<24)
                        print(f"    DevID: 0x{dev_id:08X}")
                    print(f"    Full: {' '.join(f'{b:02X}' for b in payload[:28])}")

                    # CRC check
                    if len(payload) >= 3:
                        data = payload[:-2]
                        crc_bytes = payload[-2:]

                        # CRC calculation
                        table = []
                        for k in range(256):
                            crc = k << 8
                            for _ in range(8):
                                if crc & 0x8000:
                                    crc = ((crc << 1) ^ 0xCA0F) & 0xFFFF
                                else:
                                    crc = (crc << 1) & 0xFFFF
                            table.append(crc)

                        crc_reg = 0
                        for b in data:
                            crc_upper = crc_reg >> 8
                            crc_reg = (((crc_reg << 8) & 0xFF00) + b) ^ table[crc_upper]

                        in_pkt = (crc_bytes[0] << 8) | crc_bytes[1]
                        print(f"    CRC in packet: 0x{in_pkt:04X}, Calculated: 0x{crc_reg:04X} {'✓' if in_pkt == crc_reg else '✗'}")
                break

    return packets

# Main
esp32 = analyze_capture('esp32_btn_capture.cu8', 'ESP32 Button Press')
pico = analyze_capture('real_pico_pairing.cu8', 'Real Pico (button press capture)')

print("\n" + "="*60)
print("COMPARISON")
print("="*60)

if esp32 and pico:
    print(f"ESP32: {len(esp32)} packets decoded")
    print(f"Pico:  {len(pico)} packets decoded")

    # Compare first packet of each
    if esp32 and pico:
        e = esp32[0]['payload']
        p = pico[0]['payload']
        print(f"\nFirst packet comparison:")
        print(f"  ESP32: {' '.join(f'{b:02X}' for b in e[:24])}")
        print(f"  Pico:  {' '.join(f'{b:02X}' for b in p[:24])}")

        # Find differences
        min_len = min(len(e), len(p))
        diffs = []
        for i in range(min_len):
            if e[i] != p[i]:
                diffs.append((i, e[i], p[i]))

        if diffs:
            print(f"\n  Differences:")
            for pos, ev, pv in diffs[:10]:
                print(f"    Byte {pos}: ESP32=0x{ev:02X} vs Pico=0x{pv:02X}")
        else:
            print(f"\n  ✓ First {min_len} bytes match!")
else:
    print("Could not decode packets from both files")
