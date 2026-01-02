#!/usr/bin/env python3
"""
Capture and analyze multiple Lutron button presses to understand the protocol.
"""

import math
import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from lutron_cca.encoding import decode_bitstream, encode_byte_n81
from lutron_cca.packet import LutronPacket
from lutron_cca.crc import verify_crc


def load_iq(filename):
    with open(filename, 'rb') as f:
        raw = f.read()
    iq = []
    for i in range(0, len(raw) - 1, 2):
        i_val = raw[i] - 127.5
        q_val = raw[i + 1] - 127.5
        iq.append((i_val, q_val))
    return iq


def magnitude(iq_sample):
    i, q = iq_sample
    return math.sqrt(i*i + q*q)


def fm_demod(iq):
    freq = []
    prev_phase = 0
    for i_val, q_val in iq:
        phase = math.atan2(q_val, i_val)
        diff = phase - prev_phase
        if diff > math.pi:
            diff -= 2 * math.pi
        elif diff < -math.pi:
            diff += 2 * math.pi
        freq.append(diff)
        prev_phase = phase
    return freq


def find_bursts(iq, threshold_mult=2.0, min_samples=800, min_gap=5000):
    """Find signal bursts with minimum gap between them."""
    mags = [magnitude(s) for s in iq]
    avg_mag = sum(mags) / len(mags)
    threshold = avg_mag * threshold_mult

    bursts = []
    in_burst = False
    start = 0
    last_end = -min_gap

    for i, m in enumerate(mags):
        if m > threshold and not in_burst:
            if i - last_end >= min_gap:  # Ensure gap from last burst
                in_burst = True
                start = i
        elif m <= threshold and in_burst:
            if i - start > min_samples:
                bursts.append((start, i))
                last_end = i
            in_burst = False

    return bursts


def bits_from_fm(fm_signal, sample_rate=250000, baud_rate=62500):
    samples_per_bit = sample_rate / baud_rate
    mean_val = sum(fm_signal) / len(fm_signal)
    normalized = [f - mean_val for f in fm_signal]

    bits = []
    pos = samples_per_bit / 2

    while pos < len(normalized):
        idx = int(pos)
        if idx < len(normalized):
            start = max(0, idx - 1)
            end = min(len(normalized), idx + 2)
            avg = sum(normalized[start:end]) / (end - start)
            bits.append('1' if avg > 0 else '0')
        pos += samples_per_bit

    return ''.join(bits)


def decode_burst(iq_burst):
    """Decode a burst, return raw packet bytes or None."""
    fm = fm_demod(iq_burst)
    bits = bits_from_fm(fm)

    sync_pattern = encode_byte_n81(0xFF)
    sync_pos = bits.find(sync_pattern)

    if sync_pos >= 0:
        packets = decode_bitstream(bits[max(0, sync_pos-32):], verbose=False)
        if packets:
            return packets[0]

    # Try inverted
    bits_inv = ''.join('1' if b == '0' else '0' for b in bits)
    sync_pos = bits_inv.find(sync_pattern)
    if sync_pos >= 0:
        packets = decode_bitstream(bits_inv[max(0, sync_pos-32):], verbose=False)
        if packets:
            return packets[0]

    return None


def analyze_capture(filename):
    """Analyze a capture file, return list of unique decoded packets."""
    iq = load_iq(filename)
    bursts = find_bursts(iq)

    packets = []
    seen_seqs = set()

    for start, end in bursts:
        iq_burst = iq[start:end]
        pkt_raw = decode_burst(iq_burst)

        if pkt_raw and len(pkt_raw) >= 24:
            seq = pkt_raw[1]
            # Only keep one packet per sequence number (avoid duplicates from same press)
            if seq not in seen_seqs:
                seen_seqs.add(seq)
                packets.append(pkt_raw)

    return packets


def compare_packets(packets):
    """Compare multiple packets and identify changing vs static bytes."""
    if len(packets) < 2:
        print("Need at least 2 packets to compare")
        return

    print(f"\n{'='*70}")
    print(f"PACKET COMPARISON ({len(packets)} unique packets)")
    print('='*70)

    # Print all packets
    for i, pkt in enumerate(packets):
        crc_ok = "✓" if verify_crc(pkt) else "✗"
        print(f"Pkt {i+1}: {' '.join(f'{b:02X}' for b in pkt)} CRC:{crc_ok}")

    # Analyze each byte position
    print(f"\n{'='*70}")
    print("BYTE ANALYSIS")
    print('='*70)

    field_names = [
        "Type", "Sequence", "DevID[0]", "DevID[1]", "DevID[2]", "DevID[3]",
        "Unk6", "Unk7", "Unk8", "Unk9", "Button", "Unk11", "Unk12",
        "Pad13", "Pad14", "Pad15", "Pad16", "Pad17", "Pad18", "Pad19",
        "Pad20", "Pad21", "CRC[0]", "CRC[1]"
    ]

    for byte_idx in range(min(24, min(len(p) for p in packets))):
        values = [p[byte_idx] for p in packets]
        unique_values = set(values)

        field = field_names[byte_idx] if byte_idx < len(field_names) else f"Byte{byte_idx}"

        if len(unique_values) == 1:
            # Static byte
            print(f"  [{byte_idx:2d}] {field:10s}: STATIC  = 0x{values[0]:02X}")
        else:
            # Changing byte
            val_str = ', '.join(f'0x{v:02X}' for v in values)

            # Check if it's a simple counter
            diffs = [values[i+1] - values[i] for i in range(len(values)-1)]
            if len(set(diffs)) == 1 and diffs[0] > 0:
                print(f"  [{byte_idx:2d}] {field:10s}: COUNTER (increment={diffs[0]}) values: {val_str}")
            else:
                print(f"  [{byte_idx:2d}] {field:10s}: VARIES  values: {val_str}")

    # Extract device ID
    if len(packets) > 0:
        pkt = packets[0]
        dev_id = f"{pkt[2]:02X}{pkt[3]:02X}{pkt[4]:02X}{pkt[5]:02X}".lower()
        print(f"\n  Device ID: {dev_id}")
        print(f"  Button code: 0x{pkt[10]:02X}")


def main():
    if len(sys.argv) < 2:
        print("Usage: python multi_capture.py <capture.raw> [capture2.raw ...]")
        print("\nAnalyzes Lutron RF captures to identify packet structure.")
        sys.exit(1)

    all_packets = []

    for filename in sys.argv[1:]:
        print(f"\nProcessing: {filename}")
        packets = analyze_capture(filename)
        print(f"  Found {len(packets)} unique packets")
        all_packets.extend(packets)

    if all_packets:
        compare_packets(all_packets)
    else:
        print("\nNo packets decoded!")


if __name__ == '__main__':
    main()
