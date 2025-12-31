# Lutron CCA Packet Classes

from dataclasses import dataclass
from typing import Optional
from .constants import *
from .crc import calc_crc, verify_crc, append_crc


@dataclass
class LutronPacket:
    """Base class for Lutron CCA packets."""
    raw: bytes
    packet_type: int
    sequence: int
    device_id: int  # 32-bit device ID

    @classmethod
    def from_bytes(cls, data: bytes) -> Optional['LutronPacket']:
        """Parse a raw packet."""
        if len(data) < 24:
            return None

        packet_type = data[OFFSET_TYPE]
        sequence = data[OFFSET_SEQUENCE]

        # Device ID: bytes in packet are little-endian representation
        # Reading as little-endian gives us the value where device_id_str = big-endian hex
        device_id = int.from_bytes(data[OFFSET_DEVICE_ID:OFFSET_DEVICE_ID + 4], 'little')

        if packet_type == PACKET_TYPE_BUTTON_PRESS:
            return ButtonPress.from_bytes(data)

        return cls(raw=data, packet_type=packet_type,
                   sequence=sequence, device_id=device_id)

    @property
    def device_id_str(self) -> str:
        """Device ID as printed on Pico (hex string)."""
        # Convert back to the printed format (big-endian hex)
        b = self.device_id.to_bytes(4, 'big')
        return b.hex()

    @property
    def crc_valid(self) -> bool:
        """Check if packet CRC is valid."""
        return verify_crc(self.raw)

    @property
    def crc_value(self) -> int:
        """Get CRC value from packet."""
        return (self.raw[OFFSET_CRC] << 8) | self.raw[OFFSET_CRC + 1]

    def hex_dump(self) -> str:
        """Return hex dump of packet."""
        return ' '.join(f'{b:02X}' for b in self.raw)


@dataclass
class ButtonPress(LutronPacket):
    """Button press/release packet."""
    button: int
    action: int  # 0=press, 1=release

    @classmethod
    def from_bytes(cls, data: bytes) -> Optional['ButtonPress']:
        """Parse a button press packet."""
        if len(data) < 24:
            return None

        packet_type = data[OFFSET_TYPE]
        sequence = data[OFFSET_SEQUENCE]

        # Device ID: bytes in packet are little-endian representation
        device_id = int.from_bytes(data[OFFSET_DEVICE_ID:OFFSET_DEVICE_ID + 4], 'little')

        button = data[OFFSET_BUTTON]
        action = data[OFFSET_ACTION]

        return cls(raw=data, packet_type=packet_type, sequence=sequence,
                   device_id=device_id, button=button, action=action)

    @classmethod
    def create(cls, device_id: int, button: int, sequence: int = 0,
               action: int = ACTION_PRESS) -> 'ButtonPress':
        """
        Create a new button press packet.

        Args:
            device_id: 32-bit device ID (little-endian format as in packet)
            button: Button code
            sequence: Sequence number
            action: ACTION_PRESS or ACTION_RELEASE

        Returns:
            ButtonPress packet with valid CRC
        """
        payload = bytearray(22)

        payload[OFFSET_TYPE] = PACKET_TYPE_BUTTON_PRESS
        payload[OFFSET_SEQUENCE] = sequence & 0xFF

        # Device ID little-endian
        payload[OFFSET_DEVICE_ID] = device_id & 0xFF
        payload[OFFSET_DEVICE_ID + 1] = (device_id >> 8) & 0xFF
        payload[OFFSET_DEVICE_ID + 2] = (device_id >> 16) & 0xFF
        payload[OFFSET_DEVICE_ID + 3] = (device_id >> 24) & 0xFF

        # Unknown fields (observed values)
        payload[OFFSET_UNKNOWN1] = 0x21
        payload[OFFSET_UNKNOWN2] = 0x04
        payload[OFFSET_UNKNOWN3] = 0x03
        payload[OFFSET_UNKNOWN4] = 0x00

        payload[OFFSET_BUTTON] = button
        payload[OFFSET_ACTION] = action

        # Broadcast padding
        for i in range(OFFSET_PADDING, 22):
            payload[i] = PADDING_BYTE

        # Append CRC
        raw = append_crc(bytes(payload))

        return cls(raw=raw, packet_type=PACKET_TYPE_BUTTON_PRESS,
                   sequence=sequence, device_id=device_id,
                   button=button, action=action)

    @property
    def action_name(self) -> str:
        """Human-readable action name."""
        return 'release' if self.action == ACTION_RELEASE else 'press'

    @property
    def button_name(self) -> str:
        """Human-readable button name (best guess)."""
        names = {
            BUTTON_ON: 'On',
            BUTTON_RAISE: 'Raise',
            BUTTON_FAVORITE: 'Favorite',
            BUTTON_LOWER: 'Lower',
            BUTTON_OFF: 'Off',
            BUTTON_ON_ALT: 'On/Off (alt)',
            BUTTON_OFF_ALT: 'Off (alt)',
        }
        return names.get(self.button, f'Unknown ({self.button})')

    def __str__(self) -> str:
        crc_status = "OK" if self.crc_valid else "INVALID"
        return (f"ButtonPress(device={self.device_id_str}, button={self.button_name}, "
                f"action={self.action_name}, seq={self.sequence}, crc={crc_status})")


def parse_device_id(id_str: str) -> int:
    """
    Parse device ID string to integer for use in packet encoding.

    Args:
        id_str: Device ID as printed on Pico (e.g., "0595e68d")

    Returns:
        Device ID value that when stored little-endian gives correct packet bytes.

    Example:
        For device "0595e68d", we need packet bytes [8D, E6, 95, 05].
        parse_device_id("0595e68d") returns 0x0595E68D.
        Storing 0x0595E68D as little-endian gives [8D, E6, 95, 05]. Correct!
    """
    # The printed ID is the hex representation of the device ID
    # Interpret as big-endian so that little-endian storage reverses the bytes
    b = bytes.fromhex(id_str)
    return int.from_bytes(b, 'big')
