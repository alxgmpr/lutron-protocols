#!/usr/bin/env python3
"""
Lutron Clear Connect Type A (CCA) decoder for RTL-SDR captures

Based on reverse engineering from:
- https://hackaday.io/project/2291-integrated-room-sunrise-simulator/log/7223-the-wireless-interface
- https://github.com/Entropy512/lutron_hacks
"""

import numpy as np
import sys
import argparse

# CRC-16 implementation from Lutron STM32 coprocessor firmware
def lutron_crc_table():
    """Generate CRC table with polynomial 0x1ca0f"""
    table = []
    for i in range(256):
        crc = i << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0xca0f) & 0xffff
            else:
                crc = (crc << 1) & 0xffff
        table.append(crc)
    return table

CRC_TABLE = lutron_crc_table()

def calc_crc(message):
    """Calculate Lutron CRC-16"""
    crc_reg = 0
    for byte in message:
        crc_reg_upper = crc_reg >> 8
        crc_reg = (((crc_reg << 8) & 0xff00) + byte) ^ CRC_TABLE[crc_reg_upper]
    return crc_reg

def get_pktlen_from_command(cmdbyte):
    """Determine packet length from command byte"""
    if (cmdbyte & 0xc0) == 0:
        return 5
    elif (cmdbyte & 0xe0) == 0xa0:
        return 0x35  # Pairing requests
    else:
        return 0x18  # Standard control packets

def load_iq_file(filename, sample_rate=2000000):
    """Load RTL-SDR cu8 (unsigned 8-bit IQ) file"""
    raw = np.fromfile(filename, dtype=np.uint8)
    # Convert to complex float, centered around 0
    iq = (raw[::2].astype(np.float32) - 127.5) + 1j * (raw[1::2].astype(np.float32) - 127.5)
    return iq

def fm_demodulate(iq):
    """FM demodulation (for FSK/GFSK)"""
    # Compute phase difference between consecutive samples
    phase = np.angle(iq[1:] * np.conj(iq[:-1]))
    return phase

def find_packets(demod, sample_rate=2000000, baud_rate=62485):
    """Find potential packet start positions based on signal activity"""
    samples_per_bit = sample_rate / baud_rate

    # Compute signal envelope
    envelope = np.abs(demod)

    # Smooth with moving average
    window = int(samples_per_bit * 2)
    kernel = np.ones(window) / window
    smoothed = np.convolve(envelope, kernel, mode='same')

    # Find regions with activity
    threshold = np.mean(smoothed) + 2 * np.std(smoothed)
    active = smoothed > threshold

    # Find rising edges (packet starts)
    edges = np.diff(active.astype(int))
    starts = np.where(edges == 1)[0]
    ends = np.where(edges == -1)[0]

    return starts, ends, threshold

def decode_bits(demod, start, length, sample_rate=2000000, baud_rate=62485):
    """Decode bits from demodulated signal"""
    samples_per_bit = sample_rate / baud_rate

    segment = demod[start:start + length]

    # Sample at bit centers
    bits = []
    pos = samples_per_bit / 2
    while pos < len(segment):
        # Average a few samples around the center
        idx = int(pos)
        window = 3
        if idx + window < len(segment):
            val = np.mean(segment[idx:idx+window])
            bits.append(1 if val > 0 else 0)
        pos += samples_per_bit

    return bits

def bits_to_bytes_lutron(bits):
    """Convert bits to bytes using Lutron's 10-bit encoding (8N1 async serial)"""
    bytes_out = []
    i = 0

    # Find sync pattern: preamble (1010...) followed by 0xFF (1111111110)
    preamble = "1010101010101111111110"
    bitstring = ''.join(str(b) for b in bits)

    sync_pos = bitstring.find(preamble)
    if sync_pos == -1:
        # Try inverted
        inv_preamble = "0101010101010000000001"
        sync_pos = bitstring.find(inv_preamble)
        if sync_pos != -1:
            bits = [1-b for b in bits]
            bitstring = ''.join(str(b) for b in bits)
            sync_pos = bitstring.find(preamble)

    if sync_pos == -1:
        return None

    # Skip to data after sync byte
    i = sync_pos + len(preamble) - 1  # Position at start bit of first data byte

    while i + 10 <= len(bits):
        chunk = bits[i:i+10]
        # Check 8N1 framing: start bit (0) and stop bit (1)
        if chunk[0] == 0 and chunk[-1] == 1:
            # Extract byte value (LSB first)
            byte_bits = chunk[1:9]
            byte_val = sum(b << j for j, b in enumerate(byte_bits))
            bytes_out.append(byte_val)
        i += 10

    return bytes(bytes_out)

def decode_packet(data):
    """Decode a Lutron packet and display its contents"""
    if len(data) < 4:
        return None

    # Check for 0xFADE prefix
    if data[0] != 0xfa or data[1] != 0xde:
        return None

    # Strip prefix
    payload = data[2:]
    if len(payload) < 3:
        return None

    cmd_byte = payload[0]
    pkt_len = get_pktlen_from_command(cmd_byte)

    if len(payload) < pkt_len:
        return None

    packet = payload[:pkt_len]

    # Verify CRC
    calc = calc_crc(packet[:-2])
    msg_crc = (packet[-2] << 8) | packet[-1]
    crc_valid = calc == msg_crc

    # Parse packet fields
    result = {
        'raw': packet.hex(' '),
        'crc_valid': crc_valid,
        'packet_type': packet[0],
        'sequence': packet[1],
        'device_id': packet[2:6].hex() if len(packet) >= 6 else None,
    }

    if len(packet) >= 12:
        result['button'] = packet[10]
        result['action'] = packet[11]  # 0x00 = press, 0x01 = release

    return result

def main():
    parser = argparse.ArgumentParser(description='Decode Lutron CCA signals from RTL-SDR capture')
    parser.add_argument('filename', help='Input .cu8 file')
    parser.add_argument('-s', '--sample-rate', type=int, default=2000000, help='Sample rate (default: 2000000)')
    parser.add_argument('-v', '--verbose', action='store_true', help='Verbose output')
    args = parser.parse_args()

    print(f"Loading {args.filename}...")
    iq = load_iq_file(args.filename, args.sample_rate)
    print(f"Loaded {len(iq)} samples ({len(iq)/args.sample_rate:.2f} seconds)")

    print("FM demodulating...")
    demod = fm_demodulate(iq)

    print("Finding packets...")
    starts, ends, threshold = find_packets(demod, args.sample_rate)
    print(f"Found {len(starts)} potential packet regions")

    packets_found = 0
    for i, start in enumerate(starts):
        end = ends[i] if i < len(ends) else start + 100000
        length = min(end - start, 100000)  # Max 50ms of data

        if length < 1000:  # Skip very short bursts
            continue

        bits = decode_bits(demod, start, length, args.sample_rate)

        if args.verbose:
            print(f"\nRegion {i}: {start} - {start+length} ({len(bits)} bits)")

        data = bits_to_bytes_lutron(bits)
        if data:
            packet = decode_packet(data)
            if packet:
                packets_found += 1
                print(f"\n=== Packet {packets_found} ===")
                print(f"Raw: {packet['raw']}")
                print(f"CRC Valid: {packet['crc_valid']}")
                print(f"Type: 0x{packet['packet_type']:02x}")
                print(f"Sequence: 0x{packet['sequence']:02x}")
                if packet['device_id']:
                    print(f"Device ID: {packet['device_id']}")
                if 'button' in packet:
                    print(f"Button: {packet['button']}, Action: {'Press' if packet['action']==0 else 'Release'}")

    print(f"\n\nTotal packets decoded: {packets_found}")

if __name__ == '__main__':
    main()
