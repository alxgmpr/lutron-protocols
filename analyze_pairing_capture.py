#!/usr/bin/env python3
"""
Analyze real Pico pairing capture from first principles.
No assumptions about packet structure - pure data-driven analysis.
"""

import numpy as np
import sys

SAMPLE_RATE = 2000000  # 2 MHz

def load_cu8(filename):
    """Load IQ capture file."""
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_transmissions(mag, threshold, min_gap_samples):
    """Find start/end of each transmission burst."""
    active = mag > threshold

    # Find transitions
    diff = np.diff(active.astype(int))
    starts = np.where(diff == 1)[0] + 1
    ends = np.where(diff == -1)[0] + 1

    # Handle edge cases
    if active[0]:
        starts = np.concatenate([[0], starts])
    if active[-1]:
        ends = np.concatenate([ends, [len(active)]])

    # Merge close transmissions (within min_gap)
    if len(starts) == 0:
        return []

    merged_starts = [starts[0]]
    merged_ends = []

    for i in range(len(starts)):
        if i > 0 and starts[i] - ends[i-1] > min_gap_samples:
            merged_ends.append(ends[i-1])
            merged_starts.append(starts[i])
    merged_ends.append(ends[-1])

    return list(zip(merged_starts, merged_ends))

def main():
    filename = sys.argv[1] if len(sys.argv) > 1 else 'real_pico_ACTUAL_pairing.cu8'

    print(f"=" * 70)
    print(f"ANALYZING: {filename}")
    print(f"=" * 70)

    # Load data
    iq = load_cu8(filename)
    duration_s = len(iq) / SAMPLE_RATE

    print(f"\n[FILE INFO]")
    print(f"  Samples: {len(iq):,}")
    print(f"  Duration: {duration_s:.2f} seconds")
    print(f"  Sample rate: {SAMPLE_RATE/1e6:.1f} MHz")

    # Calculate magnitude
    mag = np.abs(iq)

    # Adaptive threshold from first 50ms (should be noise)
    noise_samples = int(0.05 * SAMPLE_RATE)
    noise_floor = np.mean(mag[:noise_samples])
    noise_std = np.std(mag[:noise_samples])
    threshold = noise_floor + 4 * noise_std

    print(f"\n[SIGNAL LEVELS]")
    print(f"  Noise floor: {noise_floor:.1f}")
    print(f"  Noise std: {noise_std:.2f}")
    print(f"  Detection threshold: {threshold:.1f}")
    print(f"  Peak signal: {np.max(mag):.1f}")
    print(f"  Signal-to-noise: {(np.max(mag) - noise_floor) / noise_std:.1f} sigma")

    # Find transmission bursts (gap > 2ms = separate transmission)
    min_gap_ms = 2
    min_gap_samples = int(min_gap_ms * SAMPLE_RATE / 1000)

    transmissions = find_transmissions(mag, threshold, min_gap_samples)

    print(f"\n[TRANSMISSION STRUCTURE]")
    print(f"  Total transmissions found: {len(transmissions)}")

    if not transmissions:
        print("  No transmissions detected!")
        return

    # Analyze each transmission
    print(f"\n  {'#':>3}  {'Start (ms)':>10}  {'Duration (ms)':>13}  {'Gap after (ms)':>14}  {'Peak':>6}")
    print(f"  {'-'*3}  {'-'*10}  {'-'*13}  {'-'*14}  {'-'*6}")

    durations = []
    gaps = []

    for i, (start, end) in enumerate(transmissions):
        duration_ms = (end - start) / SAMPLE_RATE * 1000
        start_ms = start / SAMPLE_RATE * 1000
        peak = np.max(mag[start:end])

        durations.append(duration_ms)

        if i < len(transmissions) - 1:
            gap_ms = (transmissions[i+1][0] - end) / SAMPLE_RATE * 1000
            gaps.append(gap_ms)
            gap_str = f"{gap_ms:>14.1f}"
        else:
            gap_str = f"{'---':>14}"

        # Only print first 20 and last 5
        if i < 20 or i >= len(transmissions) - 5:
            print(f"  {i+1:>3}  {start_ms:>10.1f}  {duration_ms:>13.2f}  {gap_str}  {peak:>6.1f}")
        elif i == 20:
            print(f"  ... ({len(transmissions) - 25} more) ...")

    # Statistics
    print(f"\n[TIMING STATISTICS]")
    print(f"  Transmission durations:")
    print(f"    Min: {min(durations):.2f} ms")
    print(f"    Max: {max(durations):.2f} ms")
    print(f"    Mean: {np.mean(durations):.2f} ms")
    print(f"    Std: {np.std(durations):.2f} ms")

    if gaps:
        print(f"  Gaps between transmissions:")
        print(f"    Min: {min(gaps):.2f} ms")
        print(f"    Max: {max(gaps):.2f} ms")
        print(f"    Mean: {np.mean(gaps):.2f} ms")

        # Look for distinct gap patterns
        gap_array = np.array(gaps)
        short_gaps = gap_array[gap_array < 100]
        long_gaps = gap_array[gap_array >= 100]

        if len(short_gaps) > 0 and len(long_gaps) > 0:
            print(f"  Gap patterns detected:")
            print(f"    Short gaps (<100ms): {len(short_gaps)}, mean={np.mean(short_gaps):.1f}ms")
            print(f"    Long gaps (>=100ms): {len(long_gaps)}, mean={np.mean(long_gaps):.1f}ms")

    # Total RF time
    total_active_time = sum(durations)
    print(f"\n  Total RF active time: {total_active_time:.1f} ms ({total_active_time/1000:.2f} s)")
    print(f"  Duty cycle: {total_active_time / (duration_s * 1000) * 100:.1f}%")

    # Look for phases based on large gaps
    print(f"\n[PHASE DETECTION]")
    phase_threshold_ms = 200  # Gaps > 200ms indicate phase change

    phases = []
    current_phase_start = 0
    current_phase_txs = []

    for i, (start, end) in enumerate(transmissions):
        current_phase_txs.append(i)

        if i < len(transmissions) - 1:
            gap_ms = (transmissions[i+1][0] - end) / SAMPLE_RATE * 1000
            if gap_ms > phase_threshold_ms:
                phases.append({
                    'start_idx': current_phase_start,
                    'end_idx': i,
                    'count': len(current_phase_txs),
                    'start_ms': transmissions[current_phase_start][0] / SAMPLE_RATE * 1000,
                    'end_ms': end / SAMPLE_RATE * 1000,
                    'gap_after': gap_ms
                })
                current_phase_start = i + 1
                current_phase_txs = []

    # Add final phase
    if current_phase_txs:
        phases.append({
            'start_idx': current_phase_start,
            'end_idx': len(transmissions) - 1,
            'count': len(current_phase_txs),
            'start_ms': transmissions[current_phase_start][0] / SAMPLE_RATE * 1000,
            'end_ms': transmissions[-1][1] / SAMPLE_RATE * 1000,
            'gap_after': None
        })

    print(f"  Found {len(phases)} distinct phases (gaps > {phase_threshold_ms}ms):")
    for i, phase in enumerate(phases):
        duration = phase['end_ms'] - phase['start_ms']
        gap_str = f", gap after: {phase['gap_after']:.0f}ms" if phase['gap_after'] else ""
        print(f"    Phase {i+1}: {phase['count']} transmissions over {duration:.0f}ms{gap_str}")

    # Now decode first few transmissions to see raw data
    print(f"\n[RAW BIT ANALYSIS - First 3 transmissions]")

    for tx_idx in range(min(3, len(transmissions))):
        start, end = transmissions[tx_idx]
        segment = iq[start:end]

        # FM demod
        phase = np.unwrap(np.angle(segment))
        freq = np.diff(phase) * SAMPLE_RATE / (2 * np.pi)

        # Binary threshold
        threshold_freq = np.median(freq)
        binary = (freq > threshold_freq).astype(int)

        # Sample at ~62.5 kBaud (32 samples per bit)
        samples_per_bit = SAMPLE_RATE / 62500

        bits = []
        pos = 0
        while pos < len(binary):
            center = int(pos + samples_per_bit / 2)
            if center >= len(binary):
                break
            bits.append(binary[center])
            pos += samples_per_bit

        print(f"\n  TX {tx_idx + 1}: {len(bits)} bits sampled")

        # Show as groups of 10 (N81 frame size)
        bit_str = ''.join(str(b) for b in bits[:200])  # First 200 bits
        print(f"    Raw bits: {bit_str[:80]}")
        if len(bit_str) > 80:
            print(f"              {bit_str[80:160]}")

        # Try to find preamble pattern (alternating bits)
        preamble_found = False
        for i in range(len(bits) - 32):
            # Check for alternating pattern
            is_alternating = True
            for j in range(32):
                expected = (bits[i] + j) % 2
                if bits[i + j] != expected:
                    is_alternating = False
                    break
            if is_alternating:
                print(f"    Preamble at bit {i}: {''.join(str(b) for b in bits[i:i+32])}")
                preamble_found = True
                break

        if not preamble_found:
            print(f"    No clean 32-bit alternating preamble found")

        # Decode bytes assuming N81 after looking for start bit patterns
        def decode_n81(bits, start_pos=0):
            """Decode N81 serial from bit stream."""
            bytes_out = []
            i = start_pos
            while i < len(bits) - 10:
                if bits[i] == 0:  # Start bit
                    byte_val = 0
                    for j in range(8):
                        if i + 1 + j < len(bits) and bits[i + 1 + j]:
                            byte_val |= (1 << j)
                    # Check stop bit
                    if i + 9 < len(bits) and bits[i + 9] == 1:
                        bytes_out.append(byte_val)
                        i += 10
                    else:
                        i += 1
                else:
                    i += 1
            return bytes_out

        decoded = decode_n81(bits)
        if len(decoded) > 3:
            hex_str = ' '.join(f'{b:02X}' for b in decoded[:40])
            print(f"    Decoded bytes ({len(decoded)}): {hex_str}")

            # Look for FA DE marker
            for i in range(len(decoded) - 1):
                if decoded[i] == 0xFA and decoded[i+1] == 0xDE:
                    payload = decoded[i+2:]
                    print(f"    Found FA DE at byte {i}")
                    print(f"    Payload type: 0x{payload[0]:02X}" if payload else "    (no payload)")
                    if len(payload) > 5:
                        dev_id = payload[1] | (payload[2]<<8) | (payload[3]<<16) | (payload[4]<<24)
                        print(f"    Device ID: 0x{dev_id:08X}")
                    break

if __name__ == '__main__':
    main()
