#!/usr/bin/env python3
"""
Detailed analysis of comprehensive Pico capture.
"""

import sys
sys.path.insert(0, '.')
from multi_capture import analyze_capture, load_iq, find_bursts, decode_burst
from lutron_cca.crc import verify_crc

# Raw packets from the capture (all 25 unique)
packets = [
    bytes.fromhex("88 00 05 85 11 17 21 04 03 00 02 00 CC CC CC CC CC CC CC CC CC CC 1A 38".replace(" ", "")),
    bytes.fromhex("88 02 05 85 11 17 21 04 03 00 02 00 CC CC CC CC CC CC CC CC CC CC 55 BF".replace(" ", "")),
    bytes.fromhex("88 06 05 85 11 17 21 04 03 00 02 00 CC CC CC CC CC CC CC CC CC CC CA B1".replace(" ", "")),
    bytes.fromhex("88 08 05 85 11 17 21 04 03 00 02 00 CC CC CC CC CC CC CC CC CC CC EE 2B".replace(" ", "")),
    bytes.fromhex("88 0C 05 85 11 17 21 04 03 00 02 00 CC CC CC CC CC CC CC CC CC CC 71 25".replace(" ", "")),
    bytes.fromhex("89 12 05 85 11 17 21 0E 03 00 02 01 05 85 11 17 00 40 00 20 00 00 41 9C".replace(" ", "")),
    bytes.fromhex("89 1E 05 85 11 17 21 0E 03 00 02 01 05 85 11 17 00 40 00 20 00 00 2A 81".replace(" ", "")),
    bytes.fromhex("89 24 05 85 11 17 21 0E 03 00 02 01 05 85 11 17 00 40 00 20 00 00 F7 6E".replace(" ", "")),
    bytes.fromhex("89 2A 05 85 11 17 21 0E 03 00 02 01 05 85 11 17 00 40 00 20 00 00 D3 F4".replace(" ", "")),
    bytes.fromhex("89 AC 05 85 11 17 21 0E 03 00 02 01 05 85 11 17 00 40 00 20 00 00 D8 3A".replace(" ", "")),
    bytes.fromhex("89 B2 05 85 11 17 21 0E 03 00 02 01 05 85 11 17 00 40 00 20 00 00 DE 89".replace(" ", "")),
    bytes.fromhex("89 36 05 85 11 17 21 0E 03 00 02 01 05 85 11 17 00 40 00 20 00 00 9A C0".replace(" ", "")),
    bytes.fromhex("89 3C 05 85 11 17 21 0E 03 00 02 01 05 85 11 17 00 40 00 20 00 00 21 54".replace(" ", "")),
    bytes.fromhex("89 42 05 85 11 17 21 0E 03 00 02 01 05 85 11 17 00 40 00 20 00 00 EB 11".replace(" ", "")),
    bytes.fromhex("8A 0E 05 85 11 17 21 04 03 00 04 00 CC CC CC CC CC CC CC CC CC CC 8A B1".replace(" ", "")),
    bytes.fromhex("8B 18 05 85 11 17 21 0E 03 00 04 01 05 85 11 17 00 40 00 22 00 00 10 0A".replace(" ", "")),
    bytes.fromhex("8B 9A 05 85 11 17 21 0E 03 00 04 01 05 85 11 17 00 40 00 22 00 00 84 CA".replace(" ", "")),
    bytes.fromhex("8B A6 05 85 11 17 21 0E 03 00 04 01 05 85 11 17 00 40 00 22 00 00 89 AC".replace(" ", "")),
    bytes.fromhex("8B 30 05 85 11 17 21 0E 03 00 04 01 05 85 11 17 00 40 00 22 00 00 A0 4B".replace(" ", "")),
    bytes.fromhex("8B B8 05 85 11 17 21 0E 03 00 04 01 05 85 11 17 00 40 00 22 00 00 8F 1F".replace(" ", "")),
    bytes.fromhex("89 8E 05 85 11 17 21 0E 03 00 05 01 05 85 11 17 00 42 02 01 00 16 82 9B".replace(" ", "")),
    bytes.fromhex("89 94 05 85 11 17 21 0E 03 00 05 01 05 85 11 17 00 42 02 01 00 16 1B 26".replace(" ", "")),
    bytes.fromhex("89 A0 05 85 11 17 21 0E 03 00 05 01 05 85 11 17 00 42 02 01 00 16 E2 53".replace(" ", "")),
    bytes.fromhex("89 BE 05 85 11 17 21 0E 03 00 05 01 05 85 11 17 00 42 02 01 00 16 E4 E0".replace(" ", "")),
    bytes.fromhex("89 C4 05 85 11 17 21 0E 03 00 05 01 05 85 11 17 00 42 02 01 00 16 B1 AB".replace(" ", "")),
]

BUTTON_NAMES = {
    0x02: "ON",
    0x04: "OFF",
    0x05: "RAISE",
    0x06: "LOWER",
    0x03: "FAVORITE"
}

print("=" * 80)
print("COMPREHENSIVE LUTRON PACKET ANALYSIS")
print("=" * 80)

# Group by button
by_button = {}
for pkt in packets:
    btn = pkt[10]
    if btn not in by_button:
        by_button[btn] = []
    by_button[btn].append(pkt)

# Analyze each button
for btn in sorted(by_button.keys()):
    pkts = by_button[btn]
    btn_name = BUTTON_NAMES.get(btn, f"0x{btn:02X}")
    print(f"\n{'='*80}")
    print(f"BUTTON: {btn_name} (0x{btn:02X}) - {len(pkts)} packets")
    print("="*80)

    # Separate by format
    short_pkts = [p for p in pkts if p[7] == 0x04]
    long_pkts = [p for p in pkts if p[7] == 0x0E]

    print(f"  Short format (byte[7]=0x04): {len(short_pkts)} packets")
    print(f"  Long format  (byte[7]=0x0E): {len(long_pkts)} packets")

    # Analyze types
    types = set(p[0] for p in pkts)
    print(f"  Packet types: {', '.join(f'0x{t:02X}' for t in sorted(types))}")

    # Sequence analysis
    seqs = [p[1] for p in pkts]
    print(f"\n  Sequence numbers: {', '.join(f'0x{s:02X}' for s in seqs)}")

    # Check sequence deltas
    if len(seqs) > 1:
        deltas = []
        for i in range(1, len(seqs)):
            delta = (seqs[i] - seqs[i-1]) & 0xFF
            deltas.append(delta)
        print(f"  Sequence deltas: {', '.join(str(d) for d in deltas)}")

    # Show short format structure
    if short_pkts:
        p = short_pkts[0]
        print(f"\n  SHORT FORMAT TEMPLATE:")
        print(f"    [0]  Type:     0x{p[0]:02X}")
        print(f"    [1]  Seq:      0x{p[1]:02X} (varies)")
        print(f"    [2-5] DevID:   {p[2]:02X} {p[3]:02X} {p[4]:02X} {p[5]:02X}")
        print(f"    [6]  Const:    0x{p[6]:02X}")
        print(f"    [7]  Format:   0x{p[7]:02X} (short)")
        print(f"    [8]  Const:    0x{p[8]:02X}")
        print(f"    [9]  Const:    0x{p[9]:02X}")
        print(f"    [10] Button:   0x{p[10]:02X} ({btn_name})")
        print(f"    [11] Const:    0x{p[11]:02X}")
        print(f"    [12-21] Pad:   {' '.join(f'{p[i]:02X}' for i in range(12, 22))}")

    # Show long format structure
    if long_pkts:
        p = long_pkts[0]
        print(f"\n  LONG FORMAT TEMPLATE:")
        print(f"    [0]  Type:     0x{p[0]:02X}")
        print(f"    [1]  Seq:      0x{p[1]:02X} (varies)")
        print(f"    [2-5] DevID:   {p[2]:02X} {p[3]:02X} {p[4]:02X} {p[5]:02X}")
        print(f"    [6]  Const:    0x{p[6]:02X}")
        print(f"    [7]  Format:   0x{p[7]:02X} (long)")
        print(f"    [8]  Const:    0x{p[8]:02X}")
        print(f"    [9]  Const:    0x{p[9]:02X}")
        print(f"    [10] Button:   0x{p[10]:02X} ({btn_name})")
        print(f"    [11] ExtFlag:  0x{p[11]:02X}")
        print(f"    [12-15] DevID2:{p[12]:02X} {p[13]:02X} {p[14]:02X} {p[15]:02X}")
        print(f"    [16] Zero:     0x{p[16]:02X}")
        print(f"    [17] Flags:    0x{p[17]:02X}")
        print(f"    [18] Unk18:    0x{p[18]:02X}")
        print(f"    [19] BtnFlag:  0x{p[19]:02X}")
        print(f"    [20] Unk20:    0x{p[20]:02X}")
        print(f"    [21] Unk21:    0x{p[21]:02X}")

print("\n" + "="*80)
print("CROSS-BUTTON ANALYSIS")
print("="*80)

# Compare bytes 17-21 across buttons (long format only)
print("\nLong format bytes 17-21 by button:")
for btn in sorted(by_button.keys()):
    btn_name = BUTTON_NAMES.get(btn, f"0x{btn:02X}")
    long_pkts = [p for p in by_button[btn] if p[7] == 0x0E]
    if long_pkts:
        p = long_pkts[0]
        extra = f"{p[17]:02X} {p[18]:02X} {p[19]:02X} {p[20]:02X} {p[21]:02X}"
        print(f"  {btn_name:8s}: {extra}")

# Byte 19 analysis
print("\nByte 19 analysis (long format):")
for btn in sorted(by_button.keys()):
    btn_name = BUTTON_NAMES.get(btn, f"0x{btn:02X}")
    long_pkts = [p for p in by_button[btn] if p[7] == 0x0E]
    if long_pkts:
        byte19 = long_pkts[0][19]
        if btn in [0x02, 0x04]:  # ON/OFF
            relation = f"0x20 + button = 0x{0x20 + btn:02X}" if byte19 == 0x20 + btn else f"different"
            print(f"  {btn_name:8s}: 0x{byte19:02X} ({relation})")
        else:
            print(f"  {btn_name:8s}: 0x{byte19:02X}")

# Type pattern analysis
print("\n" + "="*80)
print("TYPE PATTERN ANALYSIS")
print("="*80)
all_seqs = [(p[0], p[1], p[10]) for p in packets]
print("\nAll packets in capture order:")
print("Type  Seq   Button")
for typ, seq, btn in all_seqs:
    btn_name = BUTTON_NAMES.get(btn, f"0x{btn:02X}")
    short_long = "S" if (typ & 0x01) == 0 else "L"
    base_type = "A" if typ in [0x88, 0x89] else "B"
    print(f"0x{typ:02X}  0x{seq:02X}  {btn_name:8s}  ({short_long}/{base_type})")

print("\n" + "="*80)
print("CONCLUSIONS")
print("="*80)
print("""
1. PACKET TYPE ENCODING:
   - Bit 0: 0=Short format, 1=Long format
   - Bit 1: Alternates between button presses (A=0x88/89, B=0x8A/8B)

2. SEQUENCE NUMBERS:
   - NOT a simple counter
   - Appears to be complex pattern (rolling code or LFSR?)
   - Within one button press, short packets come first, then long

3. SHORT vs LONG FORMAT:
   - Short (byte[7]=0x04): Minimal packet, 0xCC padding
   - Long (byte[7]=0x0E): Extended info, device ID repeated, extra flags

4. RAISE BUTTON (0x05) IS DIFFERENT:
   - Bytes 17-21: 42 02 01 00 16 (vs 40 00 2X 00 00 for ON/OFF)
   - This may indicate it's a "hold" command for dimming

5. FOR TRANSMISSION:
   - Both short AND long formats should be sent
   - Type should alternate between button presses
   - Sequence number pattern needs more analysis
""")
