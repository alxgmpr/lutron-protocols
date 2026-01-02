#!/usr/bin/env python3
"""
Diagnose WHY there are bit errors in ESP32 transmission.
Compare frequency deviation, bit timing, etc.
"""

import numpy as np

SAMPLE_RATE = 2000000

def load_cu8(filename):
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_strong_tx(iq, threshold=50, skip_seconds=0):
    mag = np.abs(iq)
    start_idx = int(skip_seconds * SAMPLE_RATE)

    weak_thresh = np.mean(mag[:100000]) + 4 * np.std(mag[:100000])
    active = mag > weak_thresh

    diff = np.diff(active.astype(int))
    starts = np.where(diff == 1)[0] + 1
    ends = np.where(diff == -1)[0] + 1

    if active[0]:
        starts = np.concatenate([[0], starts])
    if active[-1]:
        ends = np.concatenate([ends, [len(active)]])

    for start, end in zip(starts, ends):
        if start < start_idx:
            continue
        peak = np.max(mag[start:end])
        duration_ms = (end - start) / SAMPLE_RATE * 1000
        if peak > threshold and duration_ms > 5:
            return start, end, peak
    return None, None, None

def analyze_rf_params(iq, start, end, name):
    """Analyze RF parameters of a transmission."""
    print(f"\n{'='*60}")
    print(f"{name}")
    print(f"{'='*60}")

    # Add padding
    start = max(0, start - 500)
    end = min(len(iq), end + 500)
    segment = iq[start:end]
    mag = np.abs(segment)

    print(f"Duration: {len(segment)/SAMPLE_RATE*1000:.2f}ms")
    print(f"Peak magnitude: {np.max(mag):.1f}")

    # FM demodulation
    phase = np.unwrap(np.angle(segment))
    freq = np.diff(phase) * SAMPLE_RATE / (2 * np.pi)

    # Find the active region (where signal is strong)
    mag_threshold = np.max(mag) * 0.3
    active_mask = mag[:-1] > mag_threshold
    active_freq = freq[active_mask]

    if len(active_freq) == 0:
        print("No active signal found!")
        return None

    print(f"\n--- FREQUENCY ANALYSIS (active region only) ---")
    print(f"Frequency samples: {len(active_freq)}")
    print(f"Frequency min: {np.min(active_freq)/1000:.1f} kHz")
    print(f"Frequency max: {np.max(active_freq)/1000:.1f} kHz")
    print(f"Frequency mean: {np.mean(active_freq)/1000:.1f} kHz")
    print(f"Frequency std: {np.std(active_freq)/1000:.1f} kHz")

    # The deviation should be ~41.2 kHz for Lutron
    # Look at the histogram to find the two FSK frequencies
    hist, bin_edges = np.histogram(active_freq, bins=100)

    # Find the two peaks (mark and space frequencies)
    # Look for peaks in lower and upper halves
    mid_bin = len(hist) // 2
    lower_peak_idx = np.argmax(hist[:mid_bin])
    upper_peak_idx = mid_bin + np.argmax(hist[mid_bin:])

    lower_freq = (bin_edges[lower_peak_idx] + bin_edges[lower_peak_idx+1]) / 2
    upper_freq = (bin_edges[upper_peak_idx] + bin_edges[upper_peak_idx+1]) / 2

    deviation = (upper_freq - lower_freq) / 2
    center = (upper_freq + lower_freq) / 2

    print(f"\nFSK Analysis:")
    print(f"  Lower frequency: {lower_freq/1000:.1f} kHz")
    print(f"  Upper frequency: {upper_freq/1000:.1f} kHz")
    print(f"  Center offset: {center/1000:.1f} kHz (should be ~0)")
    print(f"  Deviation: {deviation/1000:.1f} kHz (should be ~41.2)")

    # Binary threshold (use center)
    binary = (freq > center).astype(int)

    # Measure bit timing by looking at run lengths
    print(f"\n--- BIT TIMING ANALYSIS ---")

    # Find runs of 1s and 0s
    runs = []
    current_val = binary[0]
    current_len = 1
    for b in binary[1:]:
        if b == current_val:
            current_len += 1
        else:
            runs.append(current_len)
            current_val = b
            current_len = 1
    runs.append(current_len)

    # Expected samples per bit at 62.5 kBaud = 32
    expected_spb = SAMPLE_RATE / 62500

    # Most runs should be close to 32 samples (1 bit) or multiples
    runs = np.array(runs)

    # Filter to reasonable run lengths (0.5 to 5 bits)
    reasonable = runs[(runs > expected_spb * 0.5) & (runs < expected_spb * 5)]

    if len(reasonable) > 0:
        # Quantize to nearest bit count
        bit_counts = np.round(reasonable / expected_spb)
        single_bit_runs = reasonable[bit_counts == 1]

        if len(single_bit_runs) > 10:
            actual_spb = np.median(single_bit_runs)
            actual_baud = SAMPLE_RATE / actual_spb
            print(f"Expected samples/bit: {expected_spb:.1f} (62500 baud)")
            print(f"Measured samples/bit: {actual_spb:.1f}")
            print(f"Measured baud rate: {actual_baud:.0f}")
            print(f"Baud rate error: {(actual_baud - 62500) / 62500 * 100:.2f}%")
        else:
            print(f"Not enough single-bit runs to measure timing")

    return {
        'deviation': deviation,
        'center': center,
        'segment': segment,
        'freq': freq,
        'binary': binary
    }

def main():
    print("Loading captures...")

    pico_iq = load_cu8('real_pico_ACTUAL_pairing.cu8')
    esp32_iq = load_cu8('esp32_pairing_capture.cu8')

    # Find first strong pairing packet from Pico (after 7s to skip button presses)
    pico_start, pico_end, pico_peak = find_strong_tx(pico_iq, threshold=100, skip_seconds=7)

    # Find first strong transmission from ESP32
    esp_start, esp_end, esp_peak = find_strong_tx(esp32_iq, threshold=50, skip_seconds=0)

    print(f"\nPico TX: start={pico_start/SAMPLE_RATE:.2f}s, peak={pico_peak:.1f}")
    print(f"ESP32 TX: start={esp_start/SAMPLE_RATE:.2f}s, peak={esp_peak:.1f}")

    pico_params = analyze_rf_params(pico_iq, pico_start, pico_end, "REAL PICO")
    esp_params = analyze_rf_params(esp32_iq, esp_start, esp_end, "ESP32")

    if pico_params and esp_params:
        print(f"\n{'='*60}")
        print("COMPARISON SUMMARY")
        print(f"{'='*60}")

        print(f"\nDeviation:")
        print(f"  Pico:  {pico_params['deviation']/1000:.1f} kHz")
        print(f"  ESP32: {esp_params['deviation']/1000:.1f} kHz")
        print(f"  Diff:  {abs(pico_params['deviation'] - esp_params['deviation'])/1000:.1f} kHz")

        print(f"\nCenter offset:")
        print(f"  Pico:  {pico_params['center']/1000:.1f} kHz")
        print(f"  ESP32: {esp_params['center']/1000:.1f} kHz")
        print(f"  Diff:  {abs(pico_params['center'] - esp_params['center'])/1000:.1f} kHz")

        if abs(esp_params['deviation'] - pico_params['deviation']) > 5000:
            print(f"\n** WARNING: Significant deviation difference! **")
            print(f"   This could cause bit errors in the receiver.")

        if abs(esp_params['center']) > 10000:
            print(f"\n** WARNING: ESP32 center frequency offset is large! **")
            print(f"   This could indicate frequency calibration issues.")

if __name__ == '__main__':
    main()
