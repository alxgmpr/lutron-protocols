# Lutron CCA Async Serial N81 Encoding/Decoding
#
# Each byte is encoded as 10 bits:
#   - Start bit (0)
#   - 8 data bits (LSB first)
#   - Stop bit (1)

from typing import List, Tuple, Optional
from .constants import SYNC_BYTE, PREFIX_BYTES, PREAMBLE_BITS


def encode_byte_n81(byte: int) -> str:
    """
    Encode a single byte using async serial N81 format.

    Args:
        byte: Byte value (0-255)

    Returns:
        10-character binary string
    """
    # Start bit
    bits = '0'

    # Data bits LSB first
    for i in range(8):
        bits += '1' if (byte >> i) & 1 else '0'

    # Stop bit
    bits += '1'

    return bits


def decode_byte_n81(bits: str) -> Tuple[Optional[int], bool]:
    """
    Decode a 10-bit N81 encoded byte.

    Args:
        bits: 10-character binary string

    Returns:
        Tuple of (decoded byte or None, valid framing)
    """
    if len(bits) != 10:
        return None, False

    # Check framing
    if bits[0] != '0' or bits[9] != '1':
        return None, False

    # Extract data bits (LSB first)
    value = 0
    for i in range(8):
        if bits[1 + i] == '1':
            value |= (1 << i)

    return value, True


def encode_packet(payload: bytes, preamble_bits: int = PREAMBLE_BITS) -> str:
    """
    Encode a complete Lutron packet to bitstream.

    Args:
        payload: Packet data (typically 24 bytes with CRC)
        preamble_bits: Number of preamble bits (default 32)

    Returns:
        Binary string of complete encoded packet
    """
    bits = ''

    # Preamble: alternating 1010... starting with 1
    for i in range(preamble_bits):
        bits += '1' if i % 2 == 0 else '0'

    # Sync byte 0xFF
    bits += encode_byte_n81(SYNC_BYTE)

    # Prefix 0xFA 0xDE
    for b in PREFIX_BYTES:
        bits += encode_byte_n81(b)

    # Payload data
    for b in payload:
        bits += encode_byte_n81(b)

    # Trailing zeros
    bits += '0' * 16

    return bits


def decode_bitstream(bitstream: str, verbose: bool = False) -> List[bytes]:
    """
    Decode a bitstream to extract Lutron packets.

    Args:
        bitstream: Binary string of captured data
        verbose: Print debug info

    Returns:
        List of decoded packet byte arrays
    """
    packets = []

    # Patterns to search for
    # 0xFF encoded: 0 + 11111111 + 1 = 0111111111
    sync_pattern = encode_byte_n81(SYNC_BYTE)
    # 0xFA encoded: 0 + 01011111 + 1 = 0010111111
    fa_pattern = encode_byte_n81(0xFA)
    # 0xDE encoded: 0 + 01111011 + 1 = 0011110111
    de_pattern = encode_byte_n81(0xDE)

    prefix_pattern = fa_pattern + de_pattern

    if verbose:
        print(f"Looking for sync pattern: {sync_pattern}")
        print(f"Looking for prefix pattern: {prefix_pattern}")

    # Find sync + prefix sequences
    pos = 0
    while pos < len(bitstream) - 30:
        # Look for sync byte
        sync_pos = bitstream.find(sync_pattern, pos)
        if sync_pos == -1:
            break

        # Check for 0xFA 0xDE prefix immediately after
        prefix_start = sync_pos + 10
        if bitstream[prefix_start:prefix_start + 20] == prefix_pattern:
            if verbose:
                print(f"Found sync+prefix at bit {sync_pos}")

            # Decode payload bytes
            data_start = prefix_start + 20
            packet_bytes = bytearray()

            byte_pos = data_start
            while byte_pos + 10 <= len(bitstream):
                chunk = bitstream[byte_pos:byte_pos + 10]
                byte_val, valid = decode_byte_n81(chunk)

                if not valid:
                    if verbose:
                        print(f"  Invalid framing at byte {len(packet_bytes)}: {chunk}")
                    break

                packet_bytes.append(byte_val)
                byte_pos += 10

                # Stop after reasonable packet length
                if len(packet_bytes) >= 32:
                    break

            if len(packet_bytes) >= 24:
                packets.append(bytes(packet_bytes[:24]))
                if verbose:
                    print(f"  Decoded {len(packet_bytes)} bytes")

            pos = byte_pos
        else:
            pos = sync_pos + 1

    return packets


def bitstream_to_bytes(bitstream: str) -> bytes:
    """
    Convert a bitstream to raw bytes (MSB first packing).

    Args:
        bitstream: Binary string

    Returns:
        Packed bytes
    """
    # Pad to multiple of 8
    padded = bitstream + '0' * ((8 - len(bitstream) % 8) % 8)

    result = bytearray()
    for i in range(0, len(padded), 8):
        byte_val = int(padded[i:i + 8], 2)
        result.append(byte_val)

    return bytes(result)


def bytes_to_bitstream(data: bytes) -> str:
    """
    Convert bytes to binary string (MSB first).

    Args:
        data: Byte data

    Returns:
        Binary string
    """
    return ''.join(f'{b:08b}' for b in data)
