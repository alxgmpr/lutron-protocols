#!/usr/bin/env python3
"""
Compare ESP32 transmission to real Pico transmission.
Side-by-side analysis of packet structure, timing, and bytes.
"""

import numpy as np
import sys

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
        if peak > threshold and duration_ms > 1:  # Filter out tiny glitches
            txs.append((start, end, peak, duration_ms))
    return txs

def decode_transmission(iq):
    """Decode IQ to bits."""
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
    """Decode N81 serial to bytes."""
    bytes_out = []
    i = 0
    while i < len(bits) - 10:
        if bits[i] == 0:
            byte_val = 0
            for j in range(8):
                if i + 1 + j < len(bits) and bits[i + 1 + j]:
                    byte_val |= (1 << j)
            if i + 9 < len(bits) and bits[i + 9] == 1:
                bytes_out.append(byte_val)
                i += 10
            else:
                i += 1
        else:
            i += 1
    return bytes_out

def find_fade_payload(decoded):
    """Find FA DE and return payload."""
    for j in range(len(decoded) - 2):
        if decoded[j] == 0xFA and decoded[j+1] == 0xDE:
            return j, decoded[j+2:]
    return -1, None

def analyze_capture(filename, name, threshold=30):
    """Analyze a capture file and return decoded packets."""
    print(f"\n{'='*70}")
    print(f"ANALYZING: {name}")
    print(f"File: {filename}")
    print(f"{'='*70}")

    iq = load_cu8(filename)
    mag = np.abs(iq)

    print(f"Duration: {len(iq)/SAMPLE_RATE:.2f}s, Peak: {np.max(mag):.1f}")

    txs = find_transmissions(mag, threshold)
    print(f"Found {len(txs)} transmissions (threshold={threshold})")

    packets = []

    for i, (start, end, peak, duration_ms) in enumerate(txs[:30]):  # First 30
        start_padded = max(0, start - 500)
        end_padded = min(len(iq), end + 500)
        segment = iq[start_padded:end_padded]

        bits = decode_transmission(segment)

        # Find preamble
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

        decoded = decode_n81(bits[best_pos + best_run:]) if best_run >= 16 else []
        fade_pos, payload = find_fade_payload(decoded)

        if payload and len(payload) > 5:
            pkt_type = payload[0]
            seq = payload[1]
            dev_id = payload[2] | (payload[3]<<8) | (payload[4]<<16) | (payload[5]<<24)

            packets.append({
                'idx': i,
                'time': start / SAMPLE_RATE,
                'peak': peak,
                'duration_ms': duration_ms,
                'preamble_len': best_run,
                'bits': len(bits),
                'type': pkt_type,
                'seq': seq,
                'dev_id': dev_id,
                'payload': payload[:50],
                'raw_bits': bits[:100] if len(bits) >= 100 else bits
            })

    return packets

def compare_packets(pico_packets, esp32_packets):
    """Compare packets side by side."""
    print(f"\n{'='*70}")
    print("SIDE-BY-SIDE COMPARISON")
    print(f"{'='*70}")

    # Filter to just 0xB9 pairing packets
    pico_b9 = [p for p in pico_packets if p['type'] == 0xB9]
    esp32_b9 = [p for p in esp32_packets if p['type'] == 0xB9]

    print(f"\nPico 0xB9 packets: {len(pico_b9)}")
    print(f"ESP32 0xB9 packets: {len(esp32_b9)}")

    if not pico_b9:
        print("No Pico 0xB9 packets found!")
        return
    if not esp32_b9:
        print("No ESP32 0xB9 packets found!")
        # Show what we did find
        print("\nESP32 packet types found:")
        types = {}
        for p in esp32_packets:
            t = p['type']
            if t not in types:
                types[t] = 0
            types[t] += 1
        for t, count in sorted(types.items()):
            print(f"  0x{t:02X}: {count}")
        return

    # Compare timing
    print(f"\n--- TIMING ---")
    if len(pico_b9) > 1:
        pico_gaps = [pico_b9[i+1]['time'] - pico_b9[i]['time'] for i in range(min(10, len(pico_b9)-1))]
        print(f"Pico inter-packet gaps: {[f'{g*1000:.0f}ms' for g in pico_gaps]}")

    if len(esp32_b9) > 1:
        esp_gaps = [esp32_b9[i+1]['time'] - esp32_b9[i]['time'] for i in range(min(10, len(esp32_b9)-1))]
        print(f"ESP32 inter-packet gaps: {[f'{g*1000:.0f}ms' for g in esp_gaps]}")

    # Compare preamble
    print(f"\n--- PREAMBLE LENGTH ---")
    print(f"Pico:  {[p['preamble_len'] for p in pico_b9[:10]]}")
    print(f"ESP32: {[p['preamble_len'] for p in esp32_b9[:10]]}")

    # Compare packet duration
    print(f"\n--- PACKET DURATION ---")
    pico_durations = [f"{p['duration_ms']:.1f}ms" for p in pico_b9[:10]]
    esp_durations = [f"{p['duration_ms']:.1f}ms" for p in esp32_b9[:10]]
    print(f"Pico:  {pico_durations}")
    print(f"ESP32: {esp_durations}")

    # Compare first packet byte-by-byte
    print(f"\n--- FIRST PACKET BYTE COMPARISON ---")

    p_pkt = pico_b9[0]['payload']
    e_pkt = esp32_b9[0]['payload']

    print(f"\nPico  (seq=0x{pico_b9[0]['seq']:02X}, {len(p_pkt)} bytes):")
    for row in range(0, min(len(p_pkt), 48), 16):
        hex_part = ' '.join(f'{p_pkt[row+i]:02X}' if row+i < len(p_pkt) else '  ' for i in range(16))
        print(f"  [{row:02d}] {hex_part}")

    print(f"\nESP32 (seq=0x{esp32_b9[0]['seq']:02X}, {len(e_pkt)} bytes):")
    for row in range(0, min(len(e_pkt), 48), 16):
        hex_part = ' '.join(f'{e_pkt[row+i]:02X}' if row+i < len(e_pkt) else '  ' for i in range(16))
        print(f"  [{row:02d}] {hex_part}")

    # Find differences
    print(f"\n--- BYTE DIFFERENCES ---")
    min_len = min(len(p_pkt), len(e_pkt))
    diffs = []
    for i in range(min_len):
        if p_pkt[i] != e_pkt[i]:
            diffs.append((i, p_pkt[i], e_pkt[i]))

    if diffs:
        print(f"Found {len(diffs)} differences in first {min_len} bytes:")
        for pos, pv, ev in diffs[:20]:
            print(f"  [{pos:02d}] Pico=0x{pv:02X}  ESP32=0x{ev:02X}")
    else:
        print(f"First {min_len} bytes are IDENTICAL!")

    if len(p_pkt) != len(e_pkt):
        print(f"\nLength difference: Pico={len(p_pkt)} bytes, ESP32={len(e_pkt)} bytes")

    # Compare raw bits (preamble area)
    print(f"\n--- RAW BITS (first 80) ---")
    p_bits = ''.join(str(b) for b in pico_b9[0]['raw_bits'][:80])
    e_bits = ''.join(str(b) for b in esp32_b9[0]['raw_bits'][:80])
    print(f"Pico:  {p_bits}")
    print(f"ESP32: {e_bits}")

    # Compare sequences
    print(f"\n--- SEQUENCE NUMBERS ---")
    pico_seqs = ' '.join(f'{p["seq"]:02X}' for p in pico_b9[:15])
    esp_seqs = ' '.join(f'{p["seq"]:02X}' for p in esp32_b9[:15])
    print(f"Pico:  {pico_seqs}")
    print(f"ESP32: {esp_seqs}")

def main():
    pico_file = 'real_pico_ACTUAL_pairing.cu8'
    esp32_file = 'esp32_pairing_capture.cu8'

    # Analyze both captures
    # For Pico, use higher threshold to filter to just the strong pairing packets
    pico_packets = analyze_capture(pico_file, "Real Pico", threshold=100)
    esp32_packets = analyze_capture(esp32_file, "ESP32", threshold=30)

    # Print what we found
    print(f"\n--- PACKETS FOUND ---")
    print(f"Pico: {len(pico_packets)} packets decoded")
    for p in pico_packets[:5]:
        print(f"  Type=0x{p['type']:02X} Seq=0x{p['seq']:02X} DevID=0x{p['dev_id']:08X}")

    print(f"\nESP32: {len(esp32_packets)} packets decoded")
    for p in esp32_packets[:5]:
        print(f"  Type=0x{p['type']:02X} Seq=0x{p['seq']:02X} DevID=0x{p['dev_id']:08X}")

    # Compare
    compare_packets(pico_packets, esp32_packets)

if __name__ == '__main__':
    main()
