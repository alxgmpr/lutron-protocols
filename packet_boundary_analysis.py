#!/usr/bin/env python3
"""
Analyze exact packet boundaries in real Pico pairing packets.
The CRC being 0xCCCC suggests we're misidentifying where packets end.
"""

import numpy as np

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
        duration_ms = (end - start) / SAMPLE_RATE * 1000
        if peak > threshold and duration_ms > 3:
            txs.append((start, end, peak, duration_ms))
    return txs

def decode_to_bits(iq):
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

def decode_n81_verbose(bits, max_bytes=60):
    """Decode N81, tracking start/stop bit validity."""
    bytes_out = []
    positions = []
    i = 0
    while i < len(bits) - 10 and len(bytes_out) < max_bytes:
        if bits[i] == 0:  # Start bit
            byte_val = 0
            for j in range(8):
                if i + 1 + j < len(bits) and bits[i + 1 + j]:
                    byte_val |= (1 << j)
            stop_bit = bits[i + 9] if i + 9 < len(bits) else -1

            if stop_bit == 1:  # Valid frame
                bytes_out.append(byte_val)
                positions.append((i, 'valid'))
                i += 10
            else:
                # Invalid stop bit - might be end of packet
                positions.append((i, f'bad_stop={stop_bit}'))
                i += 1
        else:
            i += 1
    return bytes_out, positions

def calc_crc(data, init=0x0000):
    table = []
    for i in range(256):
        crc = i << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0xCA0F) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
        table.append(crc)
    crc_reg = init
    for byte in data:
        crc_upper = crc_reg >> 8
        crc_reg = (((crc_reg << 8) & 0xFF00) + byte) ^ table[crc_upper]
    return crc_reg

def main():
    print("Loading real Pico pairing capture...")
    iq = load_cu8('real_pico_ACTUAL_pairing.cu8')
    mag = np.abs(iq)

    # Get transmissions after 7s
    offset = int(7 * SAMPLE_RATE)
    txs = find_transmissions(mag[offset:], 80)
    print(f"Found {len(txs)} transmissions")

    # Analyze first few 0xB9 packets in detail
    analyzed = 0

    for tx_idx, (start, end, peak, duration) in enumerate(txs[:30]):
        abs_start = start + offset
        abs_end = end + offset

        pad_start = max(0, abs_start - 500)
        pad_end = min(len(iq), abs_end + 500)
        segment = iq[pad_start:pad_end]

        bits = decode_to_bits(segment)
        preamble_pos, preamble_len = find_preamble(bits)

        if preamble_len < 16:
            continue

        # Decode after preamble
        after_preamble = bits[preamble_pos + preamble_len:]
        decoded, positions = decode_n81_verbose(after_preamble, max_bytes=60)

        # Find FA DE
        fade_idx = -1
        for j in range(len(decoded) - 2):
            if decoded[j] == 0xFA and decoded[j+1] == 0xDE:
                fade_idx = j
                break

        if fade_idx < 0:
            continue

        payload = decoded[fade_idx + 2:]

        if len(payload) < 10 or payload[0] != 0xB9:
            continue

        analyzed += 1
        if analyzed > 5:
            break

        print(f"\n{'='*80}")
        print(f"PACKET {analyzed} (TX #{tx_idx}, time={abs_start/SAMPLE_RATE:.2f}s)")
        print(f"{'='*80}")
        print(f"Duration: {duration:.1f}ms, Peak: {peak:.0f}")
        print(f"Preamble: {preamble_len} bits at position {preamble_pos}")
        print(f"Total decoded bytes: {len(decoded)}")
        print(f"FA DE at index: {fade_idx}")
        print(f"Payload bytes after FA DE: {len(payload)}")

        # Show all decoded bytes with hex
        print(f"\nAll decoded bytes ({len(decoded)}):")
        for row in range(0, len(decoded), 16):
            hex_part = ' '.join(f'{decoded[row+i]:02X}' for i in range(min(16, len(decoded)-row)))
            print(f"  [{row:2d}] {hex_part}")

        # Find where CC padding starts
        cc_start = -1
        for j in range(len(payload)):
            if payload[j] == 0xCC:
                # Check if rest is all CC
                if all(b == 0xCC for b in payload[j:j+5] if j+5 <= len(payload)):
                    cc_start = j
                    break

        print(f"\n0xCC padding starts at payload byte: {cc_start}")

        if cc_start > 0:
            actual_payload = payload[:cc_start]
            print(f"Actual payload length (before CC): {len(actual_payload)}")

            # Assuming last 2 bytes are CRC
            if len(actual_payload) >= 3:
                data = actual_payload[:-2]
                crc_bytes = actual_payload[-2:]
                captured_crc = (crc_bytes[0] << 8) | crc_bytes[1]

                print(f"\nPayload (excluding CC padding):")
                print(f"  Data ({len(data)} bytes): {' '.join(f'{b:02X}' for b in data)}")
                print(f"  CRC bytes: {crc_bytes[0]:02X} {crc_bytes[1]:02X} = 0x{captured_crc:04X}")

                our_crc = calc_crc(list(data), 0x0000)
                print(f"  Our CRC (init=0): 0x{our_crc:04X}")

                if our_crc == captured_crc:
                    print("  *** CRC MATCHES! ***")
                else:
                    print(f"  Difference: 0x{(captured_crc ^ our_crc):04X}")

                    # Try different init values
                    for init in [0xFFFF, 0xCA0F, 0x1D0F]:
                        test_crc = calc_crc(list(data), init)
                        if test_crc == captured_crc:
                            print(f"  *** CRC MATCHES with init=0x{init:04X}! ***")

        # Also look at the raw bit pattern after last valid byte
        print(f"\nN81 decode positions (last 10):")
        for pos, status in positions[-10:]:
            print(f"  Bit {pos}: {status}")

if __name__ == '__main__':
    main()
