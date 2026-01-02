# Lutron CCA CRC-16 Implementation
# Polynomial: 0x1CA0F (non-standard)

from .constants import CRC_POLY

# Pre-computed CRC table
_crc_table = None

def _init_crc_table():
    """Initialize the CRC lookup table."""
    global _crc_table
    if _crc_table is not None:
        return

    _crc_table = []
    for i in range(256):
        crc = i << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ CRC_POLY) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
        _crc_table.append(crc)


def calc_crc(data: bytes) -> int:
    """
    Calculate CRC-16 for Lutron packet data.

    Args:
        data: Bytes to calculate CRC over (typically bytes 0-21 of packet)

    Returns:
        16-bit CRC value
    """
    _init_crc_table()

    crc_reg = 0
    for byte in data:
        crc_upper = crc_reg >> 8
        crc_reg = (((crc_reg << 8) & 0xFF00) + byte) ^ _crc_table[crc_upper]

    return crc_reg


def verify_crc(packet: bytes) -> bool:
    """
    Verify CRC of a complete 24-byte Lutron packet.

    Args:
        packet: Complete packet including CRC (24 bytes)

    Returns:
        True if CRC is valid
    """
    if len(packet) < 24:
        return False

    calculated = calc_crc(packet[:22])
    received = (packet[22] << 8) | packet[23]

    return calculated == received


def append_crc(payload: bytes) -> bytes:
    """
    Append CRC-16 to payload.

    Args:
        payload: 22 bytes of payload data

    Returns:
        24 bytes with CRC appended (big-endian)
    """
    crc = calc_crc(payload)
    return payload + bytes([crc >> 8, crc & 0xFF])
