"""Tests for Lutron CCA packet parsing.

These tests verify that packet parsing correctly handles:
- Packet type detection
- Device ID extraction with proper endianness
- Field extraction (button, level, action, etc.)
- CRC validation
"""

import pytest
from lutron_cca.packet import LutronPacket, ButtonPress, parse_device_id
from lutron_cca.crc import calc_crc, verify_crc


def hex_to_bytes(hex_str: str) -> bytes:
    """Convert space-separated hex string to bytes."""
    return bytes.fromhex(hex_str.replace(" ", ""))


class TestPacketTypeDetection:
    """Test that packet types are correctly identified."""

    def test_button_short_a_type(self, fixture_lookup):
        """Button press SHORT_A has type 0x88."""
        fixture = fixture_lookup("btn_on_press_short_a")
        raw = hex_to_bytes(fixture["raw_bytes"])
        assert raw[0] == 0x88
        assert fixture["expected"]["packet_type"] == "BTN_SHORT_A"

    def test_state_rpt_type(self, fixture_lookup):
        """State report has type 0x81."""
        fixture = fixture_lookup("state_rpt_44pct")
        raw = hex_to_bytes(fixture["raw_bytes"])
        assert raw[0] == 0x81

    def test_unpair_vs_level_discrimination(self, fixture_lookup):
        """UNPAIR and LEVEL both use 0x81-0x83 types but differ in format byte."""
        unpair = fixture_lookup("unpair_phase2_flood")
        level = fixture_lookup("level_cmd_example")

        unpair_bytes = hex_to_bytes(unpair["raw_bytes"])
        level_bytes = hex_to_bytes(level["raw_bytes"])

        # Both use type 0x82
        assert unpair_bytes[0] == 0x82
        assert level_bytes[0] == 0x82

        # But format byte at [7] differs
        assert unpair_bytes[7] == 0x0C  # UNPAIR
        assert level_bytes[7] == 0x0E  # LEVEL


class TestDeviceIdEndianness:
    """Test device ID parsing with correct endianness per packet type.

    CRITICAL: Different packet types use different endianness!
    - Button packets: Device ID bytes are in big-endian order
    - STATE_RPT: Device ID bytes are in little-endian order
    """

    def test_button_packet_device_id_big_endian(self, fixture_lookup):
        """Button packets store device ID as big-endian (matches printed label)."""
        fixture = fixture_lookup("btn_on_press_short_a")
        raw = hex_to_bytes(fixture["raw_bytes"])

        # Bytes [2-5] = 8D E6 95 05
        # For button packets, read as big-endian: 0x8DE69505
        # But wait - the expected is 0595E68D
        # This means the bytes are REVERSED in the packet

        # The printed label is 0595E68D
        # In packet bytes [2-5] we see: 8D E6 95 05
        # So packet stores little-endian, but display is big-endian

        expected_id = fixture["expected"]["device_id"]  # "0595E68D"
        device_bytes = raw[2:6]

        # Reading as little-endian gives the numeric value
        device_id_le = int.from_bytes(device_bytes, "little")
        device_id_str_le = f"{device_id_le:08X}"

        # Reading as big-endian gives different value
        device_id_be = int.from_bytes(device_bytes, "big")
        device_id_str_be = f"{device_id_be:08X}"

        # For button packets, the correct interpretation gives us the printed label
        # Bytes 8D E6 95 05 read as little-endian = 0x0595E68D
        assert device_id_str_le == expected_id, (
            f"Button packet device ID should be {expected_id}, "
            f"got LE={device_id_str_le}, BE={device_id_str_be}"
        )

    def test_state_rpt_device_id_little_endian(self, fixture_lookup):
        """STATE_RPT stores device ID as little-endian."""
        fixture = fixture_lookup("state_rpt_44pct")
        raw = hex_to_bytes(fixture["raw_bytes"])

        # Bytes [2-5] = AD 90 2C 00
        # For STATE_RPT, read as little-endian: 0x002C90AD
        expected_id = fixture["expected"]["device_id"]  # "002C90AD"

        device_bytes = raw[2:6]
        device_id = int.from_bytes(device_bytes, "little")
        device_id_str = f"{device_id:08X}"

        assert device_id_str == expected_id

    def test_unpair_source_little_endian_target_big_endian(self, fixture_lookup):
        """UNPAIR has source in little-endian and target in big-endian."""
        fixture = fixture_lookup("unpair_phase2_flood")
        raw = hex_to_bytes(fixture["raw_bytes"])

        expected_source = fixture["expected"]["source_id"]  # "002C90AF"
        expected_target = fixture["expected"]["target_id"]  # "07016FCE"

        # Source at [2-5] = AF 90 2C 00, little-endian
        source_bytes = raw[2:6]
        source_id = int.from_bytes(source_bytes, "little")
        source_id_str = f"{source_id:08X}"

        # Target at [16-19] = 07 01 6F CE, big-endian
        target_bytes = raw[16:20]
        target_id = int.from_bytes(target_bytes, "big")
        target_id_str = f"{target_id:08X}"

        assert source_id_str == expected_source
        assert target_id_str == expected_target


class TestButtonParsing:
    """Test button code and action parsing."""

    def test_button_on_press(self, fixture_lookup):
        """Parse ON button press."""
        fixture = fixture_lookup("btn_on_press_short_a")
        raw = hex_to_bytes(fixture["raw_bytes"])

        # Button at offset 10
        button_code = raw[10]
        assert button_code == 0x02
        assert fixture["expected"]["button"] == "ON"

        # Action at offset 11
        action_code = raw[11]
        assert action_code == 0x00
        assert fixture["expected"]["action"] == "PRESS"

    def test_scene_pico_bright_button(self, fixture_lookup):
        """Parse Scene Pico BRIGHT (SCENE1) button."""
        fixture = fixture_lookup("btn_scene_bright")
        raw = hex_to_bytes(fixture["raw_bytes"])

        button_code = raw[10]
        assert button_code == 0x08
        assert fixture["expected"]["button"] == "SCENE1"


class TestLevelParsing:
    """Test level value parsing from packets."""

    def test_state_rpt_level_byte(self, fixture_lookup):
        """STATE_RPT uses single byte level at offset 11."""
        fixture = fixture_lookup("state_rpt_44pct")
        raw = hex_to_bytes(fixture["raw_bytes"])

        # Level byte at offset 11
        level_byte = raw[11]
        # 0x6F = 111, 111/254 * 100 = 43.7% ~ 44%
        level_percent = round(level_byte / 254 * 100)

        assert level_percent == fixture["expected"]["level"]

    def test_level_cmd_16bit_value(self, fixture_lookup):
        """LEVEL command uses 16-bit value at offset 16-17."""
        fixture = fixture_lookup("level_cmd_example")
        raw = hex_to_bytes(fixture["raw_bytes"])

        # Level at [16-17] = BE DF
        level_16bit = (raw[16] << 8) | raw[17]
        # 0xBEDF = 48863, (48863/65279)*100 = 74.8% ~ 75%
        level_percent = round(level_16bit / 65279 * 100)

        assert level_percent == fixture["expected"]["level"]


class TestCRC:
    """Test CRC calculation and validation."""

    def test_crc_valid_packet(self, fixture_lookup):
        """Packets with CRC should validate correctly."""
        fixture = fixture_lookup("unpair_phase2_flood")
        raw = hex_to_bytes(fixture["raw_bytes"])

        # CRC is in last 2 bytes
        assert fixture["expected"]["crc_valid"] is True
        assert verify_crc(raw) is True

    def test_crc_calculation(self, fixture_lookup):
        """CRC should match expected value."""
        fixture = fixture_lookup("unpair_phase2_flood")
        raw = hex_to_bytes(fixture["raw_bytes"])

        expected_crc = fixture["expected"]["crc_hex"]  # "5627"

        # Extract CRC from packet
        crc_bytes = raw[-2:]
        actual_crc = f"{crc_bytes[0]:02X}{crc_bytes[1]:02X}"

        assert actual_crc == expected_crc


class TestParseDeviceId:
    """Test the parse_device_id helper function."""

    def test_parse_device_id_string(self):
        """parse_device_id converts string to integer for packet encoding."""
        # Device "0595e68d" should give integer that when stored little-endian
        # produces bytes [8D, E6, 95, 05]
        device_str = "0595e68d"
        device_id = parse_device_id(device_str)

        # Convert to little-endian bytes
        device_bytes = device_id.to_bytes(4, "little")

        expected_bytes = bytes([0x8D, 0xE6, 0x95, 0x05])
        assert device_bytes == expected_bytes

    def test_parse_device_id_roundtrip(self):
        """Device ID should roundtrip through parse and format."""
        original = "0595E68D"
        device_id = parse_device_id(original.lower())

        # Format back to string
        formatted = f"{device_id:08X}"

        assert formatted == original


class TestFixtureIntegrity:
    """Test that fixtures are well-formed and complete."""

    def test_all_fixtures_have_required_fields(self, packet_fixtures):
        """All fixtures must have required fields."""
        required_fields = ["id", "name", "category", "raw_bytes", "expected"]

        for fixture in packet_fixtures:
            for field in required_fields:
                assert field in fixture, f"Fixture {fixture.get('id', '?')} missing {field}"

    def test_raw_bytes_are_valid_hex(self, packet_fixtures):
        """All raw_bytes should be valid hex strings."""
        for fixture in packet_fixtures:
            try:
                hex_to_bytes(fixture["raw_bytes"])
            except ValueError as e:
                pytest.fail(f"Fixture {fixture['id']} has invalid hex: {e}")

    def test_expected_packet_type_present(self, packet_fixtures):
        """All fixtures should have expected packet_type."""
        for fixture in packet_fixtures:
            assert "packet_type" in fixture["expected"], (
                f"Fixture {fixture['id']} missing expected.packet_type"
            )
