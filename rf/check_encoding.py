#!/usr/bin/env python3
"""
Verify the N81 encoding produces the expected output size.
"""

def encode_n81(data_bytes, preamble_bits=32, trailing_bits=16):
    """
    Simulate the N81 encoding from lutron_protocol.cpp
    Returns total bits produced.
    """
    bits = []

    # Preamble: alternating bits
    for i in range(preamble_bits):
        bits.append((i + 1) % 2)  # 1,0,1,0...

    # Sync byte 0xFF (N81: start=0, 8 data LSB-first, stop=1)
    bits.append(0)  # start
    for i in range(8):
        bits.append((0xFF >> i) & 1)  # all 1s
    bits.append(1)  # stop

    # Prefix 0xFA (N81)
    bits.append(0)
    for i in range(8):
        bits.append((0xFA >> i) & 1)
    bits.append(1)

    # Prefix 0xDE (N81)
    bits.append(0)
    for i in range(8):
        bits.append((0xDE >> i) & 1)
    bits.append(1)

    # Data bytes (N81)
    for byte in data_bytes:
        bits.append(0)  # start
        for i in range(8):
            bits.append((byte >> i) & 1)
        bits.append(1)  # stop

    # Trailing zeros
    for _ in range(trailing_bits):
        bits.append(0)

    return len(bits), (len(bits) + 7) // 8


def main():
    print("N81 Encoding Verification")
    print("="*60)

    # Test with 47-byte packet (what we send for pairing)
    test_47 = [0xBB, 0x00] + [0x05, 0x85, 0x11, 0x17] + [0x21] + [0xCC] * 38 + [0xAB, 0xCD]
    total_bits, total_bytes = encode_n81(test_47)

    print(f"\n47-byte packet encoding:")
    print(f"  Preamble:  32 bits")
    print(f"  Sync:      10 bits (0xFF)")
    print(f"  Prefix:    20 bits (0xFA 0xDE)")
    print(f"  Data:      {47 * 10} bits (47 bytes × 10)")
    print(f"  Trailing:  16 bits")
    print(f"  Total:     {32 + 10 + 20 + 470 + 16} bits (calculated)")
    print(f"  Actual:    {total_bits} bits (from encoder)")
    print(f"  Bytes:     {total_bytes} raw bytes for CC1101")

    # Duration at 62.5 kbaud
    duration_ms = total_bits / 62500 * 1000
    print(f"  Duration:  {duration_ms:.2f}ms at 62.5 kbaud")

    # Compare to CC1101 FIFO
    print(f"\nCC1101 FIFO analysis:")
    print(f"  FIFO size:     64 bytes")
    print(f"  Packet size:   {total_bytes} bytes")
    print(f"  Needs stream:  {'YES' if total_bytes > 64 else 'NO'}")

    if total_bytes > 64:
        print(f"  Overflow by:   {total_bytes - 64} bytes")

    # Also test 24-byte packet (button presses)
    test_24 = [0xB8, 0x00] + [0x05, 0x85, 0x11, 0x17] + [0x21, 0x04] + [0xCC] * 14 + [0xAB, 0xCD]
    total_bits_24, total_bytes_24 = encode_n81(test_24)

    print(f"\n24-byte packet (button press):")
    print(f"  Total:     {total_bits_24} bits")
    print(f"  Bytes:     {total_bytes_24} raw bytes")
    print(f"  Duration:  {total_bits_24 / 62500 * 1000:.2f}ms")
    print(f"  Fits FIFO: {'YES' if total_bytes_24 <= 64 else 'NO'}")


if __name__ == '__main__':
    main()
