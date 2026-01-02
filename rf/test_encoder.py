#!/usr/bin/env python3
"""Test what the encoder should be producing."""

def encode_byte_n81(byte):
    """Encode byte as N81: start(0) + 8 data LSB first + stop(1)"""
    bits = '0'  # start bit
    for i in range(8):
        bits += '1' if (byte >> i) & 1 else '0'
    bits += '1'  # stop bit
    return bits

# Preamble: alternating 10101010...
preamble = ''.join(['1' if i % 2 == 0 else '0' for i in range(32)])
print(f"Preamble (32 bits): {preamble}")

# Sync 0xFF
sync = encode_byte_n81(0xFF)
print(f"Sync 0xFF encoded:  {sync}")

# Prefix 0xFA 0xDE
fa = encode_byte_n81(0xFA)
de = encode_byte_n81(0xDE)
print(f"0xFA encoded:       {fa}")
print(f"0xDE encoded:       {de}")

# Full expected start of transmission
full = preamble + sync + fa + de
print(f"\nFull start (32+10+20 = 62 bits):")
print(f"  {full[:50]}")
print(f"  {full[50:]}")

# Now pack into bytes MSB first (like C++ encoder does)
def pack_bits_msb(bits):
    """Pack bitstring into bytes, MSB first."""
    padded = bits + '0' * ((8 - len(bits) % 8) % 8)
    result = []
    for i in range(0, len(padded), 8):
        byte = int(padded[i:i+8], 2)
        result.append(byte)
    return result

packed = pack_bits_msb(full)
print(f"\nPacked bytes (MSB first): {' '.join(f'{b:02X}' for b in packed)}")

# What if CC1101 transmits each byte LSB first?
def unpack_lsb(bytes_list):
    """Unpack bytes LSB first."""
    bits = ''
    for b in bytes_list:
        for i in range(8):
            bits += '1' if (b >> i) & 1 else '0'
    return bits

as_transmitted_lsb = unpack_lsb(packed)
print(f"\nIf CC1101 sends LSB first per byte:")
print(f"  {as_transmitted_lsb[:50]}")
print(f"  {as_transmitted_lsb[50:]}")

# What does this look like as raw binary from SDR?
print(f"\nExpected vs LSB-reversed:")
print(f"  Expected: {full[:50]}")
print(f"  LSB-rev:  {as_transmitted_lsb[:50]}")
