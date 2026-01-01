#!/usr/bin/env python3
"""
Analyze real Pico pairing capture - focus on STRONG signals only.
Filter out weak background noise/interference.
"""

import numpy as np
import sys

SAMPLE_RATE = 2000000  # 2 MHz

def load_cu8(filename):
    """Load IQ capture file."""
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_strong_transmissions(mag, strong_threshold, min_gap_samples):
    """Find transmissions where peak exceeds strong_threshold."""
    # First find all active regions
    weak_threshold = np.mean(mag[:100000]) + 4 * np.std(mag[:100000])
    active = mag > weak_threshold

    diff = np.diff(active.astype(int))
    starts = np.where(diff == 1)[0] + 1
    ends = np.where(diff == -1)[0] + 1

    if active[0]:
        starts = np.concatenate([[0], starts])
    if active[-1]:
        ends = np.concatenate([ends, [len(active)]])

    if len(starts) == 0:
        return []

    # Filter to only keep transmissions with strong peaks
    strong_txs = []
    for start, end in zip(starts, ends):
        peak = np.max(mag[start:end])
        if peak > strong_threshold:
            strong_txs.append((start, end, peak))

    # Merge close transmissions
    if len(strong_txs) == 0:
        return []

    merged = [strong_txs[0]]
    for tx in strong_txs[1:]:
        start, end, peak = tx
        prev_start, prev_end, prev_peak = merged[-1]

        if start - prev_end < min_gap_samples:
            # Merge
            merged[-1] = (prev_start, end, max(prev_peak, peak))
        else:
            merged.append(tx)

    return merged

def decode_transmission(iq, sample_rate=2000000, baud_rate=62500):
    """Decode a single transmission to bytes."""
    # FM demod
    phase = np.unwrap(np.angle(iq))
    freq = np.diff(phase) * sample_rate / (2 * np.pi)

    # Binary threshold
    threshold = np.median(freq)
    binary = (freq > threshold).astype(int)

    # Sample bits
    samples_per_bit = sample_rate / baud_rate
    bits = []
    pos = 0
    while pos < len(binary):
        center = int(pos + samples_per_bit / 2)
        if center >= len(binary):
            break
        bits.append(binary[center])
        pos += samples_per_bit

    return bits

def find_preamble(bits):
    """Find preamble (alternating pattern) and return position after it."""
    best_pos = 0
    best_run = 0

    for i in range(len(bits) - 16):
        run = 0
        for j in range(min(64, len(bits) - i)):
            expected = (bits[i] + j) % 2
            if bits[i + j] == expected:
                run += 1
            else:
                break
        if run > best_run:
            best_run = run
            best_pos = i

    return best_pos, best_run

def decode_n81(bits):
    """Decode N81 serial from bit stream."""
    bytes_out = []
    i = 0
    while i < len(bits) - 10:
        if bits[i] == 0:  # Start bit
            byte_val = 0
            valid = True
            for j in range(8):
                if i + 1 + j < len(bits):
                    if bits[i + 1 + j]:
                        byte_val |= (1 << j)
                else:
                    valid = False
                    break
            # Check stop bit
            if valid and i + 9 < len(bits) and bits[i + 9] == 1:
                bytes_out.append(byte_val)
                i += 10
            else:
                i += 1
        else:
            i += 1
    return bytes_out

def main():
    filename = sys.argv[1] if len(sys.argv) > 1 else 'real_pico_ACTUAL_pairing.cu8'

    print(f"=" * 70)
    print(f"ANALYZING STRONG SIGNALS: {filename}")
    print(f"=" * 70)

    iq = load_cu8(filename)
    mag = np.abs(iq)

    # Find signal statistics
    noise_floor = np.mean(mag[:100000])
    noise_std = np.std(mag[:100000])

    # Strong threshold - looking for signals at least 20x above noise
    strong_threshold = 30  # Based on seeing peaks of 79 vs background of 7

    print(f"\n[FILTERING]")
    print(f"  Noise floor: {noise_floor:.1f}")
    print(f"  Strong signal threshold: {strong_threshold}")
    print(f"  Peak in file: {np.max(mag):.1f}")

    # Find strong transmissions
    min_gap_samples = int(3 * SAMPLE_RATE / 1000)  # 3ms gap
    transmissions = find_strong_transmissions(mag, strong_threshold, min_gap_samples)

    print(f"\n[STRONG TRANSMISSIONS FOUND: {len(transmissions)}]")

    if not transmissions:
        print("  No strong transmissions found!")
        # Show histogram of peak values
        print("\n  Peak value histogram:")
        peaks = []
        active = mag > (noise_floor + 4 * noise_std)
        diff = np.diff(active.astype(int))
        starts = np.where(diff == 1)[0]
        ends = np.where(diff == -1)[0]
        if active[0]:
            starts = np.concatenate([[0], starts])
        if active[-1]:
            ends = np.concatenate([ends, [len(active)]])
        for s, e in zip(starts[:1000], ends[:1000]):
            peaks.append(np.max(mag[s:e]))
        peaks = np.array(peaks)
        for thresh in [5, 10, 20, 30, 50, 80]:
            count = np.sum(peaks > thresh)
            print(f"    Peaks > {thresh}: {count}")
        return

    # Analyze each strong transmission
    print(f"\n  {'#':>3}  {'Start (s)':>10}  {'Duration (ms)':>12}  {'Peak':>6}  {'Gap (ms)':>10}")
    print(f"  {'-'*3}  {'-'*10}  {'-'*12}  {'-'*6}  {'-'*10}")

    for i, (start, end, peak) in enumerate(transmissions):
        start_s = start / SAMPLE_RATE
        duration_ms = (end - start) / SAMPLE_RATE * 1000

        if i < len(transmissions) - 1:
            gap_ms = (transmissions[i+1][0] - end) / SAMPLE_RATE * 1000
            gap_str = f"{gap_ms:>10.1f}"
        else:
            gap_str = f"{'---':>10}"

        print(f"  {i+1:>3}  {start_s:>10.3f}  {duration_ms:>12.1f}  {peak:>6.1f}  {gap_str}")

    # Decode each strong transmission
    print(f"\n[DECODING STRONG TRANSMISSIONS]")

    all_packets = []

    for i, (start, end, peak) in enumerate(transmissions):
        # Add some padding
        start_padded = max(0, start - 1000)
        end_padded = min(len(iq), end + 1000)
        segment = iq[start_padded:end_padded]

        bits = decode_transmission(segment)

        # Find preamble
        preamble_pos, preamble_len = find_preamble(bits)

        print(f"\n  TX {i+1} ({peak:.0f} peak):")
        print(f"    Total bits: {len(bits)}")
        print(f"    Preamble at bit {preamble_pos}, length {preamble_len}")

        # Decode starting after preamble
        decode_start = preamble_pos + preamble_len
        decoded = decode_n81(bits[decode_start:])

        if len(decoded) < 3:
            # Try decoding from different offsets
            for offset in range(10):
                test_decoded = decode_n81(bits[decode_start + offset:])
                if len(test_decoded) > len(decoded):
                    decoded = test_decoded
                    print(f"    Better decode at offset +{offset}")

        if decoded:
            hex_str = ' '.join(f'{b:02X}' for b in decoded[:50])
            print(f"    Decoded {len(decoded)} bytes: {hex_str}")

            # Look for patterns
            # FA DE prefix
            for j in range(len(decoded) - 1):
                if decoded[j] == 0xFA and decoded[j+1] == 0xDE:
                    payload = decoded[j+2:]
                    print(f"    ** FA DE at byte {j} **")
                    if len(payload) > 0:
                        print(f"       Type: 0x{payload[0]:02X}")
                        if len(payload) > 5:
                            # Byte 1 = seq, bytes 2-5 = device ID
                            seq = payload[1] if len(payload) > 1 else 0
                            dev_id = (payload[2] | (payload[3]<<8) |
                                     (payload[4]<<16) | (payload[5]<<24)) if len(payload) > 5 else 0
                            print(f"       Seq: 0x{seq:02X}")
                            print(f"       DevID: 0x{dev_id:08X}")

                            all_packets.append({
                                'tx': i+1,
                                'type': payload[0],
                                'seq': seq,
                                'dev_id': dev_id,
                                'payload': payload[:60],
                                'peak': peak
                            })
                    break
            else:
                # No FA DE found, show first byte patterns
                if len(decoded) > 0:
                    print(f"    First bytes: {' '.join(f'{b:02X}' for b in decoded[:10])}")
        else:
            print(f"    Failed to decode bytes")

        # Show raw bits around expected preamble
        if preamble_len >= 16:
            bit_str = ''.join(str(b) for b in bits[preamble_pos:preamble_pos+80])
            print(f"    Bits from preamble: {bit_str}")

    # Summary
    if all_packets:
        print(f"\n{'='*70}")
        print(f"PACKET SUMMARY")
        print(f"{'='*70}")

        types = {}
        for pkt in all_packets:
            t = pkt['type']
            if t not in types:
                types[t] = []
            types[t].append(pkt)

        for pkt_type in sorted(types.keys()):
            pkts = types[pkt_type]
            print(f"\n  Type 0x{pkt_type:02X}: {len(pkts)} packets")
            # Show first and last
            if pkts:
                first = pkts[0]
                print(f"    First: seq=0x{first['seq']:02X}, devID=0x{first['dev_id']:08X}")
                print(f"           {' '.join(f'{b:02X}' for b in first['payload'][:30])}")
                if len(pkts) > 1:
                    last = pkts[-1]
                    print(f"    Last:  seq=0x{last['seq']:02X}, devID=0x{last['dev_id']:08X}")
                    print(f"           {' '.join(f'{b:02X}' for b in last['payload'][:30])}")

                # Check sequence pattern
                seqs = [p['seq'] for p in pkts]
                print(f"    Sequences: {' '.join(f'{s:02X}' for s in seqs[:15])}{'...' if len(seqs) > 15 else ''}")

if __name__ == '__main__':
    main()
