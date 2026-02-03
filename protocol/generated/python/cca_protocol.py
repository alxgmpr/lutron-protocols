"""
Auto-generated from protocol/cca.yaml
DO NOT EDIT - regenerate with: cca codegen

Lutron Clear Connect Type A v1.0.0
"""

from enum import IntEnum
from dataclasses import dataclass
from typing import Optional, List, Callable, Awaitable
import asyncio

# RF physical layer constants
RF_FREQUENCY_HZ = 433602844
RF_DEVIATION_HZ = 41200
RF_BAUD_RATE = 62484.7

# CRC configuration
CRC_POLYNOMIAL = 0xCA0F
CRC_WIDTH = 16
CRC_INITIAL = 0x0000

# Packet framing
PREAMBLE_BITS = 32
PREAMBLE_PATTERN = 0xAAAAAAAA
SYNC_BYTE = 0xFF
PREFIX = bytes([0xFA, 0xDE])
TRAILING_BITS = 16

# Timing constants (milliseconds)
BUTTON_REPEAT_MS = 70
BEACON_INTERVAL_MS = 65
PAIRING_INTERVAL_MS = 75
LEVEL_REPORT_MS = 60
UNPAIR_INTERVAL_MS = 60
LED_CONFIG_INTERVAL_MS = 75

# Sequence number behavior
SEQUENCE_INCREMENT = 6
SEQUENCE_WRAP = 0x48

# Packet lengths
LENGTH_STANDARD = 24
LENGTH_PAIRING = 53


# Button action codes
class Action(IntEnum):
    """Button action codes."""
    HOLD = 0x02  # Continuous hold for dimming
    PRESS = 0x00
    RELEASE = 0x01
    SAVE = 0x03  # Save favorite/scene


# Button code values
class Button(IntEnum):
    """Button code values."""
    FAVORITE = 0x03  # 5-button FAV / middle
    LOWER = 0x06  # 5-button LOWER
    OFF = 0x04  # 5-button OFF / bottom
    ON = 0x02  # 5-button ON / top
    RAISE = 0x05  # 5-button RAISE
    RESET = 0xFF  # Reset/unpair
    SCENE1 = 0x0B  # 4-button top
    SCENE2 = 0x0A  # 4-button second
    SCENE3 = 0x09  # 4-button third
    SCENE4 = 0x08  # 4-button bottom


# Packet categories for filtering
class Category(IntEnum):
    """Packet categories for filtering."""
    pass


# Device class codes (byte 28 in pairing)
class DeviceClass(IntEnum):
    """Device class codes (byte 28 in pairing)."""
    DIMMER = 0x04
    FAN = 0x06
    KEYPAD = 0x0B
    SHADE = 0x0A
    SWITCH = 0x05


class PacketType(IntEnum):
    """Packet type codes."""
    BEACON_91 = 0x91  # Pairing beacon
    BEACON_92 = 0x92  # Beacon stop
    BEACON_93 = 0x93  # Initial pairing beacon
    BTN_LONG_A = 0x89  # Button press, long format, group A
    BTN_LONG_B = 0x8B  # Button press, long format, group B
    BTN_SHORT_A = 0x88  # Button press, short format, group A
    BTN_SHORT_B = 0x8A  # Button press, short format, group B
    CONFIG_A1 = 0xA1  # Configuration packet (pairing)
    HS_C1 = 0xC1  # Handshake round 1 (dimmer)
    HS_C2 = 0xC2  # Handshake round 1 (bridge)
    HS_C7 = 0xC7  # Handshake round 2 (dimmer)
    HS_C8 = 0xC8  # Handshake round 2 (bridge)
    HS_CD = 0xCD  # Handshake round 3 (dimmer)
    HS_CE = 0xCE  # Handshake round 3 (bridge)
    HS_D3 = 0xD3  # Handshake round 4 (dimmer)
    HS_D4 = 0xD4  # Handshake round 4 (bridge)
    HS_D9 = 0xD9  # Handshake round 5 (dimmer)
    HS_DA = 0xDA  # Handshake round 5 (bridge)
    HS_DF = 0xDF  # Handshake round 6 (dimmer)
    HS_E0 = 0xE0  # Handshake round 6 (bridge)
    LED_CONFIG = 0xF2  # LED configuration (derived from STATE_RPT format 0x0A)
    PAIR_B0 = 0xB0  # Dimmer discovery (announces hardware ID to bridge)
    PAIR_B8 = 0xB8  # Scene Pico pairing (bridge-only)
    PAIR_B9 = 0xB9  # Direct-pair Pico pairing
    PAIR_BA = 0xBA  # Scene Pico pairing variant
    PAIR_BB = 0xBB  # Direct-pair Pico pairing variant
    PAIR_RESP_C0 = 0xC0  # Pairing response
    SET_LEVEL = 0xA2  # Set level command
    STATE_80 = 0x80  # Dimmer state report (pairing phase)
    STATE_RPT_81 = 0x81  # State report (type 81)
    STATE_RPT_82 = 0x82  # State report (type 82)
    STATE_RPT_83 = 0x83  # State report (type 83)
    UNPAIR = 0xF0  # Unpair command (derived from STATE_RPT format 0x0C)
    UNPAIR_PREP = 0xF1  # Unpair preparation (derived from STATE_RPT format 0x09)


# Packet type aliases (map aliased values to canonical types)
PACKET_TYPE_ALIASES: dict[int, PacketType] = {
}


@dataclass
class FieldDef:
    """Field definition for packet parsing."""
    name: str
    offset: int
    size: int
    format: str
    description: str = ""


# Field definitions by packet type
PACKET_FIELDS: dict[str, list[FieldDef]] = {
    "BEACON_91": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="load_id", offset=2, size=4, format="device_id_be"),
        FieldDef(name="protocol", offset=6, size=1, format="hex"),
        FieldDef(name="format", offset=7, size=1, format="hex"),
        FieldDef(name="fixed", offset=8, size=5, format="hex"),
        FieldDef(name="broadcast", offset=13, size=9, format="hex"),
        FieldDef(name="crc", offset=22, size=2, format="hex"),
    ],
    "BTN_LONG_A": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="device_id", offset=2, size=4, format="device_id_be"),
        FieldDef(name="protocol", offset=6, size=1, format="hex"),
        FieldDef(name="format", offset=7, size=1, format="hex", description="0x0E for long"),
        FieldDef(name="fixed", offset=8, size=2, format="hex"),
        FieldDef(name="button", offset=10, size=1, format="button"),
        FieldDef(name="action", offset=11, size=1, format="action"),
        FieldDef(name="device_repeat", offset=12, size=4, format="device_id_be"),
        FieldDef(name="button_data", offset=16, size=6, format="hex"),
        FieldDef(name="crc", offset=22, size=2, format="hex"),
    ],
    "BTN_SHORT_A": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="device_id", offset=2, size=4, format="device_id_be"),
        FieldDef(name="protocol", offset=6, size=1, format="hex", description="Always 0x21"),
        FieldDef(name="format", offset=7, size=1, format="hex", description="0x04 for short"),
        FieldDef(name="fixed", offset=8, size=2, format="hex"),
        FieldDef(name="button", offset=10, size=1, format="button"),
        FieldDef(name="action", offset=11, size=1, format="action"),
        FieldDef(name="padding", offset=12, size=10, format="hex"),
        FieldDef(name="crc", offset=22, size=2, format="hex"),
    ],
    "CONFIG_A1": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="device_id", offset=2, size=4, format="device_id"),
        FieldDef(name="protocol", offset=6, size=1, format="hex"),
        FieldDef(name="format", offset=7, size=1, format="hex"),
        FieldDef(name="data", offset=8, size=14, format="hex"),
        FieldDef(name="crc", offset=22, size=2, format="hex"),
    ],
    "PAIR_B0": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="flags", offset=2, size=1, format="hex"),
        FieldDef(name="zone_id", offset=3, size=2, format="hex", description="Bridge zone ID"),
        FieldDef(name="pair_flag", offset=5, size=1, format="hex", description="0x7F during pairing"),
        FieldDef(name="protocol", offset=6, size=1, format="hex"),
        FieldDef(name="format", offset=7, size=1, format="hex"),
        FieldDef(name="reserved", offset=8, size=1, format="hex"),
        FieldDef(name="broadcast", offset=9, size=5, format="hex", description="FF FF FF FF FF"),
        FieldDef(name="fixed", offset=14, size=2, format="hex"),
        FieldDef(name="hardware_id", offset=16, size=4, format="device_id_be", description="Dimmer hardware ID"),
        FieldDef(name="device_type", offset=20, size=1, format="hex", description="0x04=dimmer"),
        FieldDef(name="caps", offset=21, size=10, format="hex", description="Device capabilities"),
        FieldDef(name="padding", offset=31, size=20, format="hex"),
        FieldDef(name="crc", offset=51, size=2, format="hex"),
    ],
    "PAIR_B8": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="device_id", offset=2, size=4, format="device_id_be"),
        FieldDef(name="protocol", offset=6, size=1, format="hex"),
        FieldDef(name="format", offset=7, size=1, format="hex"),
        FieldDef(name="fixed", offset=8, size=2, format="hex"),
        FieldDef(name="btn_scheme", offset=10, size=1, format="hex", description="Button scheme byte"),
        FieldDef(name="fixed2", offset=11, size=2, format="hex"),
        FieldDef(name="broadcast", offset=13, size=5, format="hex"),
        FieldDef(name="fixed3", offset=18, size=2, format="hex"),
        FieldDef(name="device_id2", offset=20, size=4, format="device_id_be"),
        FieldDef(name="device_id3", offset=24, size=4, format="device_id_be"),
        FieldDef(name="device_class", offset=28, size=1, format="hex"),
        FieldDef(name="device_sub", offset=29, size=1, format="hex"),
        FieldDef(name="caps", offset=30, size=11, format="hex"),
        FieldDef(name="broadcast2", offset=41, size=4, format="hex"),
        FieldDef(name="padding", offset=45, size=6, format="hex"),
        FieldDef(name="crc", offset=51, size=2, format="hex"),
    ],
    "PAIR_RESP_C0": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="device_id", offset=2, size=4, format="device_id_be"),
        FieldDef(name="protocol", offset=6, size=1, format="hex"),
        FieldDef(name="format", offset=7, size=1, format="hex"),
        FieldDef(name="data", offset=8, size=14, format="hex"),
        FieldDef(name="crc", offset=22, size=2, format="hex"),
    ],
    "SET_LEVEL": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="source_id", offset=2, size=4, format="device_id"),
        FieldDef(name="protocol", offset=6, size=1, format="hex"),
        FieldDef(name="format", offset=7, size=1, format="hex"),
        FieldDef(name="fixed", offset=8, size=1, format="hex"),
        FieldDef(name="target_id", offset=9, size=4, format="device_id_be"),
        FieldDef(name="fixed2", offset=13, size=3, format="hex"),
        FieldDef(name="level", offset=16, size=2, format="level_16bit"),
        FieldDef(name="padding", offset=18, size=4, format="hex"),
        FieldDef(name="crc", offset=22, size=2, format="hex"),
    ],
    "STATE_80": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="zone_id", offset=3, size=2, format="hex"),
        FieldDef(name="protocol", offset=5, size=1, format="hex"),
        FieldDef(name="fixed", offset=6, size=2, format="hex"),
        FieldDef(name="state", offset=8, size=14, format="hex"),
        FieldDef(name="crc", offset=22, size=2, format="hex"),
    ],
    "STATE_RPT_81": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="device_id", offset=2, size=4, format="device_id"),
        FieldDef(name="protocol", offset=6, size=1, format="hex"),
        FieldDef(name="format", offset=7, size=1, format="hex"),
        FieldDef(name="fixed", offset=8, size=3, format="hex"),
        FieldDef(name="level", offset=11, size=1, format="level_byte"),
        FieldDef(name="padding", offset=12, size=10, format="hex"),
        FieldDef(name="crc", offset=22, size=2, format="hex"),
    ],
    "UNPAIR": [
        FieldDef(name="type", offset=0, size=1, format="hex"),
        FieldDef(name="sequence", offset=1, size=1, format="decimal"),
        FieldDef(name="source_id", offset=2, size=4, format="device_id"),
        FieldDef(name="protocol", offset=6, size=1, format="hex"),
        FieldDef(name="format", offset=7, size=1, format="hex", description="0x0C for unpair"),
        FieldDef(name="fixed", offset=8, size=3, format="hex"),
        FieldDef(name="command", offset=11, size=5, format="hex"),
        FieldDef(name="target_id", offset=16, size=4, format="device_id_be"),
        FieldDef(name="padding", offset=20, size=2, format="hex"),
        FieldDef(name="crc", offset=22, size=2, format="hex"),
    ],
}


@dataclass
class PacketTypeInfo:
    """Information about a packet type."""
    name: str
    length: int
    category: str
    description: str
    uses_big_endian_device_id: bool
    is_virtual: bool = False


# Packet type information lookup
PACKET_TYPE_INFO: dict[int, PacketTypeInfo] = {
    0x91: PacketTypeInfo(
        name="BEACON_91",
        length=24,
        category="BEACON",
        description="Pairing beacon",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0x92: PacketTypeInfo(
        name="BEACON_92",
        length=24,
        category="BEACON",
        description="Beacon stop",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0x93: PacketTypeInfo(
        name="BEACON_93",
        length=24,
        category="BEACON",
        description="Initial pairing beacon",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0x89: PacketTypeInfo(
        name="BTN_LONG_A",
        length=24,
        category="BUTTON",
        description="Button press, long format, group A",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0x8B: PacketTypeInfo(
        name="BTN_LONG_B",
        length=24,
        category="BUTTON",
        description="Button press, long format, group B",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0x88: PacketTypeInfo(
        name="BTN_SHORT_A",
        length=24,
        category="BUTTON",
        description="Button press, short format, group A",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0x8A: PacketTypeInfo(
        name="BTN_SHORT_B",
        length=24,
        category="BUTTON",
        description="Button press, short format, group B",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xA1: PacketTypeInfo(
        name="CONFIG_A1",
        length=24,
        category="CONFIG",
        description="Configuration packet (pairing)",
        uses_big_endian_device_id=False,
        is_virtual=False,
    ),
    0xC1: PacketTypeInfo(
        name="HS_C1",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 1 (dimmer)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xC2: PacketTypeInfo(
        name="HS_C2",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 1 (bridge)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xC7: PacketTypeInfo(
        name="HS_C7",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 2 (dimmer)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xC8: PacketTypeInfo(
        name="HS_C8",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 2 (bridge)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xCD: PacketTypeInfo(
        name="HS_CD",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 3 (dimmer)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xCE: PacketTypeInfo(
        name="HS_CE",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 3 (bridge)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xD3: PacketTypeInfo(
        name="HS_D3",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 4 (dimmer)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xD4: PacketTypeInfo(
        name="HS_D4",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 4 (bridge)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xD9: PacketTypeInfo(
        name="HS_D9",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 5 (dimmer)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xDA: PacketTypeInfo(
        name="HS_DA",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 5 (bridge)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xDF: PacketTypeInfo(
        name="HS_DF",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 6 (dimmer)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xE0: PacketTypeInfo(
        name="HS_E0",
        length=24,
        category="HANDSHAKE",
        description="Handshake round 6 (bridge)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xF2: PacketTypeInfo(
        name="LED_CONFIG",
        length=24,
        category="CONFIG",
        description="LED configuration (derived from STATE_RPT format 0x0A)",
        uses_big_endian_device_id=False,
        is_virtual=False,
    ),
    0xB0: PacketTypeInfo(
        name="PAIR_B0",
        length=53,
        category="PAIRING",
        description="Dimmer discovery (announces hardware ID to bridge)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xB8: PacketTypeInfo(
        name="PAIR_B8",
        length=53,
        category="PAIRING",
        description="Scene Pico pairing (bridge-only)",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xB9: PacketTypeInfo(
        name="PAIR_B9",
        length=53,
        category="PAIRING",
        description="Direct-pair Pico pairing",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xBA: PacketTypeInfo(
        name="PAIR_BA",
        length=53,
        category="PAIRING",
        description="Scene Pico pairing variant",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xBB: PacketTypeInfo(
        name="PAIR_BB",
        length=53,
        category="PAIRING",
        description="Direct-pair Pico pairing variant",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xC0: PacketTypeInfo(
        name="PAIR_RESP_C0",
        length=24,
        category="HANDSHAKE",
        description="Pairing response",
        uses_big_endian_device_id=True,
        is_virtual=False,
    ),
    0xA2: PacketTypeInfo(
        name="SET_LEVEL",
        length=24,
        category="CONFIG",
        description="Set level command",
        uses_big_endian_device_id=False,
        is_virtual=False,
    ),
    0x80: PacketTypeInfo(
        name="STATE_80",
        length=24,
        category="STATE",
        description="Dimmer state report (pairing phase)",
        uses_big_endian_device_id=False,
        is_virtual=False,
    ),
    0x81: PacketTypeInfo(
        name="STATE_RPT_81",
        length=24,
        category="STATE",
        description="State report (type 81)",
        uses_big_endian_device_id=False,
        is_virtual=False,
    ),
    0x82: PacketTypeInfo(
        name="STATE_RPT_82",
        length=24,
        category="STATE",
        description="State report (type 82)",
        uses_big_endian_device_id=False,
        is_virtual=False,
    ),
    0x83: PacketTypeInfo(
        name="STATE_RPT_83",
        length=24,
        category="STATE",
        description="State report (type 83)",
        uses_big_endian_device_id=False,
        is_virtual=False,
    ),
    0xF0: PacketTypeInfo(
        name="UNPAIR",
        length=24,
        category="CONFIG",
        description="Unpair command (derived from STATE_RPT format 0x0C)",
        uses_big_endian_device_id=False,
        is_virtual=False,
    ),
    0xF1: PacketTypeInfo(
        name="UNPAIR_PREP",
        length=24,
        category="CONFIG",
        description="Unpair preparation (derived from STATE_RPT format 0x09)",
        uses_big_endian_device_id=False,
        is_virtual=False,
    ),
}


@dataclass
class SequenceStep:
    """A step in a transmission sequence."""
    packet_type: str
    count: Optional[int]  # None = repeat until stopped
    interval_ms: int


@dataclass
class Sequence:
    """Transmission sequence definition."""
    name: str
    description: str
    steps: list[SequenceStep]


# Transmission sequences
SEQUENCES: dict[str, Sequence] = {
    "button_hold": Sequence(
        name="button_hold",
        description="Dimming hold (raise/lower)",
        steps=[
            SequenceStep(packet_type="BTN_SHORT_A", count=None, interval_ms=65),
        ],
    ),
    "button_press": Sequence(
        name="button_press",
        description="Standard 5-button Pico press",
        steps=[
            SequenceStep(packet_type="BTN_SHORT_A", count=3, interval_ms=70),
            SequenceStep(packet_type="BTN_LONG_A", count=1, interval_ms=70),
        ],
    ),
    "button_release": Sequence(
        name="button_release",
        description="Button release (sent after press)",
        steps=[
            SequenceStep(packet_type="BTN_SHORT_B", count=3, interval_ms=70),
            SequenceStep(packet_type="BTN_LONG_B", count=1, interval_ms=70),
        ],
    ),
    "pairing_beacon": Sequence(
        name="pairing_beacon",
        description="Pairing beacon broadcast",
        steps=[
            SequenceStep(packet_type="BEACON_91", count=None, interval_ms=65),
        ],
    ),
    "pico_pairing": Sequence(
        name="pico_pairing",
        description="Pico pairing announcement",
        steps=[
            SequenceStep(packet_type="PAIR_B9", count=15, interval_ms=75),
        ],
    ),
    "set_level": Sequence(
        name="set_level",
        description="Set dimmer level",
        steps=[
            SequenceStep(packet_type="SET_LEVEL", count=20, interval_ms=60),
        ],
    ),
    "unpair": Sequence(
        name="unpair",
        description="Unpair device from bridge",
        steps=[
            SequenceStep(packet_type="UNPAIR", count=20, interval_ms=60),
        ],
    ),
}


def get_packet_type_name(type_code: int) -> str:
    """Get packet type name from type code."""
    info = PACKET_TYPE_INFO.get(type_code)
    return info.name if info else "UNKNOWN"


def get_packet_length(type_code: int) -> int:
    """Get expected packet length from type code."""
    info = PACKET_TYPE_INFO.get(type_code)
    return info.length if info else 0


def is_button_packet(type_code: int) -> bool:
    """Check if packet type is a button packet."""
    info = PACKET_TYPE_INFO.get(type_code)
    return info.category == "button" if info else False


def is_packet_category(type_code: int, category: str) -> bool:
    """Check if packet type belongs to a category."""
    info = PACKET_TYPE_INFO.get(type_code)
    return info.category == category if info else False


def next_sequence(seq: int) -> int:
    """Calculate next sequence number."""
    return (seq + SEQUENCE_INCREMENT) % SEQUENCE_WRAP


def resolve_packet_type(type_code: int) -> Optional[PacketType]:
    """Resolve a packet type code to its canonical PacketType."""
    try:
        return PacketType(type_code)
    except ValueError:
        return PACKET_TYPE_ALIASES.get(type_code)
