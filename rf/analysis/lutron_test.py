#!/usr/bin/env python3
"""
Lutron CCA Protocol Tests

Verify encoding/decoding works correctly.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from lutron_cca.encoding import (encode_byte_n81, decode_byte_n81,
                                   encode_packet, decode_bitstream)
from lutron_cca.crc import calc_crc, verify_crc, append_crc
from lutron_cca.packet import ButtonPress, parse_device_id
from lutron_cca.constants import *


def test_n81_encoding():
    """Test N81 byte encoding/decoding."""
    print("=== N81 Encoding Tests ===")

    test_cases = [
        (0x00, '0000000001'),  # All zeros + framing
        (0xFF, '0111111111'),  # All ones + framing
        (0xFA, '0010111111'),  # 0xFA LSB first = 01011111
        (0xDE, '0011110111'),  # 0xDE LSB first = 01111011
        (0x88, '0000100011'),  # 0x88 LSB first = 00010001
    ]

    all_passed = True
    for value, expected in test_cases:
        encoded = encode_byte_n81(value)
        decoded, valid = decode_byte_n81(encoded)

        passed = encoded == expected and decoded == value and valid
        status = "PASS" if passed else "FAIL"

        if not passed:
            all_passed = False
            print(f"  0x{value:02X}: {status}")
            print(f"    Expected: {expected}")
            print(f"    Got:      {encoded}")
            print(f"    Decoded:  {decoded} (valid={valid})")
        else:
            print(f"  0x{value:02X}: {status} -> {encoded}")

    # Test round-trip for all byte values
    print("\n  Round-trip test (0x00-0xFF)...", end=" ")
    for i in range(256):
        encoded = encode_byte_n81(i)
        decoded, valid = decode_byte_n81(encoded)
        if decoded != i or not valid:
            print(f"FAIL at 0x{i:02X}")
            all_passed = False
            break
    else:
        print("PASS")

    return all_passed


def test_crc():
    """Test CRC calculation."""
    print("\n=== CRC Tests ===")

    # Known packet from capture (your ESP-connected Pico)
    # FA DE 88 00 8D E6 95 05 21 04 03 00 02 00 CC CC CC CC CC CC CC CC [CRC]
    # Device ID 0595e68d = bytes 8D E6 95 05 in little-endian

    # Create a test payload
    payload = bytearray([
        0x88,  # Type
        0x00,  # Sequence
        0x8D, 0xE6, 0x95, 0x05,  # Device ID (0595e68d little-endian)
        0x21, 0x04, 0x03, 0x00,  # Unknown fields
        0x02,  # Button (ON)
        0x00,  # Action (press)
        0xCC, 0xCC, 0xCC, 0xCC, 0xCC,  # Padding
        0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
    ])

    crc = calc_crc(bytes(payload))
    print(f"  Payload: {' '.join(f'{b:02X}' for b in payload)}")
    print(f"  CRC: 0x{crc:04X}")

    # Test append and verify
    full_packet = append_crc(bytes(payload))
    print(f"  Full packet: {' '.join(f'{b:02X}' for b in full_packet)}")

    if verify_crc(full_packet):
        print("  CRC verification: PASS")
        return True
    else:
        print("  CRC verification: FAIL")
        return False


def test_packet_creation():
    """Test packet creation."""
    print("\n=== Packet Creation Tests ===")

    # Test device ID parsing
    # The printed label is "0595e68d"
    # In the packet, bytes should be [8D, E6, 95, 05] (reversed)
    # This is achieved by storing the value 0x0595E68D as little-endian
    device_str = "0595e68d"
    device_id = parse_device_id(device_str)
    print(f"  Device ID string: {device_str}")
    print(f"  Parsed: 0x{device_id:08X}")

    # parse_device_id should return 0x0595E68D (big-endian interpretation)
    # So that little-endian storage gives [8D, E6, 95, 05]
    expected_id = 0x0595E68D
    print(f"  Expected: 0x{expected_id:08X}")

    if device_id != expected_id:
        print("  FAIL: Device ID mismatch")
        return False

    # Verify the actual bytes in packet
    expected_packet_bytes = bytes([0x8D, 0xE6, 0x95, 0x05])
    print(f"  Expected packet bytes: {expected_packet_bytes.hex().upper()}")

    # Create button press
    packet = ButtonPress.create(device_id, BUTTON_ON, sequence=0)
    print(f"\n  Created packet: {packet}")
    print(f"  Raw: {packet.hex_dump()}")

    # Verify structure
    actual_device_bytes = packet.raw[2:6]
    print(f"  Actual packet bytes: {actual_device_bytes.hex().upper()}")

    checks = [
        (packet.raw[0] == PACKET_TYPE_BUTTON_PRESS, "packet type"),
        (packet.raw[1] == 0, "sequence"),
        (actual_device_bytes == expected_packet_bytes, "device ID bytes"),
        (packet.raw[10] == BUTTON_ON, "button code"),
        (packet.raw[11] == ACTION_PRESS, "action"),
        (packet.crc_valid, "CRC valid"),
    ]

    all_passed = True
    for check, name in checks:
        if check:
            print(f"  {name}: PASS")
        else:
            print(f"  {name}: FAIL")
            all_passed = False

    return all_passed


def test_encode_decode_roundtrip():
    """Test full encode/decode round trip."""
    print("\n=== Encode/Decode Round Trip ===")

    # Create a packet
    device_id = parse_device_id("0595e68d")
    original = ButtonPress.create(device_id, BUTTON_ON, sequence=42)

    print(f"  Original: {original}")

    # Encode to bitstream
    bitstream = encode_packet(original.raw)
    print(f"  Encoded: {len(bitstream)} bits")

    # Decode back
    decoded_packets = decode_bitstream(bitstream, verbose=False)

    if not decoded_packets:
        print("  FAIL: No packets decoded")
        return False

    decoded_raw = decoded_packets[0]
    print(f"  Decoded raw: {' '.join(f'{b:02X}' for b in decoded_raw)}")

    if decoded_raw == original.raw:
        print("  Round trip: PASS")
        return True
    else:
        print("  Round trip: FAIL")
        print(f"  Original: {original.hex_dump()}")
        print(f"  Decoded:  {' '.join(f'{b:02X}' for b in decoded_raw)}")

        # Show differences
        for i in range(min(len(original.raw), len(decoded_raw))):
            if original.raw[i] != decoded_raw[i]:
                print(f"    Diff at {i}: 0x{original.raw[i]:02X} vs 0x{decoded_raw[i]:02X}")

        return False


def main():
    print("Lutron CCA Protocol Tests\n")

    results = []
    results.append(("N81 Encoding", test_n81_encoding()))
    results.append(("CRC", test_crc()))
    results.append(("Packet Creation", test_packet_creation()))
    results.append(("Round Trip", test_encode_decode_roundtrip()))

    print("\n" + "=" * 40)
    print("SUMMARY")
    print("=" * 40)

    all_passed = True
    for name, passed in results:
        status = "PASS" if passed else "FAIL"
        print(f"  {name}: {status}")
        if not passed:
            all_passed = False

    print()
    if all_passed:
        print("All tests passed!")
        return 0
    else:
        print("Some tests failed!")
        return 1


if __name__ == '__main__':
    sys.exit(main())
