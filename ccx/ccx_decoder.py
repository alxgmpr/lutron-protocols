#!/usr/bin/env python3
"""
Lutron Clear Connect X (CCX) Protocol Decoder

CCX uses Thread (802.15.4) as transport with CBOR-encoded payloads on UDP port 9190.

Message Types:
    0     = Level Control (on/off, dimming)
    1     = Device Command (older format?)
    7     = Acknowledgment
    65535 = Presence/Broadcast announcement

Level Control (Type 0):
    [0, {
        0: {
            0: <level>,     # 0xFEFF = ON (100%), 0x0000 = OFF (0%)
            3: 1            # Command subtype
        },
        1: [<zone_type>, <zone_id>],  # e.g., [16, 961]
        5: <sequence>
    }]

Presence Broadcast (Type 65535):
    [65535, {
        4: 1,           # Device status?
        5: <sequence>
    }]
"""

import cbor2
from typing import Optional, Dict, Any, Tuple, List
from dataclasses import dataclass
from enum import IntEnum


class CCXMessageType(IntEnum):
    LEVEL_CONTROL = 0
    BUTTON_PRESS = 1      # Physical button/scene press
    ACK = 7
    STATUS = 41           # Thread/device status updates (0x29)
    PRESENCE = 65535


@dataclass
class CCXLevelCommand:
    """Level control command (on/off, dimming).

    Level values are LINEAR: level = percent * 655.35
      0% = 0x0000 (0)
     50% = 0x8000 (32768)
    100% = 0xFFFF (65535) or 0xFEFF (65279) for "full on"
    """
    level: int          # 0x0000 = OFF, 0xFEFF = ON/100%
    zone_type: int      # Usually 16
    zone_id: int        # Internal Lutron zone ID
    sequence: int

    # Level conversion constants
    LEVEL_MAX = 0xFFFF
    LEVEL_FULL_ON = 0xFEFF  # Lutron uses this for "turn on" vs "set to 100%"

    @property
    def level_percent(self) -> float:
        """Convert level to percentage (0-100)."""
        return (self.level / self.LEVEL_MAX) * 100

    @property
    def is_on(self) -> bool:
        return self.level > 0

    @property
    def is_full_on(self) -> bool:
        """Check if this is a 'full on' command (0xFEFF)."""
        return self.level == self.LEVEL_FULL_ON

    @staticmethod
    def percent_to_level(percent: float) -> int:
        """Convert percentage (0-100) to level value."""
        return int(percent * 655.35)

    @staticmethod
    def level_to_percent(level: int) -> float:
        """Convert level value to percentage."""
        return (level / 65535) * 100

    def __repr__(self) -> str:
        if self.level == 0:
            state = "OFF"
        elif self.is_full_on:
            state = "FULL_ON"
        else:
            state = f"{self.level_percent:.1f}%"
        return f"CCXLevelCommand({state}, level=0x{self.level:04x}, zone={self.zone_id}, seq={self.sequence})"


@dataclass
class CCXPresence:
    """Presence/broadcast announcement."""
    status: int
    sequence: int

    def __repr__(self) -> str:
        return f"CCXPresence(status={self.status}, seq={self.sequence})"


@dataclass
class CCXAck:
    """Acknowledgment message."""
    response: bytes
    sequence: int

    def __repr__(self) -> str:
        return f"CCXAck(response={self.response.hex()}, seq={self.sequence})"


@dataclass
class CCXButtonPress:
    """Physical button/scene press command.

    Triggered when a physical button is pressed on a Lutron device (keypad, dimmer).
    The device ID encodes the button/scene zone, and the device internally executes
    the associated scene or action.

    Device ID format: [cmd_type, zone_low, 0xEF, 0x20]
      - cmd_type: 0x03 for button press
      - zone_low: Low byte of button/scene zone ID
      - 0xEF, 0x20: Fixed suffix

    Counters are likely frame counters for replay protection.
    """
    device_id: bytes      # 4-byte device identifier
    counters: List[int]   # Frame counters [counter1, counter2, counter3]
    sequence: int

    @property
    def button_zone(self) -> int:
        """Extract button/scene zone from device ID."""
        if len(self.device_id) >= 2:
            return self.device_id[1]
        return 0

    @property
    def cmd_type(self) -> int:
        """Extract command type from device ID (0x03 = button)."""
        if len(self.device_id) >= 1:
            return self.device_id[0]
        return 0

    def __repr__(self) -> str:
        return f"CCXButtonPress(id={self.device_id.hex()}, zone={self.button_zone}, counters={self.counters}, seq={self.sequence})"


@dataclass
class CCXStatus:
    """Thread/device status update message (Type 41/0x29).

    These appear to be periodic status broadcasts from Thread devices.
    The payload contains device state information.
    """
    inner_data: bytes     # Raw status payload
    device_info: tuple    # [type, device_id] from key 2
    extra: dict           # Additional fields

    def __repr__(self) -> str:
        dev_type, dev_id = self.device_info if self.device_info else (0, 0)
        return f"CCXStatus(device={dev_id:08x}, data={self.inner_data.hex()[:32]}...)"


class CCXMessage:
    """Represents a decoded CCX message."""

    def __init__(self, raw_bytes: bytes):
        self.raw = raw_bytes
        self.decoded = cbor2.loads(raw_bytes)
        self.msg_type = self.decoded[0]
        self.body = self.decoded[1] if len(self.decoded) > 1 else {}

    @property
    def sequence(self) -> Optional[int]:
        return self.body.get(5)

    def parse(self):
        """Parse into specific message type."""
        if self.msg_type == CCXMessageType.LEVEL_CONTROL:
            return self._parse_level_control()
        elif self.msg_type == CCXMessageType.PRESENCE:
            return self._parse_presence()
        elif self.msg_type == CCXMessageType.ACK:
            return self._parse_ack()
        elif self.msg_type == CCXMessageType.BUTTON_PRESS:
            return self._parse_button_press()
        elif self.msg_type == CCXMessageType.STATUS:
            return self._parse_status()
        return self

    def _parse_level_control(self) -> CCXLevelCommand:
        inner = self.body.get(0, {})
        level = inner.get(0, 0)
        zone_info = self.body.get(1, [0, 0])
        return CCXLevelCommand(
            level=level,
            zone_type=zone_info[0] if len(zone_info) > 0 else 0,
            zone_id=zone_info[1] if len(zone_info) > 1 else 0,
            sequence=self.sequence or 0
        )

    def _parse_presence(self) -> CCXPresence:
        return CCXPresence(
            status=self.body.get(4, 0),
            sequence=self.sequence or 0
        )

    def _parse_ack(self) -> CCXAck:
        inner = self.body.get(0, {})
        response_inner = inner.get(1, {})
        response = response_inner.get(0, b'')
        return CCXAck(
            response=response if isinstance(response, bytes) else b'',
            sequence=self.sequence or 0
        )

    def _parse_button_press(self) -> CCXButtonPress:
        """Parse physical button/scene press (Type 1)."""
        inner = self.body.get(0, {})
        device_id = inner.get(0, b'')
        counters = inner.get(1, [])
        return CCXButtonPress(
            device_id=device_id if isinstance(device_id, bytes) else b'',
            counters=counters,
            sequence=self.sequence or 0
        )

    def _parse_status(self) -> CCXStatus:
        """Parse Thread/device status message (Type 41)."""
        inner = self.body.get(0, {})
        inner_data = inner.get(2, b'')
        device_info = tuple(self.body.get(2, [0, 0]))
        extra = {k: v for k, v in self.body.items() if k not in [0, 2, 5]}
        return CCXStatus(
            inner_data=inner_data if isinstance(inner_data, bytes) else b'',
            device_info=device_info,
            extra=extra
        )

    def __repr__(self) -> str:
        return f"CCXMessage(type={self.msg_type}, body={self.body})"


def decode_hex(hex_string: str) -> CCXMessage:
    """Decode a hex string into a CCX message."""
    hex_clean = hex_string.replace(' ', '').replace(':', '').replace(',', '')
    raw_bytes = bytes.fromhex(hex_clean)
    return CCXMessage(raw_bytes)


def decode_and_parse(hex_string: str):
    """Decode and parse into specific message type."""
    msg = decode_hex(hex_string)
    return msg.parse()


# Example usage
if __name__ == "__main__":
    print("=== CCX Protocol Decoder ===\n")

    # Level control examples (from on/off capture)
    level_examples = [
        ("ON command", "8200a300a20019feff03010182101903c105185c"),
        ("OFF command", "8200a300a2000003010182101903c105185d"),
    ]

    print("Level Control Messages:")
    print("-" * 50)
    for name, hex_data in level_examples:
        parsed = decode_and_parse(hex_data)
        print(f"{name}: {parsed}")
    print()

    # Button press example (from physical button capture - "Relax" scene)
    print("Button Press (Physical):")
    print("-" * 50)
    button_hex = "8201a200a2004403b3ef2001831a0003e1483a0002fe66192c88051882"
    parsed = decode_and_parse(button_hex)
    print(f"Relax button: {parsed}")
    print()

    # Presence broadcast
    print("Presence Broadcast:")
    print("-" * 50)
    presence_hex = "8219ffffa2040105185b"
    parsed = decode_and_parse(presence_hex)
    print(f"Presence: {parsed}")
    print()

    # ACK examples
    print("Acknowledgments:")
    print("-" * 50)
    ack_examples = [
        ("ACK (level)", "8207a200a101a10042015005184f"),
        ("ACK (button)", "8207a200a2000101a1004155051883"),
    ]
    for name, hex_data in ack_examples:
        parsed = decode_and_parse(hex_data)
        print(f"{name}: {parsed}")
    print()

    # Status message example (Type 41)
    print("Status Messages (Type 41):")
    print("-" * 50)
    status_hex = "821829a300a200000257a00094000200a00700c06910022c48fffffffff0ffefff0282011a06328c4403a101199e03"
    parsed = decode_and_parse(status_hex)
    print(f"Status: {parsed}")
