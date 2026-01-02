#!/usr/bin/env python3
"""Check the encoded packet sizes for CC1101 FIFO limits."""

def calc_encoded_size(data_bytes, preamble_bits=32, trailing_bits=16):
    """Calculate total bits and bytes for N81 encoded packet."""
    # Preamble
    total_bits = preamble_bits

    # Sync byte (0xFF) - N81 encoded
    total_bits += 10  # 1 start + 8 data + 1 stop

    # Prefix (0xFA 0xDE) - N81 encoded
    total_bits += 20  # 2 bytes × 10 bits

    # Data bytes - N81 encoded
    total_bits += data_bytes * 10

    # Trailing
    total_bits += trailing_bits

    # Convert to raw bytes for CC1101
    raw_bytes = (total_bits + 7) // 8

    return total_bits, raw_bytes


print("Encoded packet size analysis")
print("=" * 60)
print()

for data_bytes in [24, 47, 52]:
    bits, raw = calc_encoded_size(data_bytes)
    duration_ms = bits / 62500 * 1000
    fits_fifo = "YES" if raw <= 64 else "NO - needs streaming!"
    print(f"{data_bytes}-byte packet:")
    print(f"  Total bits:  {bits}")
    print(f"  Raw bytes:   {raw}")
    print(f"  Duration:    {duration_ms:.2f}ms")
    print(f"  Fits FIFO:   {fits_fifo}")
    if raw > 64:
        print(f"  Overflow:    {raw - 64} bytes over 64-byte limit")
    print()

print("CC1101 FIFO streaming requirements:")
print("  - Initial fill: Write up to 60 bytes to FIFO")
print("  - Start TX: Strobe STX")
print("  - Monitor: Poll TXBYTES and refill when space available")
print("  - Complete: Wait for TX to finish")
