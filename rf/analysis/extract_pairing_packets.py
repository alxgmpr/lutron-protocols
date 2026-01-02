#!/usr/bin/env python3
"""
Extract and analyze the CLEAN pairing packets (0xB9) from capture.
Focus on understanding exact structure.
"""

import numpy as np
import sys

SAMPLE_RATE = 2000000

def load_cu8(filename):
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_strong_transmissions(mag, strong_threshold, min_gap_samples):
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
        if peak > strong_threshold:
            strong_txs.append((start, end, peak))

    # Merge close ones
    if len(strong_txs) == 0:
        return []

    merged = [strong_txs[0]]
    for tx in strong_txs[1:]:
        start, end, peak = tx
        prev_start, prev_end, prev_peak = merged[-1]
        if start - prev_end < min_gap_samples:
            merged[-1] = (prev_start, end, max(prev_peak, peak))
        else:
            merged.append(tx)

    return merged

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

def find_preamble(bits):
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

    transmissions = find_strong_transmissions(mag, 30, int(3 * SAMPLE_RATE / 1000))

    print(f"Found {len(transmissions)} strong transmissions")
    print()

    # Focus on the pairing phase (after the 5-second gap)
    pairing_packets = []

    for i, (start, end, peak) in enumerate(transmissions):
        start_s = start / SAMPLE_RATE

        # Skip the initial button press phase (before ~7 seconds)
        if start_s < 7.0:
            continue

        # Only use the stronger of the alternating pairs (the ~105 peak ones)
        if peak < 100:
            continue

        start_padded = max(0, start - 1000)
        end_padded = min(len(iq), end + 1000)
        segment = iq[start_padded:end_padded]

        bits = decode_transmission(segment)
        preamble_pos, preamble_len = find_preamble(bits)

        if preamble_len < 20:
            continue

        decode_start = preamble_pos + preamble_len
        decoded = decode_n81(bits[decode_start:])

        # Look for FA DE
        fa_de_pos = -1
        for j in range(len(decoded) - 1):
            if decoded[j] == 0xFA and decoded[j+1] == 0xDE:
                fa_de_pos = j
                break

        if fa_de_pos >= 0 and len(decoded) > fa_de_pos + 45:
            payload = decoded[fa_de_pos + 2:]
            if payload[0] == 0xB9:  # Only pairing packets
                pairing_packets.append({
                    'tx': i + 1,
                    'time': start_s,
                    'peak': peak,
                    'payload': payload[:53]  # Max 53 bytes
                })

    print(f"Extracted {len(pairing_packets)} clean 0xB9 pairing packets")
    print()

    # Analyze structure
    print("=" * 80)
    print("PAIRING PACKET STRUCTURE ANALYSIS (Type 0xB9)")
    print("=" * 80)

    # Show first 5 packets in detail
    for i, pkt in enumerate(pairing_packets[:5]):
        payload = pkt['payload']
        print(f"\nPacket {i+1} (TX {pkt['tx']}, t={pkt['time']:.3f}s, peak={pkt['peak']:.0f}):")
        print(f"  Raw ({len(payload)} bytes):")
        hex_str = ' '.join(f'{b:02X}' for b in payload)
        # Split into 16-byte rows
        for row in range(0, len(hex_str), 48):
            offset = row // 3
            print(f"    [{offset:02d}] {hex_str[row:row+48]}")

    # Find consistent bytes across all packets
    print("\n" + "=" * 80)
    print("BYTE-BY-BYTE ANALYSIS (across all packets)")
    print("=" * 80)

    if len(pairing_packets) > 3:
        # Compare byte positions
        min_len = min(len(p['payload']) for p in pairing_packets)

        print(f"\nAnalyzing {len(pairing_packets)} packets, {min_len} bytes each")
        print(f"\nPos  Values (first 8 packets)                              Consistent?")
        print("-" * 75)

        for pos in range(min(min_len, 50)):
            values = [p['payload'][pos] for p in pairing_packets[:8]]
            unique = set(values)

            val_str = ' '.join(f'{v:02X}' for v in values)

            if len(unique) == 1:
                status = f"FIXED = 0x{values[0]:02X}"
            elif len(unique) <= 3:
                status = f"varies: {', '.join(f'0x{v:02X}' for v in sorted(unique))}"
            else:
                status = "VARIES (many)"

            print(f"[{pos:02d}] {val_str}  {status}")

    # Extract the key fields
    print("\n" + "=" * 80)
    print("KEY FIELD EXTRACTION")
    print("=" * 80)

    for i, pkt in enumerate(pairing_packets[:10]):
        payload = pkt['payload']

        pkt_type = payload[0]
        seq = payload[1]
        dev_id = payload[2] | (payload[3] << 8) | (payload[4] << 16) | (payload[5] << 24)

        print(f"Pkt {i+1}: Type=0x{pkt_type:02X} Seq=0x{seq:02X} DevID=0x{dev_id:08X}")

    # Show sequence pattern
    print("\n" + "=" * 80)
    print("SEQUENCE PATTERN")
    print("=" * 80)

    seqs = [p['payload'][1] for p in pairing_packets]
    print(f"Sequences: {' '.join(f'{s:02X}' for s in seqs[:30])}")

    # Calculate sequence differences
    diffs = [seqs[i+1] - seqs[i] for i in range(len(seqs)-1) if seqs[i+1] >= seqs[i]]
    if diffs:
        from collections import Counter
        diff_counts = Counter(diffs)
        print(f"Sequence increments: {dict(diff_counts)}")

    # Show the template packet
    print("\n" + "=" * 80)
    print("CLEANEST PACKET (for template)")
    print("=" * 80)

    # Find packet with highest peak (best signal)
    best_pkt = max(pairing_packets, key=lambda p: p['peak'])
    print(f"Best packet: TX {best_pkt['tx']}, peak={best_pkt['peak']:.0f}")
    payload = best_pkt['payload']
    print(f"\nHex dump ({len(payload)} bytes):")
    for row in range(0, len(payload), 16):
        hex_part = ' '.join(f'{payload[row+i]:02X}' if row+i < len(payload) else '  ' for i in range(16))
        ascii_part = ''.join(chr(payload[row+i]) if 32 <= payload[row+i] < 127 else '.' for i in range(min(16, len(payload)-row)))
        print(f"  {row:02X}: {hex_part}  {ascii_part}")

    # CRC check
    print("\n" + "=" * 80)
    print("CRC ANALYSIS")
    print("=" * 80)

    for i, pkt in enumerate(pairing_packets[:5]):
        payload = pkt['payload']

        # Calculate CRC on payload minus last 2 bytes
        def calc_crc(data):
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
            for byte in data:
                crc_upper = crc_reg >> 8
                crc_reg = (((crc_reg << 8) & 0xFF00) + byte) ^ table[crc_upper]
            return crc_reg

        # Try different CRC positions
        for crc_offset in range(-4, 1):
            data_len = len(payload) + crc_offset - 2
            if data_len < 1:
                continue
            data = payload[:data_len]
            crc_bytes = payload[data_len:data_len+2]
            if len(crc_bytes) < 2:
                continue
            crc_in_pkt = (crc_bytes[0] << 8) | crc_bytes[1]
            calc = calc_crc(bytes(data))

            if calc == crc_in_pkt:
                print(f"Pkt {i+1}: CRC MATCH at offset {crc_offset}! data[:{data_len}] CRC=0x{calc:04X}")
                break
        else:
            # Show what we calculated
            data = payload[:-2]
            crc_bytes = payload[-2:]
            crc_in_pkt = (crc_bytes[0] << 8) | crc_bytes[1]
            calc = calc_crc(bytes(data))
            print(f"Pkt {i+1}: No CRC match. In packet: 0x{crc_in_pkt:04X}, Calculated: 0x{calc:04X}")

if __name__ == '__main__':
    main()
