#!/usr/bin/env python3
"""Compare our pairing packet generation vs real Pico captures."""

def calc_crc(data):
    """Calculate Lutron CRC (polynomial 0xCA0F)."""
    # Build CRC table
    crc_table = []
    for i in range(256):
        crc = i << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0xCA0F) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
        crc_table.append(crc)

    # Calculate CRC
    crc_reg = 0
    for byte in data:
        crc_upper = crc_reg >> 8
        crc_reg = (((crc_reg << 8) & 0xFF00) + byte) ^ crc_table[crc_upper]
    return crc_reg


def generate_ba_packet(device_id, button, seq=0):
    """Generate a 0xBA pairing packet (phase 1) like our C++ code does."""
    packet = [0xCC] * 53  # Start with CC padding

    packet[0] = 0xBA
    packet[1] = seq

    # Device ID (little-endian)
    packet[2] = (device_id >> 0) & 0xFF
    packet[3] = (device_id >> 8) & 0xFF
    packet[4] = (device_id >> 16) & 0xFF
    packet[5] = (device_id >> 24) & 0xFF

    packet[6] = 0x21
    packet[7] = 0x21  # Format for 0xBA
    packet[8] = 0x04
    packet[9] = 0x00
    packet[10] = 0x07  # Fixed value
    packet[11] = 0x03
    packet[12] = 0x00

    # Broadcast
    packet[13] = 0xFF
    packet[14] = 0xFF
    packet[15] = 0xFF
    packet[16] = 0xFF
    packet[17] = 0xFF

    packet[18] = 0x0D
    packet[19] = 0x00  # Phase 1

    # Device ID (second instance)
    packet[20] = (device_id >> 0) & 0xFF
    packet[21] = (device_id >> 8) & 0xFF
    packet[22] = (device_id >> 16) & 0xFF
    packet[23] = (device_id >> 24) & 0xFF

    # Device ID (third instance)
    packet[24] = (device_id >> 0) & 0xFF
    packet[25] = (device_id >> 8) & 0xFF
    packet[26] = (device_id >> 16) & 0xFF
    packet[27] = (device_id >> 24) & 0xFF

    packet[28] = 0x00
    packet[29] = 0x20
    packet[30] = button
    packet[31] = 0x00

    packet[32] = 0x08
    packet[33] = 0x07
    packet[34] = button
    packet[35] = 0x00
    packet[36] = 0x07

    # Final broadcast
    packet[37] = 0xFF
    packet[38] = 0xFF
    packet[39] = 0xFF
    packet[40] = 0xFF

    # Bytes 41-50 stay as CC padding

    # CRC
    crc = calc_crc(packet[:51])
    packet[51] = (crc >> 8) & 0xFF
    packet[52] = crc & 0xFF

    return packet


def parse_capture_line(line):
    """Parse a line from the capture file."""
    # Format: "   5185.18 ba 00 02 a2 4c 77 ..."
    parts = line.strip().split()
    if len(parts) < 2:
        return None
    # Skip timestamp, get hex bytes
    hex_bytes = []
    for p in parts[1:]:
        if p == "CRC" or p == "Match" or p == "is" or p == "True" or p == "False":
            break
        if ',' in p:
            p = p.rstrip(',')
        try:
            hex_bytes.append(int(p, 16))
        except ValueError:
            break
    return hex_bytes


# Real Pico capture (from pico_pairrequest.txt, first 0xBA packet)
real_pico_hex = "ba 00 02 a2 4c 77 21 21 04 00 07 03 00 ff ff ff ff ff 0d 00 02 a2 4c 77 02 a2 4c 77 00 20 03 00 08 07 03 00 07 ff ff ff ff cc cc cc cc cc cc cc cc cc cc 87 b5"
real_pico = [int(x, 16) for x in real_pico_hex.split()]

# Real Pico device ID and button from capture
real_device_id = 0x774CA202  # Little-endian from: 02 a2 4c 77
real_button = 0x03  # FAVORITE button

# Generate our version with same parameters
our_packet = generate_ba_packet(real_device_id, real_button, seq=0)

print("=" * 80)
print("BYTE-BY-BYTE COMPARISON: Real Pico vs Our Generation")
print("=" * 80)
print(f"Device ID: 0x{real_device_id:08X} (little-endian: {real_device_id & 0xFF:02X} {(real_device_id >> 8) & 0xFF:02X} {(real_device_id >> 16) & 0xFF:02X} {(real_device_id >> 24) & 0xFF:02X})")
print(f"Button: 0x{real_button:02X}")
print()

print(f"{'Byte':<6} {'Real':<6} {'Ours':<6} {'Match':<8} {'Description'}")
print("-" * 80)

descriptions = {
    0: "Type",
    1: "Sequence",
    2: "DevID[0]",
    3: "DevID[1]",
    4: "DevID[2]",
    5: "DevID[3]",
    6: "Protocol (0x21)",
    7: "Format (0x21 for BA)",
    8: "Const",
    9: "Const",
    10: "Fixed (0x07)",
    11: "Const",
    12: "Const",
    13: "Broadcast[0]",
    14: "Broadcast[1]",
    15: "Broadcast[2]",
    16: "Broadcast[3]",
    17: "Broadcast[4]",
    18: "Const (0x0D)",
    19: "Phase (0x00 for BA)",
    20: "DevID2[0]",
    21: "DevID2[1]",
    22: "DevID2[2]",
    23: "DevID2[3]",
    24: "DevID3[0]",
    25: "DevID3[1]",
    26: "DevID3[2]",
    27: "DevID3[3]",
    28: "Const",
    29: "Const (0x20)",
    30: "Button",
    31: "Const",
    32: "Const (0x08)",
    33: "Const (0x07)",
    34: "Button (again)",
    35: "Const",
    36: "Const (0x07)",
    37: "Broadcast2[0]",
    38: "Broadcast2[1]",
    39: "Broadcast2[2]",
    40: "Broadcast2[3]",
    41: "Padding",
    42: "Padding",
    43: "Padding",
    44: "Padding",
    45: "Padding",
    46: "Padding",
    47: "Padding",
    48: "Padding",
    49: "Padding",
    50: "Padding",
    51: "CRC[0]",
    52: "CRC[1]",
}

mismatches = []
for i in range(len(real_pico)):
    real_byte = real_pico[i]
    our_byte = our_packet[i] if i < len(our_packet) else None

    if our_byte is None:
        match = "MISSING"
        mismatches.append(i)
    elif real_byte == our_byte:
        match = "OK"
    else:
        match = "DIFFER"
        mismatches.append(i)

    desc = descriptions.get(i, "")
    our_str = f"0x{our_byte:02X}" if our_byte is not None else "N/A"
    print(f"[{i:2d}]   0x{real_byte:02X}   {our_str}   {match:<8} {desc}")

print()
print("=" * 80)
if mismatches:
    print(f"MISMATCHES at bytes: {mismatches}")
else:
    print("ALL BYTES MATCH!")
print("=" * 80)

# Verify CRC
print()
print("CRC Verification:")
real_crc = (real_pico[51] << 8) | real_pico[52]
our_crc = (our_packet[51] << 8) | our_packet[52]
calculated_crc = calc_crc(real_pico[:51])
print(f"  Real Pico CRC:    0x{real_crc:04X}")
print(f"  Our generated:    0x{our_crc:04X}")
print(f"  Calculated:       0x{calculated_crc:04X}")
print(f"  CRC match:        {real_crc == calculated_crc}")

# Print both packets as hex strings for easy comparison
print()
print("Full packet comparison:")
print(f"Real: {' '.join(f'{b:02x}' for b in real_pico)}")
print(f"Ours: {' '.join(f'{b:02x}' for b in our_packet)}")
