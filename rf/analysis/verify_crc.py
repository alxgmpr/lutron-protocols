#!/usr/bin/env python3
"""Verify CRC algorithm matches real Pico capture."""

# CRC polynomial 0xCA0F
def build_crc_table():
    table = []
    for i in range(256):
        crc = i << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0xCA0F) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
        table.append(crc)
    return table

def calc_crc(data, table):
    crc_reg = 0
    for byte in data:
        crc_upper = crc_reg >> 8
        crc_reg = (((crc_reg << 8) & 0xFF00) + byte) ^ table[crc_upper]
    return crc_reg

# Build table
table = build_crc_table()

# Decoded bytes from real_pico_pairing.cu8 (button press, not pairing)
# After FA DE: 8A 00 05 85 11 17 21 04 03 00 04 00 CC CC CC CC CC CC CC CC CC CC
# CRC at end: C8 8C

# Reconstruct the 22-byte payload (matching our packet structure)
payload = bytes([
    0x8A,  # Type (short format button press)
    0x00,  # Sequence
    0x05, 0x85, 0x11, 0x17,  # Device ID 0x17118505 (little-endian)
    0x21,  # Protocol marker
    0x04,  # Format byte (short format for OFF button)
    0x03, 0x00,  # bytes 8-9
    0x04,  # Button (OFF = 0x04)
    0x00,  # byte 11
    0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC  # padding
])

print(f"Payload ({len(payload)} bytes):")
print(" ".join(f"{b:02X}" for b in payload))

crc = calc_crc(payload, table)
print(f"\nCalculated CRC: 0x{crc:04X}")
print(f"  High byte: 0x{crc >> 8:02X}")
print(f"  Low byte:  0x{crc & 0xFF:02X}")

# From capture: C8 8C
# If big-endian: 0xC88C
# If little-endian: 0x8CC8
print(f"\nCapture shows: C8 8C")
print(f"  As big-endian:    0xC88C")
print(f"  As little-endian: 0x8CC8")

if crc == 0xC88C:
    print("\n✓ CRC MATCHES (big-endian format in capture)")
elif crc == 0x8CC8:
    print("\n✓ CRC MATCHES (little-endian format in capture)")
else:
    print(f"\n✗ CRC MISMATCH! Our calc: 0x{crc:04X}")

# Also try with the packet as seen in decoder output (might have slight differences)
# The decoder showed: 8A 00 05 85 11 17 21 04 03 00 04 00 CC CC CC CC CC CC CC CC CC
# That's only 21 bytes before CRC, suggesting one CC might be missing or different

print("\n--- Trying alternative payloads ---")

# Try with 21 bytes (one less CC)
alt_payload1 = bytes([
    0x8A, 0x00, 0x05, 0x85, 0x11, 0x17, 0x21, 0x04,
    0x03, 0x00, 0x04, 0x00, 0xCC, 0xCC, 0xCC, 0xCC,
    0xCC, 0xCC, 0xCC, 0xCC, 0xCC
])
crc1 = calc_crc(alt_payload1, table)
print(f"21 bytes: CRC = 0x{crc1:04X}")

# Try with slightly different structure from capture analysis
# Maybe byte order is different?
alt_payload2 = bytes([
    0x8A, 0x00,
    0x05, 0x85, 0x11, 0x17,  # Device ID
    0x21,
    0x04,  # byte 7
    0x03, 0x00,
    0x04, 0x00,  # button and extra byte
    0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC
])
crc2 = calc_crc(alt_payload2, table)
print(f"21 bytes (alt): CRC = 0x{crc2:04X}")

print("\nLooking for payload that gives CRC 0xC88C or 0x8CC8...")

# Maybe CRC includes FA DE prefix?
print("\n--- Trying with FA DE prefix ---")
with_prefix = bytes([0xFA, 0xDE]) + payload
crc_with_prefix = calc_crc(with_prefix, table)
print(f"FA DE + 22 bytes: CRC = 0x{crc_with_prefix:04X}")

with_prefix_21 = bytes([0xFA, 0xDE]) + alt_payload1
crc_with_prefix_21 = calc_crc(with_prefix_21, table)
print(f"FA DE + 21 bytes: CRC = 0x{crc_with_prefix_21:04X}")

# Maybe CRC includes FF (sync byte)?
print("\n--- Trying with FF FA DE prefix ---")
with_ff_prefix = bytes([0xFF, 0xFA, 0xDE]) + payload
crc_ff = calc_crc(with_ff_prefix, table)
print(f"FF FA DE + 22 bytes: CRC = 0x{crc_ff:04X}")

# Maybe there's an initial CRC value?
print("\n--- Trying with initial CRC value ---")
def calc_crc_init(data, table, init=0xFFFF):
    crc_reg = init
    for byte in data:
        crc_upper = crc_reg >> 8
        crc_reg = (((crc_reg << 8) & 0xFF00) + byte) ^ table[crc_upper]
    return crc_reg

for init in [0xFFFF, 0x0000, 0xCA0F]:
    crc_init = calc_crc_init(payload, table, init)
    print(f"Init 0x{init:04X}: CRC = 0x{crc_init:04X}")

# Maybe final XOR?
print("\n--- Trying with final XOR ---")
for xor_val in [0xFFFF, 0xCA0F]:
    crc_xor = calc_crc(payload, table) ^ xor_val
    print(f"XOR 0x{xor_val:04X}: CRC = 0x{crc_xor:04X}")

# Let me also print what the original capture bytes look like after stripping preamble noise
print("\n--- Raw capture analysis ---")
# From decoder: 0F C7 55 55 55 FA DE 8A 00 05 85 11 17 21 04 03 00 04 00 CC CC CC CC CC CC CC CC CC C8 8C
raw_after_fade = bytes([0x8A, 0x00, 0x05, 0x85, 0x11, 0x17, 0x21, 0x04, 0x03, 0x00, 0x04, 0x00,
                         0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC])
print(f"Bytes after FA DE (21): {' '.join(f'{b:02X}' for b in raw_after_fade)}")
print(f"CRC of 21 bytes: 0x{calc_crc(raw_after_fade, table):04X}")

# Try different lengths of CC padding
print("\n--- Varying CC padding count ---")
for cc_count in range(8, 14):
    test = bytes([0x8A, 0x00, 0x05, 0x85, 0x11, 0x17, 0x21, 0x04, 0x03, 0x00, 0x04, 0x00] + [0xCC] * cc_count)
    crc_test = calc_crc(test, table)
    if crc_test in [0xC88C, 0x8CC8]:
        print(f"  {cc_count} CCs: 0x{crc_test:04X} *** MATCH ***")
    else:
        print(f"  {cc_count} CCs ({len(test)} total): 0x{crc_test:04X}")
