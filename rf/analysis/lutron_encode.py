#!/usr/bin/env python3
"""
Lutron CCA Packet Encoder

Generate Lutron packets for transmission.
"""

import sys
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from lutron_cca.encoding import encode_packet, bitstream_to_bytes
from lutron_cca.packet import ButtonPress, parse_device_id
from lutron_cca.constants import *


def main():
    parser = argparse.ArgumentParser(description='Generate Lutron CCA packets')
    subparsers = parser.add_subparsers(dest='command', help='Commands')

    # Button press command
    btn_parser = subparsers.add_parser('button', help='Generate button press packet')
    btn_parser.add_argument('device_id', help='Device ID (e.g., 0595e68d)')
    btn_parser.add_argument('button', help='Button: on, off, raise, lower, favorite, or number')
    btn_parser.add_argument('-s', '--sequence', type=int, default=0,
                            help='Sequence number (default: 0)')
    btn_parser.add_argument('-a', '--action', choices=['press', 'release'],
                            default='press', help='Button action')
    btn_parser.add_argument('-o', '--output', help='Output file (default: stdout)')
    btn_parser.add_argument('-f', '--format', choices=['hex', 'bits', 'raw'],
                            default='hex', help='Output format')
    btn_parser.add_argument('--no-encoding', action='store_true',
                            help='Output raw packet bytes without N81 encoding')

    # Show encoding command
    show_parser = subparsers.add_parser('show-encoding', help='Show N81 encoding of bytes')
    show_parser.add_argument('bytes', nargs='+', help='Bytes to encode (hex)')

    args = parser.parse_args()

    if args.command == 'button':
        generate_button(args)
    elif args.command == 'show-encoding':
        show_encoding(args)
    else:
        parser.print_help()


def generate_button(args):
    """Generate a button press packet."""
    # Parse device ID
    device_id = parse_device_id(args.device_id)

    # Parse button
    button_map = {
        'on': BUTTON_ON,
        'off': BUTTON_OFF,
        'raise': BUTTON_RAISE,
        'lower': BUTTON_LOWER,
        'favorite': BUTTON_FAVORITE,
        'fav': BUTTON_FAVORITE,
    }

    if args.button.lower() in button_map:
        button = button_map[args.button.lower()]
    else:
        try:
            button = int(args.button, 0)  # Support 0x prefix
        except ValueError:
            print(f"Unknown button: {args.button}", file=sys.stderr)
            sys.exit(1)

    # Parse action
    action = ACTION_RELEASE if args.action == 'release' else ACTION_PRESS

    # Create packet
    packet = ButtonPress.create(device_id, button, args.sequence, action)

    print(f"Device ID: {args.device_id} -> 0x{device_id:08X}", file=sys.stderr)
    print(f"Button: {button} ({packet.button_name})", file=sys.stderr)
    print(f"Sequence: {args.sequence}", file=sys.stderr)
    print(f"Action: {packet.action_name}", file=sys.stderr)
    print(f"CRC: 0x{packet.crc_value:04X}", file=sys.stderr)
    print(file=sys.stderr)

    if args.no_encoding:
        # Raw packet bytes
        output_data = packet.raw
        print(f"Raw packet ({len(output_data)} bytes):", file=sys.stderr)
    else:
        # Full encoded bitstream
        bitstream = encode_packet(packet.raw)
        print(f"Encoded bitstream ({len(bitstream)} bits):", file=sys.stderr)

        if args.format == 'bits':
            output_data = bitstream
        else:
            output_data = bitstream_to_bytes(bitstream)

    # Output
    if args.format == 'hex':
        if isinstance(output_data, str):
            output_data = bitstream_to_bytes(output_data)
        hex_str = ' '.join(f'{b:02X}' for b in output_data)
        if args.output:
            with open(args.output, 'w') as f:
                f.write(hex_str)
        else:
            print(hex_str)

    elif args.format == 'bits':
        if isinstance(output_data, bytes):
            from lutron_cca.encoding import bytes_to_bitstream
            output_data = bytes_to_bitstream(output_data)
        if args.output:
            with open(args.output, 'w') as f:
                f.write(output_data)
        else:
            # Print in chunks
            for i in range(0, len(output_data), 80):
                print(output_data[i:i + 80])

    elif args.format == 'raw':
        if isinstance(output_data, str):
            output_data = bitstream_to_bytes(output_data)
        if args.output:
            with open(args.output, 'wb') as f:
                f.write(output_data)
        else:
            sys.stdout.buffer.write(output_data)


def show_encoding(args):
    """Show N81 encoding of bytes."""
    from lutron_cca.encoding import encode_byte_n81

    for hex_byte in args.bytes:
        try:
            value = int(hex_byte, 16)
        except ValueError:
            print(f"Invalid hex byte: {hex_byte}", file=sys.stderr)
            continue

        encoded = encode_byte_n81(value)
        print(f"0x{value:02X} ({value:3d}) -> {encoded}")
        print(f"  Binary: {value:08b}")
        print(f"  LSB first: {''.join(str((value >> i) & 1) for i in range(8))}")
        print(f"  Framing: 0 (start) + {encoded[1:9]} (data) + 1 (stop)")
        print()


if __name__ == '__main__':
    main()
