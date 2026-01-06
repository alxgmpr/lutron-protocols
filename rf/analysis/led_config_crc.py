#!/usr/bin/env python3
"""
Flexible CRC scanner for Lutron packets.

Scans all possible CRC positions, start offsets, and variations to find valid CRCs.
"""

import sys
from typing import Optional

# CRC polynomial 0xCA0F (Lutron standard)
def build_crc_table(poly=0xCA0F):
    table = []
    for i in range(256):
        crc = i << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ poly) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
        table.append(crc)
    return table

def calc_crc(data, table, init=0):
    crc_reg = init
    for byte in data:
        crc_upper = crc_reg >> 8
        crc_reg = (((crc_reg << 8) & 0xFF00) + byte) ^ table[crc_upper]
    return crc_reg


def scan_for_crc(packet: bytes, table: list, verbose: bool = False) -> list:
    """
    Scan packet for valid CRC at any position.

    Tries:
    - All CRC positions from byte 10 to end-2
    - All data start offsets from 0 to 8
    - Big-endian and little-endian CRC
    - Different init values (0, 0xFFFF)

    Returns list of matches: [(crc_pos, data_start, endianness, init, calc_crc)]
    """
    matches = []
    pkt_len = len(packet)

    for init_val in [0, 0xFFFF]:
        for data_start in range(9):  # Try starting data from byte 0-8
            for crc_pos in range(max(10, data_start + 4), pkt_len - 1):
                # Calculate CRC over bytes [data_start:crc_pos]
                data = packet[data_start:crc_pos]
                if len(data) < 4:
                    continue

                crc_calc = calc_crc(data, table, init_val)

                # Check big-endian
                crc_pkt_be = (packet[crc_pos] << 8) | packet[crc_pos + 1]
                if crc_calc == crc_pkt_be:
                    matches.append({
                        'crc_pos': crc_pos,
                        'data_start': data_start,
                        'data_end': crc_pos,
                        'data_len': crc_pos - data_start,
                        'endian': 'BE',
                        'init': init_val,
                        'crc': crc_calc
                    })
                    if verbose:
                        print(f"  MATCH: CRC at [{crc_pos}-{crc_pos+1}], data [{data_start}:{crc_pos}] ({crc_pos-data_start} bytes), BE, init=0x{init_val:04X}, CRC=0x{crc_calc:04X}")

                # Check little-endian
                crc_pkt_le = packet[crc_pos] | (packet[crc_pos + 1] << 8)
                if crc_calc == crc_pkt_le:
                    matches.append({
                        'crc_pos': crc_pos,
                        'data_start': data_start,
                        'data_end': crc_pos,
                        'data_len': crc_pos - data_start,
                        'endian': 'LE',
                        'init': init_val,
                        'crc': crc_calc
                    })
                    if verbose:
                        print(f"  MATCH: CRC at [{crc_pos}-{crc_pos+1}], data [{data_start}:{crc_pos}] ({crc_pos-data_start} bytes), LE, init=0x{init_val:04X}, CRC=0x{crc_calc:04X}")

    return matches


def analyze_packet(packet: bytes, name: str = "Packet"):
    """Analyze a single packet for CRC."""
    table = build_crc_table()

    print(f"\n{'='*60}")
    print(f"Analyzing: {name}")
    print(f"{'='*60}")
    print(f"Length: {len(packet)} bytes")
    print(f"Hex: {' '.join(f'{b:02X}' for b in packet)}")
    print()

    # Show standard packet structure
    if len(packet) >= 8:
        print("Standard structure:")
        print(f"  [0]    Type:     0x{packet[0]:02X}")
        print(f"  [1]    Sequence: 0x{packet[1]:02X}")
        print(f"  [2-5]  DeviceID: {packet[2]:02X} {packet[3]:02X} {packet[4]:02X} {packet[5]:02X}")
        print(f"  [6]    Marker:   0x{packet[6]:02X}")
        print(f"  [7]    Format:   0x{packet[7]:02X}")
        if len(packet) >= 24:
            print(f"  [22-23] Std CRC: {packet[22]:02X} {packet[23]:02X}")
    print()

    # Standard CRC check first
    print("Standard CRC check (bytes [0:22] -> [22-23]):")
    std_crc = calc_crc(packet[:22], table)
    std_pkt_crc = (packet[22] << 8) | packet[23] if len(packet) >= 24 else 0
    print(f"  Calculated: 0x{std_crc:04X}")
    print(f"  Packet:     0x{std_pkt_crc:04X}")
    print(f"  Match:      {'YES' if std_crc == std_pkt_crc else 'NO'}")
    print()

    # Full scan
    print("Full CRC scan (all positions/offsets):")
    matches = scan_for_crc(packet, table, verbose=True)

    if not matches:
        print("  No CRC matches found!")
        print()
        print("  Possible explanations:")
        print("  - Different CRC polynomial")
        print("  - CRC includes data not in this packet")
        print("  - Packet doesn't have CRC")
        print("  - Packet is corrupted")
    else:
        print()
        print(f"Found {len(matches)} CRC match(es)")

        # Filter to most likely (22-byte data or close to it)
        likely = [m for m in matches if 18 <= m['data_len'] <= 24]
        if likely:
            print("\nMost likely CRC configurations (18-24 byte data range):")
            for m in likely:
                print(f"  - CRC at [{m['crc_pos']}-{m['crc_pos']+1}], "
                      f"data [{m['data_start']}:{m['data_end']}] ({m['data_len']} bytes), "
                      f"{m['endian']}, init=0x{m['init']:04X}")

    return matches


def main():
    table = build_crc_table()

    # LED config packets from capture (format 0x11)
    # Both OFF (A2): A2 XX YY 90 2C 00 21 11 00 06 FE 28 5F FE 06 50 00 04 06 00 00 00 00 00
    # Both ON (A3):  A3 XX YY 90 2C 00 21 11 00 06 FE 28 5F FE 06 50 00 04 06 00 00 00 00 FF

    print("="*60)
    print("Lutron CRC Scanner - Flexible CRC Detection")
    print("="*60)
    print()
    print("Usage: python led_config_crc.py [hex_bytes]")
    print("       or run without args for LED config analysis")
    print()

    if len(sys.argv) > 1:
        # Parse hex bytes from command line
        hex_str = ''.join(sys.argv[1:]).replace(' ', '').replace(',', '')
        try:
            packet = bytes.fromhex(hex_str)
            analyze_packet(packet, "Command line input")
        except ValueError as e:
            print(f"Error parsing hex: {e}")
            return
    else:
        # Analyze LED config packets (using 00 for unknown sequence)
        led_off_packet = bytes([
            0xA2, 0x00,  # Type, Sequence
            0x90, 0x2C, 0x00, 0x21,  # Device ID (little-endian) - 0x21002C90
            0x21,  # Protocol marker
            0x11,  # Format byte - LED config
            0x00, 0x06, 0xFE, 0x28, 0x5F, 0xFE, 0x06, 0x50,
            0x00, 0x04, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00
        ])

        led_on_packet = bytes([
            0xA3, 0x00,  # Type, Sequence
            0x90, 0x2C, 0x00, 0x21,  # Device ID (little-endian) - 0x21002C90
            0x21,  # Protocol marker
            0x11,  # Format byte - LED config
            0x00, 0x06, 0xFE, 0x28, 0x5F, 0xFE, 0x06, 0x50,
            0x00, 0x04, 0x06, 0x00, 0x00, 0x00, 0x00, 0xFF
        ])

        analyze_packet(led_off_packet, "LED Config - Both OFF (A2)")
        analyze_packet(led_on_packet, "LED Config - Both ON (A3)")

        print("\n" + "="*60)
        print("Summary")
        print("="*60)
        print()
        print("Key findings:")
        print("- Format byte 0x11 at position [7] = LED config command")
        print("- Type A2 vs A3 may indicate LED state variant")
        print("- Byte [23] = LED state value (0x00=off, 0xFF=on)")
        print()
        print("To analyze your own packets:")
        print("  python led_config_crc.py A2 00 90 2C 00 21 11 ...")


if __name__ == "__main__":
    main()
