#!/usr/bin/env python3
"""
Analyze the FULL sequence of a real Pico pairing session.
Maybe pairing requires button presses before the 0xB9 packets.
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
        if peak > threshold and duration_ms > 2:
            txs.append((start, end, peak, duration_ms))
    return txs

def decode_packet(iq):
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

    # Find preamble
    best_pos, best_run = 0, 0
    for p in range(min(100, len(bits) - 16)):
        run = 0
        for j in range(min(64, len(bits) - p)):
            if bits[p + j] == (bits[p] + j) % 2:
                run += 1
            else:
                break
        if run > best_run:
            best_run = run
            best_pos = p

    if best_run < 16:
        return None, 0

    # Decode N81
    after = bits[best_pos + best_run:]
    decoded = []
    i = 0
    while i < len(after) - 10 and len(decoded) < 60:
        if after[i] == 0:
            byte_val = 0
            for j in range(8):
                if after[i + 1 + j]:
                    byte_val |= (1 << j)
            if after[i + 9] == 1:
                decoded.append(byte_val)
                i += 10
            else:
                i += 1
        else:
            i += 1

    # Find FA DE
    for j in range(len(decoded) - 2):
        if decoded[j] == 0xFA and decoded[j+1] == 0xDE:
            return decoded[j+2:], best_run

    return None, best_run

def main():
    print("Loading real Pico pairing capture...")
    iq = load_cu8('real_pico_ACTUAL_pairing.cu8')
    mag = np.abs(iq)

    print(f"Duration: {len(iq)/SAMPLE_RATE:.1f}s")

    # Find ALL transmissions (lower threshold)
    txs = find_transmissions(mag, 30)
    print(f"Total transmissions: {len(txs)}")

    print("\n" + "="*80)
    print("FULL PAIRING SESSION TIMELINE")
    print("="*80)

    timeline = []

    for i, (start, end, peak, duration) in enumerate(txs):
        pad_start = max(0, start - 500)
        pad_end = min(len(iq), end + 500)
        segment = iq[pad_start:pad_end]

        payload, preamble_len = decode_packet(segment)

        if payload is None or len(payload) < 3:
            pkt_type = "???"
            seq = "??"
        else:
            pkt_type = f"0x{payload[0]:02X}"
            seq = f"0x{payload[1]:02X}"

        time_s = start / SAMPLE_RATE

        timeline.append({
            'time': time_s,
            'type': pkt_type,
            'seq': seq,
            'duration': duration,
            'peak': peak,
            'preamble': preamble_len,
            'payload_len': len(payload) if payload else 0
        })

    # Print timeline grouped by phase
    print("\nPhase 1: Button presses (first 7 seconds)")
    print("-" * 70)
    phase1 = [t for t in timeline if t['time'] < 7]

    # Group by type
    type_counts = {}
    for t in phase1:
        tp = t['type']
        if tp not in type_counts:
            type_counts[tp] = 0
        type_counts[tp] += 1

    print(f"Total packets: {len(phase1)}")
    print(f"Packet types: {type_counts}")

    # Show first few
    print("\nFirst 10 button press packets:")
    for t in phase1[:10]:
        print(f"  {t['time']:5.2f}s | Type {t['type']} Seq {t['seq']} | {t['duration']:.1f}ms | peak={t['peak']:.0f}")

    print("\n" + "="*80)
    print("Phase 2: Pairing packets (after 7 seconds)")
    print("-" * 70)
    phase2 = [t for t in timeline if t['time'] >= 7]

    type_counts2 = {}
    for t in phase2:
        tp = t['type']
        if tp not in type_counts2:
            type_counts2[tp] = 0
        type_counts2[tp] += 1

    print(f"Total packets: {len(phase2)}")
    print(f"Packet types: {type_counts2}")

    # Show first few pairing
    print("\nFirst 15 pairing packets:")
    for t in phase2[:15]:
        print(f"  {t['time']:5.2f}s | Type {t['type']} Seq {t['seq']} | {t['duration']:.1f}ms | len={t['payload_len']}")

    # Gap analysis
    print("\n" + "="*80)
    print("TIMING ANALYSIS")
    print("-" * 70)

    if len(phase1) > 1:
        gaps1 = [(phase1[i+1]['time'] - phase1[i]['time'])*1000 for i in range(len(phase1)-1)]
        print(f"Phase 1 (button) inter-packet gaps: min={min(gaps1):.0f}ms max={max(gaps1):.0f}ms avg={np.mean(gaps1):.0f}ms")

    if len(phase2) > 1:
        gaps2 = [(phase2[i+1]['time'] - phase2[i]['time'])*1000 for i in range(len(phase2)-1)]
        print(f"Phase 2 (pairing) inter-packet gaps: min={min(gaps2):.0f}ms max={max(gaps2):.0f}ms avg={np.mean(gaps2):.0f}ms")

    # Transition
    if phase1 and phase2:
        transition_gap = (phase2[0]['time'] - phase1[-1]['time']) * 1000
        print(f"\nGap between last button and first pairing: {transition_gap:.0f}ms")

    print("\n" + "="*80)
    print("KEY INSIGHT")
    print("="*80)
    print("""
The real Pico pairing sequence appears to be:
1. Hold button for 3+ seconds
2. During hold: Send button press packets (0x88/0x8A/0x89/0x8B)
3. After hold: Send pairing packets (0xB9)

Our ESP32 might need to send button presses BEFORE pairing packets
to trigger the relay's pairing acceptance mode!
""")

if __name__ == '__main__':
    main()
