#!/usr/bin/env python3
"""
Compare raw RF signal shape between ESP32 and Pico.
Look for timing glitches, gaps, or amplitude differences.
"""

import numpy as np

SAMPLE_RATE = 2000000

def load_cu8(filename):
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_first_strong_tx(mag, threshold):
    """Find the first strong transmission."""
    weak_threshold = np.mean(mag[:100000]) + 4 * np.std(mag[:100000])
    active = mag > weak_threshold

    diff = np.diff(active.astype(int))
    starts = np.where(diff == 1)[0] + 1
    ends = np.where(diff == -1)[0] + 1

    if active[0]:
        starts = np.concatenate([[0], starts])
    if active[-1]:
        ends = np.concatenate([ends, [len(active)]])

    for start, end in zip(starts, ends):
        peak = np.max(mag[start:end])
        duration_ms = (end - start) / SAMPLE_RATE * 1000
        if peak > threshold and duration_ms > 5:
            return start, end, peak
    return None, None, None

def analyze_transmission(iq, start, end, name):
    """Analyze a single transmission in detail."""
    # Add some padding
    start = max(0, start - 1000)
    end = min(len(iq), end + 1000)

    segment = iq[start:end]
    mag = np.abs(segment)

    # FM demodulation
    phase = np.unwrap(np.angle(segment))
    freq = np.diff(phase) * SAMPLE_RATE / (2 * np.pi)

    # Binary threshold
    threshold = np.median(freq)
    binary = (freq > threshold).astype(int)

    # Sample bits at 62.5 kBaud
    samples_per_bit = SAMPLE_RATE / 62500
    bits = []
    for i in range(int(len(binary) / samples_per_bit)):
        center = int((i + 0.5) * samples_per_bit)
        if center < len(binary):
            bits.append(binary[center])

    print(f"\n{'='*60}")
    print(f"{name}")
    print(f"{'='*60}")
    print(f"Duration: {len(segment)/SAMPLE_RATE*1000:.2f}ms")
    print(f"Peak magnitude: {np.max(mag):.1f}")
    print(f"Frequency range: {np.min(freq)/1000:.1f} to {np.max(freq)/1000:.1f} kHz")
    print(f"Frequency threshold: {threshold/1000:.1f} kHz")
    print(f"Total bits: {len(bits)}")

    # Show first 200 bits
    bit_str = ''.join(str(b) for b in bits[:200])
    print(f"\nFirst 200 bits:")
    for i in range(0, min(200, len(bit_str)), 80):
        print(f"  {bit_str[i:i+80]}")

    # Look for preamble
    best_pos, best_run = 0, 0
    for pos in range(min(100, len(bits) - 32)):
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

    print(f"\nPreamble found at bit {best_pos}, length {best_run}")

    # Show what comes after preamble
    after_preamble = bits[best_pos + best_run:best_pos + best_run + 50]
    after_str = ''.join(str(b) for b in after_preamble)
    print(f"After preamble: {after_str}")

    # Decode first few bytes
    def decode_n81(bits_in):
        bytes_out = []
        i = 0
        while i < len(bits_in) - 10:
            if bits_in[i] == 0:  # Start bit
                byte_val = 0
                for j in range(8):
                    if bits_in[i + 1 + j]:
                        byte_val |= (1 << j)
                if bits_in[i + 9] == 1:  # Stop bit
                    bytes_out.append(byte_val)
                    i += 10
                else:
                    i += 1
            else:
                i += 1
        return bytes_out

    # Decode from after preamble
    decoded = decode_n81(bits[best_pos + best_run:])
    print(f"\nDecoded bytes ({len(decoded)}):")
    hex_str = ' '.join(f'{b:02X}' for b in decoded[:50])
    print(f"  {hex_str}")

    # Check for gaps in the magnitude signal (potential FIFO issues)
    print(f"\nLooking for transmission gaps...")
    mag_threshold = np.mean(mag) * 0.5
    below = mag < mag_threshold

    # Find gaps > 100 samples (0.05ms)
    gap_runs = []
    in_gap = False
    gap_start = 0
    for i, is_below in enumerate(below):
        if is_below and not in_gap:
            in_gap = True
            gap_start = i
        elif not is_below and in_gap:
            in_gap = False
            gap_len = i - gap_start
            if gap_len > 100:  # > 0.05ms
                gap_runs.append((gap_start, gap_len))

    if gap_runs:
        print(f"  Found {len(gap_runs)} gaps > 0.05ms:")
        for gs, gl in gap_runs[:5]:
            print(f"    At sample {gs} ({gs/SAMPLE_RATE*1000:.2f}ms): {gl} samples ({gl/SAMPLE_RATE*1000:.2f}ms)")
    else:
        print(f"  No significant gaps found (good!)")

    return segment, bits, decoded

def main():
    # Load captures
    print("Loading captures...")

    pico_iq = load_cu8('real_pico_ACTUAL_pairing.cu8')
    esp32_iq = load_cu8('esp32_pairing_capture.cu8')

    pico_mag = np.abs(pico_iq)
    esp32_mag = np.abs(esp32_iq)

    # Find first strong pairing packet from each
    # For Pico, skip the button press phase (first 7 seconds)
    pico_offset = int(7 * SAMPLE_RATE)
    pico_start, pico_end, pico_peak = find_first_strong_tx(pico_mag[pico_offset:], 100)
    if pico_start:
        pico_start += pico_offset
        pico_end += pico_offset

    esp_start, esp_end, esp_peak = find_first_strong_tx(esp32_mag, 50)

    print(f"\nPico first pairing TX: start={pico_start}, peak={pico_peak}")
    print(f"ESP32 first TX: start={esp_start}, peak={esp_peak}")

    if pico_start is None:
        print("No Pico transmission found!")
        return
    if esp_start is None:
        print("No ESP32 transmission found!")
        return

    # Analyze both
    pico_seg, pico_bits, pico_decoded = analyze_transmission(
        pico_iq, pico_start, pico_end, "REAL PICO PAIRING PACKET")

    esp_seg, esp_bits, esp_decoded = analyze_transmission(
        esp32_iq, esp_start, esp_end, "ESP32 PAIRING PACKET")

    # Direct bit comparison
    print(f"\n{'='*60}")
    print("DIRECT BIT COMPARISON")
    print(f"{'='*60}")

    min_bits = min(len(pico_bits), len(esp_bits), 200)
    matches = sum(1 for i in range(min_bits) if pico_bits[i] == esp_bits[i])
    print(f"First {min_bits} bits: {matches} match ({100*matches/min_bits:.1f}%)")

    # Try with inverted ESP bits
    matches_inv = sum(1 for i in range(min_bits) if pico_bits[i] != esp_bits[i])
    print(f"If ESP inverted: {matches_inv} would match ({100*matches_inv/min_bits:.1f}%)")

if __name__ == '__main__':
    main()
