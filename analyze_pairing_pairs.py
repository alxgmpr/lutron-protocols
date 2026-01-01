#!/usr/bin/env python3
"""
Analyze the paired transmissions in pairing mode.
Looking at both the ~75 peak and ~105 peak packets.
"""

import numpy as np
import sys

SAMPLE_RATE = 2000000

def load_cu8(filename):
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_strong_transmissions(mag, threshold, min_gap_samples):
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

    strong_txs = []
    for start, end in zip(starts, ends):
        peak = np.max(mag[start:end])
        if peak > threshold:
            strong_txs.append((start, end, peak))

    return strong_txs

def decode_transmission(iq):
    phase = np.unwrap(np.angle(iq))
    freq = np.diff(phase) * SAMPLE_RATE / (2 * np.pi)
    threshold = np.median(freq)
    binary = (freq > threshold).astype(int)

    samples_per_bit = SAMPLE_RATE / 62500
    bits = []
    pos = 0
    while pos < len(binary):
        center = int(pos + samples_per_bit / 2)
        if center >= len(binary):
            break
        bits.append(binary[center])
        pos += samples_per_bit

    return bits

def decode_n81(bits):
    bytes_out = []
    i = 0
    while i < len(bits) - 10:
        if bits[i] == 0:
            byte_val = 0
            valid = True
            for j in range(8):
                if i + 1 + j < len(bits):
                    if bits[i + 1 + j]:
                        byte_val |= (1 << j)
                else:
                    valid = False
                    break
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

    iq = load_cu8(filename)
    mag = np.abs(iq)

    # Get ALL strong transmissions (>30 peak)
    all_txs = find_strong_transmissions(mag, 30, int(1 * SAMPLE_RATE / 1000))

    print(f"Total strong transmissions: {len(all_txs)}")

    # Filter to pairing phase only (after 7 seconds)
    pairing_txs = [(s, e, p) for s, e, p in all_txs if s / SAMPLE_RATE > 7.0]
    print(f"Pairing phase transmissions: {len(pairing_txs)}")

    # Look at the pattern of peaks
    print("\n" + "=" * 80)
    print("TRANSMISSION PAIR PATTERN (first 20)")
    print("=" * 80)

    for i in range(min(20, len(pairing_txs))):
        start, end, peak = pairing_txs[i]
        start_s = start / SAMPLE_RATE
        duration_ms = (end - start) / SAMPLE_RATE * 1000

        # Decode
        start_padded = max(0, start - 500)
        end_padded = min(len(iq), end + 500)
        segment = iq[start_padded:end_padded]

        bits = decode_transmission(segment)

        # Find alternating preamble
        best_pos, best_run = 0, 0
        for pos in range(len(bits) - 16):
            run = 0
            for j in range(min(64, len(bits) - pos)):
                expected = (bits[pos] + j) % 2
                if bits[pos + j] == expected:
                    run += 1
                else:
                    break
            if run > best_run:
                best_run = run
                best_pos = pos

        decoded = decode_n81(bits[best_pos + best_run:]) if best_run >= 16 else []

        # Find FA DE
        pkt_type = "?"
        seq = "?"
        for j in range(len(decoded) - 2):
            if decoded[j] == 0xFA and decoded[j+1] == 0xDE:
                payload = decoded[j+2:]
                if len(payload) > 1:
                    pkt_type = f"0x{payload[0]:02X}"
                    seq = f"0x{payload[1]:02X}"
                break

        peak_cat = "SHORT" if peak < 90 else "LONG"

        print(f"  TX {i+1:2d}: t={start_s:7.3f}s  dur={duration_ms:5.1f}ms  peak={peak:5.1f}  "
              f"bits={len(bits):4d}  preamble={best_run:2d}  type={pkt_type:5s}  seq={seq:5s}  [{peak_cat}]")

    # Now decode PAIRS and show side by side
    print("\n" + "=" * 80)
    print("PAIRED TRANSMISSIONS (SHORT + LONG)")
    print("=" * 80)

    pair_num = 0
    i = 0
    while i < len(pairing_txs) - 1:
        tx1_start, tx1_end, tx1_peak = pairing_txs[i]
        tx2_start, tx2_end, tx2_peak = pairing_txs[i + 1]

        # Check if they're a pair (gap < 30ms)
        gap_ms = (tx2_start - tx1_end) / SAMPLE_RATE * 1000
        if gap_ms > 30:
            i += 1
            continue

        pair_num += 1
        if pair_num > 15:  # Show first 15 pairs
            i += 2
            continue

        # Decode both
        def decode_tx(start, end):
            start_padded = max(0, start - 500)
            end_padded = min(len(iq), end + 500)
            segment = iq[start_padded:end_padded]
            bits = decode_transmission(segment)

            best_pos, best_run = 0, 0
            for pos in range(len(bits) - 16):
                run = 0
                for j in range(min(64, len(bits) - pos)):
                    expected = (bits[pos] + j) % 2
                    if bits[pos + j] == expected:
                        run += 1
                    else:
                        break
                if run > best_run:
                    best_run = run
                    best_pos = pos

            decoded = decode_n81(bits[best_pos + best_run:]) if best_run >= 16 else []

            # Find FA DE
            for j in range(len(decoded) - 2):
                if decoded[j] == 0xFA and decoded[j+1] == 0xDE:
                    return decoded[j+2:]  # Return payload after FA DE

            return decoded if len(decoded) > 0 else None

        payload1 = decode_tx(tx1_start, tx1_end)
        payload2 = decode_tx(tx2_start, tx2_end)

        print(f"\nPair {pair_num}: gap={gap_ms:.1f}ms")

        if payload1:
            hex1 = ' '.join(f'{b:02X}' for b in payload1[:40])
            print(f"  SHORT (peak={tx1_peak:.0f}): {hex1}")
            if len(payload1) > 5:
                dev_id = payload1[2] | (payload1[3]<<8) | (payload1[4]<<16) | (payload1[5]<<24)
                print(f"         Type=0x{payload1[0]:02X} Seq=0x{payload1[1]:02X} DevID=0x{dev_id:08X}")
        else:
            print(f"  SHORT (peak={tx1_peak:.0f}): [decode failed]")

        if payload2:
            hex2 = ' '.join(f'{b:02X}' for b in payload2[:40])
            print(f"  LONG  (peak={tx2_peak:.0f}): {hex2}")
            if len(payload2) > 5:
                dev_id = payload2[2] | (payload2[3]<<8) | (payload2[4]<<16) | (payload2[5]<<24)
                print(f"         Type=0x{payload2[0]:02X} Seq=0x{payload2[1]:02X} DevID=0x{dev_id:08X}")
        else:
            print(f"  LONG  (peak={tx2_peak:.0f}): [decode failed]")

        i += 2

    # Summary statistics
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)

    short_packets = []
    long_packets = []

    for start, end, peak in pairing_txs:
        start_padded = max(0, start - 500)
        end_padded = min(len(iq), end + 500)
        segment = iq[start_padded:end_padded]
        bits = decode_transmission(segment)

        best_pos, best_run = 0, 0
        for pos in range(len(bits) - 16):
            run = 0
            for j in range(min(64, len(bits) - pos)):
                expected = (bits[pos] + j) % 2
                if bits[pos + j] == expected:
                    run += 1
                else:
                    break
            if run > best_run:
                best_run = run
                best_pos = pos

        decoded = decode_n81(bits[best_pos + best_run:]) if best_run >= 16 else []

        for j in range(len(decoded) - 2):
            if decoded[j] == 0xFA and decoded[j+1] == 0xDE:
                payload = decoded[j+2:]
                if len(payload) > 0:
                    if peak < 90:
                        short_packets.append((peak, payload))
                    else:
                        long_packets.append((peak, payload))
                break

    print(f"Short packets decoded: {len(short_packets)}")
    print(f"Long packets decoded: {len(long_packets)}")

    # Analyze types in each
    from collections import Counter

    short_types = Counter(p[1][0] if len(p[1]) > 0 else 0 for p in short_packets)
    long_types = Counter(p[1][0] if len(p[1]) > 0 else 0 for p in long_packets)

    print(f"\nShort packet types: {dict((f'0x{k:02X}', v) for k, v in short_types.most_common())}")
    print(f"Long packet types: {dict((f'0x{k:02X}', v) for k, v in long_types.most_common())}")

    # Show cleanest of each
    print("\n" + "=" * 80)
    print("CLEANEST SHORT PACKET (highest peak)")
    print("=" * 80)

    if short_packets:
        best = max(short_packets, key=lambda x: x[0])
        payload = best[1]
        print(f"Peak: {best[0]:.0f}")
        for row in range(0, len(payload), 16):
            hex_part = ' '.join(f'{payload[row+i]:02X}' if row+i < len(payload) else '  ' for i in range(16))
            print(f"  [{row:02d}] {hex_part}")

    print("\n" + "=" * 80)
    print("CLEANEST LONG PACKET (highest peak)")
    print("=" * 80)

    if long_packets:
        best = max(long_packets, key=lambda x: x[0])
        payload = best[1]
        print(f"Peak: {best[0]:.0f}")
        for row in range(0, len(payload), 16):
            hex_part = ' '.join(f'{payload[row+i]:02X}' if row+i < len(payload) else '  ' for i in range(16))
            print(f"  [{row:02d}] {hex_part}")

if __name__ == '__main__':
    main()
