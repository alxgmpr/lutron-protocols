#!/usr/bin/env python3
"""
Lutron CCA Packet Analysis Utilities

Provides functions for analyzing captured Lutron RF data.
"""

from typing import List, Tuple
from .encoding import encode_byte_n81, decode_byte_n81, decode_bitstream
from .packet import LutronPacket, ButtonPress
from .crc import calc_crc, verify_crc


def analyze_bitstream(bitstream: str, verbose: bool = True) -> List[LutronPacket]:
    """
    Analyze a bitstream and extract/decode all Lutron packets.

    Args:
        bitstream: Binary string of captured data
        verbose: Print analysis details

    Returns:
        List of decoded LutronPacket objects
    """
    packets = []

    if verbose:
        print(f"Analyzing {len(bitstream)} bits of data...")
        print()

    raw_packets = decode_bitstream(bitstream, verbose=verbose)

    for i, raw in enumerate(raw_packets):
        if verbose:
            print(f"\n--- Packet {i + 1} ---")
            print(f"Raw: {' '.join(f'{b:02X}' for b in raw)}")

        packet = LutronPacket.from_bytes(raw)
        if packet:
            packets.append(packet)
            if verbose:
                print(f"Parsed: {packet}")
                if hasattr(packet, 'button'):
                    print(f"  Device ID: {packet.device_id_str} (0x{packet.device_id:08X})")
                    print(f"  Button: {packet.button} ({packet.button_name})")
                    print(f"  Action: {packet.action_name}")
                    print(f"  Sequence: {packet.sequence}")
                    print(f"  CRC: 0x{packet.crc_value:04X} ({'valid' if packet.crc_valid else 'INVALID'})")
        else:
            if verbose:
                print("  Failed to parse packet")

    return packets


def compare_packets(packet1: bytes, packet2: bytes, label1: str = "Packet 1",
                    label2: str = "Packet 2") -> None:
    """
    Compare two packets and highlight differences.

    Args:
        packet1: First packet bytes
        packet2: Second packet bytes
        label1: Label for first packet
        label2: Label for second packet
    """
    print(f"\n=== Packet Comparison ===")
    print(f"{label1}: {' '.join(f'{b:02X}' for b in packet1)}")
    print(f"{label2}: {' '.join(f'{b:02X}' for b in packet2)}")

    min_len = min(len(packet1), len(packet2))
    diffs = []

    for i in range(min_len):
        if packet1[i] != packet2[i]:
            diffs.append(i)

    if diffs:
        print(f"\nDifferences at offsets: {diffs}")
        for i in diffs:
            field = get_field_name(i)
            print(f"  Offset {i:2d} ({field}): 0x{packet1[i]:02X} vs 0x{packet2[i]:02X}")
    else:
        print("\nPackets are identical!")

    if len(packet1) != len(packet2):
        print(f"\nLength difference: {len(packet1)} vs {len(packet2)} bytes")


def get_field_name(offset: int) -> str:
    """Get human-readable field name for packet offset."""
    from .constants import (OFFSET_TYPE, OFFSET_SEQUENCE, OFFSET_DEVICE_ID,
                            OFFSET_BUTTON, OFFSET_ACTION, OFFSET_PADDING, OFFSET_CRC)

    if offset == OFFSET_TYPE:
        return "type"
    elif offset == OFFSET_SEQUENCE:
        return "sequence"
    elif OFFSET_DEVICE_ID <= offset < OFFSET_DEVICE_ID + 4:
        return f"device_id[{offset - OFFSET_DEVICE_ID}]"
    elif offset == 6:
        return "unknown1"
    elif offset == 7:
        return "unknown2"
    elif offset == 8:
        return "unknown3"
    elif offset == 9:
        return "unknown4"
    elif offset == OFFSET_BUTTON:
        return "button"
    elif offset == OFFSET_ACTION:
        return "action"
    elif OFFSET_PADDING <= offset < OFFSET_CRC:
        return f"padding[{offset - OFFSET_PADDING}]"
    elif offset >= OFFSET_CRC:
        return f"crc[{offset - OFFSET_CRC}]"
    else:
        return f"byte[{offset}]"


def find_preamble_patterns(bitstream: str) -> List[Tuple[int, int]]:
    """
    Find preamble patterns in bitstream.

    Returns list of (start_position, length) tuples.
    """
    patterns = []
    pos = 0

    while pos < len(bitstream) - 8:
        # Look for alternating pattern start
        if bitstream[pos:pos + 4] in ('1010', '0101'):
            # Count how long it continues
            start = pos
            while pos < len(bitstream) - 1:
                if bitstream[pos:pos + 2] in ('10', '01'):
                    pos += 2
                else:
                    break

            length = pos - start
            if length >= 8:  # Minimum meaningful preamble
                patterns.append((start, length))
        else:
            pos += 1

    return patterns


def hex_to_bitstream(hex_str: str) -> str:
    """Convert hex string to binary bitstream."""
    clean = hex_str.replace(' ', '').replace('\n', '')
    return ''.join(f'{int(b, 16):04b}' for b in [clean[i:i + 2] for i in range(0, len(clean), 2)])
