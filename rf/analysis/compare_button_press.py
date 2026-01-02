#!/usr/bin/env python3
"""
Compare ESP32 button press (which works!) to real Pico button press.
If these match well, the problem is specific to pairing packets.
"""

import numpy as np

SAMPLE_RATE = 2000000

def load_cu8(filename):
    data = np.fromfile(filename, dtype=np.uint8)
    iq = data[::2].astype(np.float32) - 127.5 + 1j * (data[1::2].astype(np.float32) - 127.5)
    return iq

def find_first_tx(mag, threshold):
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
        if peak > threshold and duration_ms > 3:
            return start, end, peak
    return None, None, None

def analyze_tx(iq, start, end, name):
    start = max(0, start - 500)
    end = min(len(iq), end + 500)
    segment = iq[start:end]
    mag = np.abs(segment)

    # FM demod
    phase = np.unwrap(np.angle(segment))
    freq = np.diff(phase) * SAMPLE_RATE / (2 * np.pi)
    threshold = np.median(freq)
    binary = (freq > threshold).astype(int)

    # Sample bits
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
    print(f"Peak: {np.max(mag):.1f}")
    print(f"Total bits: {len(bits)}")

    # Find preamble
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

    print(f"Preamble at bit {best_pos}, length {best_run}")

    # Decode N81
    def decode_n81(bits_in):
        bytes_out = []
        i = 0
        while i < len(bits_in) - 10:
            if bits_in[i] == 0:
                byte_val = 0
                for j in range(8):
                    if bits_in[i + 1 + j]:
                        byte_val |= (1 << j)
                if bits_in[i + 9] == 1:
                    bytes_out.append(byte_val)
                    i += 10
                else:
                    i += 1
            else:
                i += 1
        return bytes_out

    decoded = decode_n81(bits[best_pos + best_run:])
    print(f"Decoded {len(decoded)} bytes:")
    hex_str = ' '.join(f'{b:02X}' for b in decoded[:40])
    print(f"  {hex_str}")

    # Find FA DE
    for i in range(len(decoded) - 2):
        if decoded[i] == 0xFA and decoded[i+1] == 0xDE:
            payload = decoded[i+2:]
            print(f"\nFound FA DE at byte {i}")
            if len(payload) > 5:
                ptype = payload[0]
                seq = payload[1]
                dev_id = payload[2] | (payload[3]<<8) | (payload[4]<<16) | (payload[5]<<24)
                print(f"  Type: 0x{ptype:02X}")
                print(f"  Seq:  0x{seq:02X}")
                print(f"  DevID: 0x{dev_id:08X}")
                print(f"  Full payload: {' '.join(f'{b:02X}' for b in payload[:26])}")
            break

    return bits, decoded

def main():
    print("Loading captures...")

    # Real Pico button press from earlier capture (before pairing started)
    pico_iq = load_cu8('real_pico_ACTUAL_pairing.cu8')
    esp32_iq = load_cu8('esp32_button_test.cu8')

    pico_mag = np.abs(pico_iq)
    esp32_mag = np.abs(esp32_iq)

    # For Pico, the button presses are in the first few seconds (before 7s)
    # Look for a strong one in the button press phase
    pico_start, pico_end, pico_peak = find_first_tx(pico_mag, 100)

    # For ESP32, find first transmission
    esp_start, esp_end, esp_peak = find_first_tx(esp32_mag, 50)

    print(f"\nPico button TX: start={pico_start}, peak={pico_peak}")
    print(f"ESP32 button TX: start={esp_start}, peak={esp_peak}")

    if pico_start and pico_start / SAMPLE_RATE < 7:
        pico_bits, pico_dec = analyze_tx(pico_iq, pico_start, pico_end,
                                         "REAL PICO BUTTON PRESS")
    else:
        print("No Pico button press found in first 7 seconds")
        pico_bits, pico_dec = None, None

    if esp_start:
        esp_bits, esp_dec = analyze_tx(esp32_iq, esp_start, esp_end,
                                       "ESP32 BUTTON PRESS")
    else:
        print("No ESP32 button press found")
        esp_bits, esp_dec = None, None

    # Compare if both found
    if pico_dec and esp_dec:
        print(f"\n{'='*60}")
        print("BUTTON PRESS COMPARISON")
        print(f"{'='*60}")

        # Find FA DE in each
        pico_payload = None
        esp_payload = None

        for i in range(len(pico_dec) - 2):
            if pico_dec[i] == 0xFA and pico_dec[i+1] == 0xDE:
                pico_payload = pico_dec[i+2:]
                break

        for i in range(len(esp_dec) - 2):
            if esp_dec[i] == 0xFA and esp_dec[i+1] == 0xDE:
                esp_payload = esp_dec[i+2:]
                break

        if pico_payload and esp_payload:
            print(f"\nPico payload ({len(pico_payload)} bytes):")
            print(f"  {' '.join(f'{b:02X}' for b in pico_payload[:26])}")

            print(f"\nESP32 payload ({len(esp_payload)} bytes):")
            print(f"  {' '.join(f'{b:02X}' for b in esp_payload[:26])}")

            # Check if type matches
            if pico_payload[0] & 0xFE == esp_payload[0] & 0xFE:
                print(f"\n** Packet types match! (0x{pico_payload[0]:02X} vs 0x{esp_payload[0]:02X}) **")
            else:
                print(f"\n!! Packet types DIFFER! (0x{pico_payload[0]:02X} vs 0x{esp_payload[0]:02X})")

            # Count matching bytes
            min_len = min(len(pico_payload), len(esp_payload), 24)
            matches = sum(1 for i in range(min_len) if pico_payload[i] == esp_payload[i])
            print(f"Bytes matching in first {min_len}: {matches} ({100*matches/min_len:.1f}%)")

if __name__ == '__main__':
    main()
