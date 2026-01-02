#!/usr/bin/env python3
"""
Final clean analysis of the 0xB9 pairing packets.
Focus only on the strongest signal packets for clean decoding.
"""

import numpy as np
import sys
from collections import Counter

SAMPLE_RATE = 2000000

def load_cu8(filename):
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_transmissions(mag, threshold):
    weak_threshold = np.mean(mag[:100000]) + 4 * np.std(mag[:100000])
    active = mag > weak_threshold

    diff = np.diff(active.astype(int))
    starts = np.where(diff == 1)[0] + 1
    ends = np.where(diff == -1)[0] + 1

    if active[0]:
        starts = np.concatenate([[0], starts])
    if active[-1]:
        ends = np.concatenate([ends, [len(active)]])

    txs = []
    for start, end in zip(starts, ends):
        peak = np.max(mag[start:end])
        if peak > threshold:
            txs.append((start, end, peak))
    return txs

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

def find_fade_payload(decoded):
    """Find FA DE marker and return payload after it."""
    for j in range(len(decoded) - 2):
        if decoded[j] == 0xFA and decoded[j+1] == 0xDE:
            return decoded[j+2:]
    return None

def main():
    filename = sys.argv[1] if len(sys.argv) > 1 else 'real_pico_ACTUAL_pairing.cu8'

    iq = load_cu8(filename)
    mag = np.abs(iq)

    # Find strong transmissions (>100 peak = cleanest signal)
    all_txs = find_transmissions(mag, 100)

    # Filter to pairing phase only (after 7 seconds)
    pairing_txs = [(s, e, p) for s, e, p in all_txs if s / SAMPLE_RATE > 7.0]

    print(f"Found {len(pairing_txs)} strong (>100 peak) transmissions in pairing phase")

    # Decode all packets
    packets = []
    for start, end, peak in pairing_txs:
        start_padded = max(0, start - 500)
        end_padded = min(len(iq), end + 500)
        segment = iq[start_padded:end_padded]

        bits = decode_transmission(segment)

        # Find preamble
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

        if best_run < 20:
            continue

        decoded = decode_n81(bits[best_pos + best_run:])
        payload = find_fade_payload(decoded)

        if payload and len(payload) >= 45 and payload[0] == 0xB9:
            packets.append({
                'peak': peak,
                'time': start / SAMPLE_RATE,
                'payload': payload[:55]  # Trim to reasonable size
            })

    print(f"Successfully decoded {len(packets)} 0xB9 pairing packets")

    # Build consensus packet by voting on each byte position
    print("\n" + "=" * 80)
    print("CONSENSUS PACKET STRUCTURE (majority voting)")
    print("=" * 80)

    if len(packets) < 3:
        print("Not enough packets for consensus")
        return

    min_len = min(len(p['payload']) for p in packets)
    consensus = []

    for pos in range(min_len):
        values = [p['payload'][pos] for p in packets]
        counter = Counter(values)
        most_common = counter.most_common(1)[0]
        consensus.append(most_common[0])

        # Show variation
        if len(counter) == 1:
            var = "FIXED"
        elif len(counter) <= 3:
            var = f"varies: {len(counter)} values"
        else:
            var = "VARIES"

        if pos < 45:  # Show first 45 positions
            val_sample = ' '.join(f'{values[i]:02X}' for i in range(min(5, len(values))))
            print(f"  [{pos:02d}] Consensus=0x{most_common[0]:02X} ({most_common[1]}/{len(packets)})  {var}  samples: {val_sample}")

    # Parse the consensus packet
    print("\n" + "=" * 80)
    print("PARSED CONSENSUS PACKET")
    print("=" * 80)

    print(f"\n  [0]     Type:     0x{consensus[0]:02X} = {'B9 (PAIRING)' if consensus[0] == 0xB9 else 'UNKNOWN'}")
    print(f"  [1]     Sequence: 0x{consensus[1]:02X} (varies each packet)")

    dev_id = consensus[2] | (consensus[3] << 8) | (consensus[4] << 16) | (consensus[5] << 24)
    print(f"  [2-5]   DeviceID: 0x{dev_id:08X} = {consensus[2]:02X} {consensus[3]:02X} {consensus[4]:02X} {consensus[5]:02X}")

    print(f"  [6]     Const:    0x{consensus[6]:02X}")
    print(f"  [7]     Const:    0x{consensus[7]:02X}")
    print(f"  [8]     Const:    0x{consensus[8]:02X}")
    print(f"  [9]     Const:    0x{consensus[9]:02X}")
    print(f"  [10]    Const:    0x{consensus[10]:02X}")
    print(f"  [11]    Const:    0x{consensus[11]:02X}")
    print(f"  [12]    Const:    0x{consensus[12]:02X}")
    print(f"  [13-17] Bcast:    FF FF FF FF FF")

    print(f"  [18]    Const:    0x{consensus[18]:02X}")
    print(f"  [19]    Field:    0x{consensus[19]:02X}")

    dev_id2 = consensus[20] | (consensus[21] << 8) | (consensus[22] << 16) | (consensus[23] << 24)
    print(f"  [20-23] DevID#2:  0x{dev_id2:08X}")

    dev_id3 = consensus[24] | (consensus[25] << 8) | (consensus[26] << 16) | (consensus[27] << 24)
    print(f"  [24-27] DevID#3:  0x{dev_id3:08X}")

    print(f"  [28]    Const:    0x{consensus[28]:02X}")
    print(f"  [29]    Const:    0x{consensus[29]:02X}")
    print(f"  [30]    Const:    0x{consensus[30]:02X}")
    print(f"  [31]    Const:    0x{consensus[31]:02X}")
    print(f"  [32-39] Fields:   {' '.join(f'{consensus[i]:02X}' for i in range(32, min(40, len(consensus))))}")
    print(f"  [40-43] Bcast#2:  FF FF FF FF")

    # Show raw consensus hex dump
    print("\n" + "=" * 80)
    print("RAW CONSENSUS PACKET (hex dump)")
    print("=" * 80)

    for row in range(0, len(consensus), 16):
        hex_part = ' '.join(f'{consensus[row+i]:02X}' for i in range(min(16, len(consensus)-row)))
        print(f"  {row:02X}: {hex_part}")

    # Show C array for implementation
    print("\n" + "=" * 80)
    print("C ARRAY FOR IMPLEMENTATION")
    print("=" * 80)

    print("const uint8_t PAIRING_TEMPLATE[] = {")
    for row in range(0, len(consensus), 12):
        hex_part = ', '.join(f'0x{consensus[row+i]:02X}' for i in range(min(12, len(consensus)-row)))
        print(f"    {hex_part},")
    print("};")

    # Sequence analysis
    print("\n" + "=" * 80)
    print("SEQUENCE ANALYSIS")
    print("=" * 80)

    seqs = [p['payload'][1] for p in packets]
    times = [p['time'] for p in packets]

    print(f"Sequences observed: {' '.join(f'{s:02X}' for s in seqs[:20])}")

    # Calculate time between packets
    if len(times) > 1:
        gaps = [times[i+1] - times[i] for i in range(len(times)-1)]
        print(f"Inter-packet gaps: min={min(gaps)*1000:.1f}ms max={max(gaps)*1000:.1f}ms mean={np.mean(gaps)*1000:.1f}ms")

    # Count packets per second
    duration = times[-1] - times[0]
    rate = len(packets) / duration
    print(f"Packet rate: {rate:.1f} packets/second")

    # Try to find pattern
    sorted_seqs = sorted(set(seqs))
    print(f"Unique sequences: {len(sorted_seqs)}")
    print(f"Sequence range: 0x{min(seqs):02X} to 0x{max(seqs):02X}")

    # Check for +6 pattern
    for i in range(len(seqs) - 1):
        diff = (seqs[i+1] - seqs[i]) % 256
        if diff != 6 and diff != 0:
            pass  # Non-standard increment found

if __name__ == '__main__':
    main()
