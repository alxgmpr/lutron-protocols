#!/usr/bin/env python3
"""
Lutron CCA Packet Decoder

Decode Lutron packets from various input formats:
- Binary bitstream files
- Hex dump
- URH capture files
"""

import sys
import argparse
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from lutron_cca.encoding import decode_bitstream, bytes_to_bitstream
from lutron_cca.packet import LutronPacket
from lutron_cca.analyze import analyze_bitstream, find_preamble_patterns


def load_bitstream_file(filepath: str) -> str:
    """Load bitstream from file (binary 0/1 characters)."""
    with open(filepath, 'r') as f:
        content = f.read()
    # Clean up - keep only 0 and 1
    return ''.join(c for c in content if c in '01')


def load_hex_file(filepath: str) -> str:
    """Load hex dump and convert to bitstream."""
    with open(filepath, 'r') as f:
        content = f.read()

    # Parse hex bytes
    hex_chars = ''.join(c for c in content if c in '0123456789abcdefABCDEF')
    data = bytes.fromhex(hex_chars)

    return bytes_to_bitstream(data)


def load_raw_file(filepath: str) -> str:
    """Load raw binary file and convert to bitstream."""
    with open(filepath, 'rb') as f:
        data = f.read()

    return bytes_to_bitstream(data)


def main():
    parser = argparse.ArgumentParser(description='Decode Lutron CCA packets')
    parser.add_argument('input', help='Input file (bitstream, hex, or raw)')
    parser.add_argument('-f', '--format', choices=['auto', 'bits', 'hex', 'raw'],
                        default='auto', help='Input format (default: auto-detect)')
    parser.add_argument('-v', '--verbose', action='store_true',
                        help='Verbose output')
    parser.add_argument('--find-preambles', action='store_true',
                        help='Find and report preamble patterns')
    parser.add_argument('--raw-bits', action='store_true',
                        help='Print raw bitstream')

    args = parser.parse_args()

    filepath = args.input

    # Auto-detect format
    if args.format == 'auto':
        if filepath.endswith('.hex'):
            fmt = 'hex'
        elif filepath.endswith('.raw') or filepath.endswith('.bin'):
            fmt = 'raw'
        else:
            # Try to detect from content
            with open(filepath, 'rb') as f:
                sample = f.read(100)

            if all(c in b'01\n\r ' for c in sample):
                fmt = 'bits'
            elif all(c in b'0123456789abcdefABCDEF \n\r' for c in sample):
                fmt = 'hex'
            else:
                fmt = 'raw'

        if args.verbose:
            print(f"Auto-detected format: {fmt}")
    else:
        fmt = args.format

    # Load data
    if fmt == 'bits':
        bitstream = load_bitstream_file(filepath)
    elif fmt == 'hex':
        bitstream = load_hex_file(filepath)
    else:
        bitstream = load_raw_file(filepath)

    print(f"Loaded {len(bitstream)} bits from {filepath}")

    if args.raw_bits:
        # Print in chunks of 80
        for i in range(0, len(bitstream), 80):
            print(bitstream[i:i + 80])
        return

    if args.find_preambles:
        print("\n=== Preamble Patterns ===")
        patterns = find_preamble_patterns(bitstream)
        for start, length in patterns:
            print(f"  Position {start}: {length} bits")
            if args.verbose:
                print(f"    {bitstream[start:start + min(40, length)]}...")
        print()

    # Analyze and decode
    packets = analyze_bitstream(bitstream, verbose=args.verbose)

    print(f"\n=== Summary ===")
    print(f"Found {len(packets)} valid packets")

    for i, pkt in enumerate(packets):
        print(f"\nPacket {i + 1}: {pkt}")


if __name__ == '__main__':
    main()
