"""Tests for ESP32 controller packet parsing.

These tests verify that parse_packet_bytes correctly handles:
- Packet type detection including format byte discrimination
- DIMMER_ACK vs UNPAIR_PREP classification
- 0x80 type byte support
"""

import sys
import os

# Add parent directory to path for importing esp32_controller
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from esp32_controller import parse_packet_bytes, PACKET_TYPE_MAP


class TestPacketTypeMap:
    """Test that PACKET_TYPE_MAP includes all necessary type bytes."""

    def test_0x80_in_map(self):
        """0x80 should be recognized as STATE_RPT."""
        assert 0x80 in PACKET_TYPE_MAP
        assert PACKET_TYPE_MAP[0x80] == 'STATE_RPT'

    def test_0x81_0x83_in_map(self):
        """0x81-0x83 should be STATE_RPT."""
        for type_byte in (0x81, 0x82, 0x83):
            assert type_byte in PACKET_TYPE_MAP
            assert PACKET_TYPE_MAP[type_byte] == 'STATE_RPT'


class TestFormatByteDiscrimination:
    """Test format byte at [7] correctly discriminates packet subtypes."""

    def test_format_0x08_is_state_rpt(self):
        """Format byte 0x08 should classify as STATE_RPT."""
        # Real STATE_RPT packet with format 0x08
        bytes_list = ['81', '00', 'AD', '90', '2C', '00', '21', '08',
                      '00', '1B', '01', '7F', '00', '1B', '92', '7F',
                      'CC', 'CC', 'CC', 'CC', 'CC', 'CC', 'AB', 'CD']
        result = parse_packet_bytes(bytes_list)
        assert result['packet_type'] == 'STATE_RPT'
        # Level byte at [11] = 0x7F = 127 -> ~50%
        assert result['level'] is not None

    def test_format_0x0E_is_set_level(self):
        """Format byte 0x0E should classify as SET_LEVEL."""
        # Real LEVEL command with format 0x0E
        bytes_list = ['82', '05', 'AD', '90', '2C', '00', '21', '0E',
                      '00', '06', 'FD', 'EF', 'F4', 'FE', '40', '02',
                      'BE', 'DF', '00', '01', '00', '00', 'AB', 'CD']
        result = parse_packet_bytes(bytes_list)
        assert result['packet_type'] == 'SET_LEVEL'
        assert result['target_id'] == '06FDEFF4'

    def test_format_0x0C_is_unpair(self):
        """Format byte 0x0C should classify as UNPAIR."""
        # Real UNPAIR packet with format 0x0C
        bytes_list = ['82', '07', 'AF', '90', '2C', '00', '21', '0C',
                      '00', 'FF', 'FF', 'FF', 'FF', 'FF', '02', '08',
                      '07', '01', '6F', 'CE', 'CC', 'CC', '56', '27']
        result = parse_packet_bytes(bytes_list)
        assert result['packet_type'] == 'UNPAIR'
        assert result['target_id'] == '07016FCE'

    def test_format_0x09_with_fe_02_02_is_unpair_prep(self):
        """Format byte 0x09 WITH FE and 02 02 should be UNPAIR_PREP."""
        # Real UNPAIR_PREP packet: format 0x09, byte[13]=FE, bytes[14:16]=02 02
        bytes_list = ['81', '01', 'AD', '90', '2C', '00', '21', '09',
                      '00', '07', '01', '6F', 'CE', 'FE', '02', '02',
                      '00', 'CC', 'CC', 'CC', 'CC', 'CC', 'E3', 'CC']
        result = parse_packet_bytes(bytes_list)
        assert result['packet_type'] == 'UNPAIR_PREP'
        assert result['target_id'] == '07016FCE'

    def test_format_0x09_without_fe_marker_is_dimmer_ack(self):
        """Format byte 0x09 WITHOUT FE marker should be DIMMER_ACK."""
        # Dimmer ACK packet: format 0x09 but no FE + 02 02 signature
        # From user's log: 82 0D A1 82 D7 8B 21 09 00 00 00 04 8C EF 42 00 00...
        bytes_list = ['82', '0D', 'A1', '82', 'D7', '8B', '21', '09',
                      '00', '00', '00', '04', '8C', 'EF', '42', '00',
                      '00', 'CC', 'CC', 'CC', 'CC', 'CC', '09', 'DC']
        result = parse_packet_bytes(bytes_list)
        assert result['packet_type'] == 'DIMMER_ACK'

    def test_format_0x0B_is_dimmer_ack(self):
        """Format byte 0x0B should classify as DIMMER_ACK."""
        # From user's log: 83 07 A1 82 D7 8B 21 0B 00 00 00 04 8C EF 42 02 00 00 1E...
        bytes_list = ['83', '07', 'A1', '82', 'D7', '8B', '21', '0B',
                      '00', '00', '00', '04', '8C', 'EF', '42', '02',
                      '00', '00', '1E', 'CC', 'CC', 'CC', '89', 'A2']
        result = parse_packet_bytes(bytes_list)
        assert result['packet_type'] == 'DIMMER_ACK'

    def test_unknown_format_byte_labeled_bridge(self):
        """Unknown format bytes should be labeled BRIDGE_0xNN."""
        # Packet with unknown format byte 0x10
        bytes_list = ['81', '00', 'AD', '90', '2C', '00', '21', '10',
                      '00', '00', '00', '00', '00', '00', '00', '00',
                      '00', '00', '00', '00', '00', '00', 'AB', 'CD']
        result = parse_packet_bytes(bytes_list)
        assert result['packet_type'] == 'BRIDGE_0x10'


class TestDeviceIdParsing:
    """Test device ID extraction from packets."""

    def test_button_packet_device_id_big_endian(self):
        """Button packets (0x88-0x8B) use big-endian device IDs."""
        bytes_list = ['88', '00', '08', '69', '2D', '70', '21', '0C',
                      '03', '00', '09', '00', '08', '69', '2D', '70',
                      '00', '42', '00', '03', 'CC', 'CC', 'CB', '5B']
        result = parse_packet_bytes(bytes_list)
        assert result['packet_type'] == 'BTN_SHORT_A'
        assert result['device_id'] == '08692D70'

    def test_state_rpt_device_id_little_endian(self):
        """STATE_RPT packets (0x80-0x83) use little-endian device IDs."""
        # Device ID A1 82 D7 8B -> 8BD782A1 (little-endian)
        bytes_list = ['83', '07', 'A1', '82', 'D7', '8B', '21', '08',
                      '00', '00', '00', '04', '8C', 'EF', '42', '02',
                      '00', '00', '1E', 'CC', 'CC', 'CC', '89', 'A2']
        result = parse_packet_bytes(bytes_list)
        assert result['packet_type'] == 'STATE_RPT'
        assert result['device_id'] == '8BD782A1'


class TestType0x80Support:
    """Test that 0x80 type byte packets are correctly handled."""

    def test_0x80_with_format_0x09(self):
        """0x80 packets with format 0x09 should work like 0x81-0x83."""
        # From user's log: 80 07 A1 82 D7 8B 21 09 00 00 00 04 89 EF 42 00 03...
        bytes_list = ['80', '07', 'A1', '82', 'D7', '8B', '21', '09',
                      '00', '00', '00', '04', '89', 'EF', '42', '00',
                      '03', 'CC', 'CC', 'CC', 'CC', 'CC', '08', '81']
        result = parse_packet_bytes(bytes_list)
        # Should be DIMMER_ACK (format 0x09 without FE + 02 02)
        assert result['packet_type'] == 'DIMMER_ACK'
        # Device ID should be parsed from little-endian bytes
        assert result['device_id'] == '8BD782A1'


if __name__ == '__main__':
    import pytest
    pytest.main([__file__, '-v'])
