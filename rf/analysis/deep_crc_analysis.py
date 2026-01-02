#!/usr/bin/env python3
"""
Deep CRC analysis of real Pico pairing packets.
Extract 5+ packets and analyze CRC patterns to find the correct algorithm.
"""

import numpy as np

SAMPLE_RATE = 2000000

def load_cu8(filename):
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_all_transmissions(mag, threshold, min_duration_ms=3):
    """Find all transmissions above threshold."""
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
        if start >= len(mag) or end > len(mag):
            continue
        peak = np.max(mag[start:end])
        duration_ms = (end - start) / SAMPLE_RATE * 1000
        if peak > threshold and duration_ms > min_duration_ms:
            txs.append((start, end, peak, duration_ms))

    return txs

def decode_transmission(iq):
    """Decode IQ to bytes."""
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
    """Find alternating preamble."""
    best_pos, best_run = 0, 0
    for pos in range(min(100, len(bits) - 16)):
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
    return best_pos, best_run

def decode_n81(bits):
    """Decode N81 serial to bytes."""
    bytes_out = []
    i = 0
    while i < len(bits) - 10:
        if bits[i] == 0:  # Start bit
            byte_val = 0
            for j in range(8):
                if i + 1 + j < len(bits) and bits[i + 1 + j]:
                    byte_val |= (1 << j)
            if i + 9 < len(bits) and bits[i + 9] == 1:  # Stop bit
                bytes_out.append(byte_val)
                i += 10
            else:
                i += 1
        else:
            i += 1
    return bytes_out

def find_fade_payload(decoded):
    """Find FA DE and return position and payload."""
    for j in range(len(decoded) - 2):
        if decoded[j] == 0xFA and decoded[j+1] == 0xDE:
            return j, decoded[j+2:]
    return -1, None

def calc_crc_ca0f(data, init=0x0000):
    """Calculate CRC with polynomial 0xCA0F."""
    # Build table
    table = []
    for i in range(256):
        crc = i << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0xCA0F) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
        table.append(crc)

    # Calculate CRC
    crc_reg = init
    for byte in data:
        crc_upper = crc_reg >> 8
        crc_reg = (((crc_reg << 8) & 0xFF00) + byte) ^ table[crc_upper]

    return crc_reg

def try_crc_variations(data, expected_crc):
    """Try different CRC init values and byte ranges."""
    results = []

    # Try different init values
    for init in [0x0000, 0xFFFF, 0xCA0F, 0x1234, 0x5555, 0xAAAA]:
        crc = calc_crc_ca0f(data, init)
        if crc == expected_crc:
            results.append(f"MATCH with init=0x{init:04X}")

        # Try inverted
        crc_inv = crc ^ 0xFFFF
        if crc_inv == expected_crc:
            results.append(f"MATCH with init=0x{init:04X} + XOR 0xFFFF")

    # Try different byte ranges
    for skip_start in range(3):
        for skip_end in range(3):
            if skip_start + skip_end >= len(data):
                continue
            subset = data[skip_start:len(data)-skip_end] if skip_end > 0 else data[skip_start:]
            for init in [0x0000, 0xFFFF]:
                crc = calc_crc_ca0f(subset, init)
                if crc == expected_crc:
                    results.append(f"MATCH: skip_start={skip_start}, skip_end={skip_end}, init=0x{init:04X}")

    return results

def main():
    print("Loading real Pico pairing capture...")
    iq = load_cu8('real_pico_ACTUAL_pairing.cu8')
    mag = np.abs(iq)

    print(f"Duration: {len(iq)/SAMPLE_RATE:.1f}s")

    # Find all transmissions after 7s (skip button presses)
    offset = int(7 * SAMPLE_RATE)
    txs = find_all_transmissions(mag[offset:], 80)

    print(f"Found {len(txs)} strong transmissions after 7s mark")

    # Extract and decode pairing packets
    pairing_packets = []

    for i, (start, end, peak, duration) in enumerate(txs[:50]):
        # Adjust for offset
        abs_start = start + offset
        abs_end = end + offset

        # Add padding
        pad_start = max(0, abs_start - 500)
        pad_end = min(len(iq), abs_end + 500)
        segment = iq[pad_start:pad_end]

        bits = decode_transmission(segment)
        preamble_pos, preamble_len = find_preamble(bits)

        if preamble_len < 16:
            continue

        decoded = decode_n81(bits[preamble_pos + preamble_len:])
        fade_pos, payload = find_fade_payload(decoded)

        if payload is None or len(payload) < 10:
            continue

        pkt_type = payload[0]

        # Only look at 0xB9 pairing packets
        if pkt_type == 0xB9 and len(payload) >= 47:
            pairing_packets.append({
                'index': i,
                'time': abs_start / SAMPLE_RATE,
                'peak': peak,
                'duration': duration,
                'preamble_len': preamble_len,
                'payload': payload[:47],  # First 47 bytes
                'full_decoded': decoded
            })

    print(f"\nExtracted {len(pairing_packets)} 0xB9 pairing packets")

    if len(pairing_packets) < 3:
        print("Not enough pairing packets found!")
        return

    print("\n" + "="*80)
    print("PAIRING PACKET ANALYSIS")
    print("="*80)

    for idx, pkt in enumerate(pairing_packets[:8]):
        payload = pkt['payload']

        # Last 2 bytes should be CRC
        data_bytes = payload[:45]
        crc_bytes = payload[45:47]
        captured_crc = (crc_bytes[0] << 8) | crc_bytes[1]

        # Our calculated CRC
        our_crc = calc_crc_ca0f(list(data_bytes), 0x0000)

        print(f"\n--- Packet {idx+1} (time={pkt['time']:.2f}s) ---")
        print(f"Type: 0x{payload[0]:02X}  Seq: 0x{payload[1]:02X}")

        # Show device ID
        dev_id = payload[2] | (payload[3]<<8) | (payload[4]<<16) | (payload[5]<<24)
        print(f"DevID: 0x{dev_id:08X}")

        # Show key bytes
        print(f"Bytes 6-12: {' '.join(f'{payload[i]:02X}' for i in range(6, 13))}")
        print(f"Bytes 18-19: {payload[18]:02X} {payload[19]:02X}")
        print(f"Bytes 28-35: {' '.join(f'{payload[i]:02X}' for i in range(28, 36))}")

        print(f"\nData (45 bytes): {' '.join(f'{b:02X}' for b in data_bytes)}")
        print(f"Captured CRC: 0x{captured_crc:04X}")
        print(f"Our CRC (init=0): 0x{our_crc:04X}")
        print(f"Difference: 0x{(captured_crc ^ our_crc):04X}")

        # Try to find matching CRC
        matches = try_crc_variations(list(data_bytes), captured_crc)
        if matches:
            print(f"CRC MATCHES FOUND: {matches}")
        else:
            print("No CRC match found with standard variations")

    # Analyze patterns across packets
    print("\n" + "="*80)
    print("CROSS-PACKET ANALYSIS")
    print("="*80)

    print("\nSequence numbers:")
    seqs = [pkt['payload'][1] for pkt in pairing_packets[:15]]
    print(f"  {' '.join(f'{s:02X}' for s in seqs)}")

    # Check for byte consistency
    print("\nByte consistency (should be same across all packets):")
    consistent_bytes = []
    for byte_pos in range(45):
        values = [pkt['payload'][byte_pos] for pkt in pairing_packets[:10]]
        if len(set(values)) == 1:
            consistent_bytes.append((byte_pos, values[0]))

    print(f"  Constant bytes: {len(consistent_bytes)} positions")
    for pos, val in consistent_bytes[:20]:
        print(f"    [{pos:2d}] = 0x{val:02X}")

    # Calculate CRC difference pattern
    print("\n" + "="*80)
    print("CRC DIFFERENCE ANALYSIS")
    print("="*80)

    for idx, pkt in enumerate(pairing_packets[:5]):
        payload = pkt['payload']
        data_bytes = list(payload[:45])
        crc_bytes = payload[45:47]
        captured_crc = (crc_bytes[0] << 8) | crc_bytes[1]

        # Try CRC on different subsets
        print(f"\nPacket {idx+1} (seq=0x{payload[1]:02X}):")
        print(f"  Captured CRC: 0x{captured_crc:04X}")

        for skip in range(4):
            crc = calc_crc_ca0f(data_bytes[skip:], 0x0000)
            print(f"  Skip {skip} bytes, init=0: 0x{crc:04X} (diff: 0x{(captured_crc ^ crc):04X})")

        # Try CRC excluding last byte before CRC
        for exclude_end in range(1, 4):
            crc = calc_crc_ca0f(data_bytes[:-exclude_end], 0x0000)
            print(f"  Exclude last {exclude_end} bytes: 0x{crc:04X} (diff: 0x{(captured_crc ^ crc):04X})")

if __name__ == '__main__':
    main()
