#!/usr/bin/env python3
"""
ESP32 Lutron RF Controller - CCA Playground

Controls the ESP32 CC1101 RF transmitter via ESPHome native API.
Provides a web dashboard for Lutron Clear Connect Type A protocol experimentation.

Usage:
    python esp32_controller.py serve --port 8080   # Start web dashboard
    python esp32_controller.py list                # List available buttons
    python esp32_controller.py press rf-on         # Press a button

Requirements:
    pip install aioesphomeapi flask

Connection:
    IP: 10.1.4.59
    Encryption key from YAML
"""

import asyncio
import argparse
import sys
import json
import time
import threading
import queue
import re
from typing import Optional, List, Dict
from datetime import datetime

try:
    import aioesphomeapi
    from aioesphomeapi import APIClient
except ImportError:
    print("Error: aioesphomeapi not installed")
    print("Run: pip install aioesphomeapi")
    sys.exit(1)

# Import database module
try:
    import database as db
except ImportError:
    # If running from different directory, try relative import
    import os
    sys.path.insert(0, os.path.dirname(__file__))
    import database as db

# ESP32 connection settings (defaults)
ESP32_IP = "10.1.4.59"
ESP32_PORT = 6053
ESP32_PASSWORD = ""
ESP32_ENCRYPTION_KEY = "EixuPCx/wLtc5a55a/16gNEubH7qiZWFhn7LR98qQU8="

# Current ESP32 host (can be changed at runtime)
current_esp_host = ESP32_IP
esp_config_lock = threading.Lock()

# Button ID mappings
BUTTONS = {
    "rf-on": "rf_on__pico_",
    "rf-off": "rf_off__pico_",
    "rf-raise": "rf_raise__pico_",
    "rf-lower": "rf_lower__pico_",
    "rf-favorite": "rf_favorite__pico_",
    "pair-pico": "pair_pico-style__bb_",
    "beacon": "beacon__pairing_mode_",
}

# Global log queue for SSE streaming
log_queue = queue.Queue(maxsize=1000)
rx_queue = queue.Queue(maxsize=500)
packet_queue = queue.Queue(maxsize=500)  # Parsed packets for SSE
log_subscription_started = False
log_subscription_lock = threading.Lock()
log_thread_heartbeat = 0  # Timestamp of last heartbeat from log thread
log_last_received = 0  # Timestamp of last actual log received from ESP32
LOG_THREAD_TIMEOUT = 30  # Consider thread dead if no heartbeat for this many seconds
LOG_STALE_TIMEOUT = 60  # Consider connection stale if no logs for this long

# Device database - now uses SQLite via database module
import os

def extract_link_id(device_id: str) -> str:
    """Extract the 16-bit link ID from a 32-bit device ID.

    The link ID is the middle 16 bits (bits 8-23) of the device ID.
    For example:
      - 0x002C90AF -> link ID = 0x2C90
      - 0x002C90AD -> link ID = 0x2C90
      - 0xAA2C90AE -> link ID = 0x2C90

    Devices with the same link ID are part of the same zone/group.
    """
    try:
        if device_id.startswith('0x') or device_id.startswith('0X'):
            dev_int = int(device_id, 16)
        else:
            dev_int = int(device_id, 16) if len(device_id) == 8 else int(device_id)
        # Extract bits 8-23 (middle 16 bits)
        link_id = (dev_int >> 8) & 0xFFFF
        return f"{link_id:04X}"
    except:
        return "UNKNOWN"

def register_device(device_id: str, device_type: str, info: Dict):
    """Register or update a device in the database."""
    # Map old device_type to category
    category = info.get('category', device_type)
    return db.upsert_device(
        device_id=device_id,
        category=category,
        bridge_id=info.get('bridge_id'),
        factory_id=info.get('factory_id'),
        info=info
    )


# Regex patterns for parsing ESP32 logs (JSON format)
# New format: RX: {"bytes":"83 01 AF...","rssi":-43,"len":24,"crc_ok":true}
# New format: TX: {"bytes":"81 00 01...","len":24}
RX_JSON_PATTERN = re.compile(r'RX:\s*\{"bytes":"([^"]+)","rssi":(-?\d+),"len":(\d+)(?:,"crc_ok":(true|false))?\}')
TX_JSON_PATTERN = re.compile(r'TX:\s*\{"bytes":"([^"]+)","len":(\d+)\}')

# Legacy patterns (for backwards compatibility during transition)
RX_PATTERN = re.compile(r'RX:\s+(\S+)\s+\|\s*(.+)')
TX_PATTERN = re.compile(r'TX\s+(\d+)\s+bytes:\s*([A-F0-9]{2}(?:\s+[A-F0-9]{2})+)', re.IGNORECASE)
BYTES_PATTERN = re.compile(r'Bytes:\s*([A-F0-9]{2}(?:\s+[A-F0-9]{2})+)', re.IGNORECASE)
RSSI_PATTERN = re.compile(r'RSSI=(-?\d+)')

# Packet type mappings (first byte -> type name)
PACKET_TYPE_MAP = {
    0x80: 'STATE_RPT', 0x81: 'STATE_RPT', 0x82: 'STATE_RPT', 0x83: 'STATE_RPT',
    0x88: 'BTN_SHORT_A', 0x89: 'BTN_LONG_A', 0x8A: 'BTN_SHORT_B', 0x8B: 'BTN_LONG_B',
    0x91: 'BEACON', 0x92: 'BEACON', 0x93: 'BEACON',
    0xA2: 'SET_LEVEL',
    0xB0: 'PAIR_B0', 0xB8: 'PAIR_B8', 0xB9: 'PAIR_B9', 0xBA: 'PAIR_BA', 0xBB: 'PAIR_BB',
    0xC0: 'PAIR_RESP', 0xC1: 'PAIR_RESP', 0xC2: 'PAIR_RESP', 0xC8: 'PAIR_RESP',
}

# Button names
BUTTON_NAMES = {
    0x02: 'ON', 0x03: 'FAV', 0x04: 'OFF', 0x05: 'RAISE', 0x06: 'LOWER',
    0x08: 'SCENE1', 0x09: 'SCENE2', 0x0A: 'SCENE3', 0x0B: 'SCENE4',
}

# Action names
ACTION_NAMES = {
    0x00: 'PRESS', 0x01: 'RELEASE', 0x03: 'SAVE'
}

# ============================================================================
# PACKET FIELD DEFINITIONS
# Each field has: name, start, end (exclusive), format
# Formats: hex, decimal, device_id (LE), device_id_be (BE), level_byte, level_16bit, button, action
# ============================================================================

FIELD_DEFS = {
    # STATE_RPT: Dimmer broadcasting its current level (format byte 0x08)
    'STATE_RPT': [
        {'name': 'Type', 'start': 0, 'end': 1, 'format': 'hex'},
        {'name': 'Sequence', 'start': 1, 'end': 2, 'format': 'decimal'},
        {'name': 'Device ID', 'start': 2, 'end': 6, 'format': 'device_id'},
        {'name': 'Format', 'start': 6, 'end': 8, 'format': 'hex'},
        {'name': 'Fixed', 'start': 8, 'end': 11, 'format': 'hex'},
        {'name': 'Level', 'start': 11, 'end': 12, 'format': 'level_byte'},
        {'name': 'Fixed', 'start': 12, 'end': 16, 'format': 'hex'},
        {'name': 'Padding', 'start': 16, 'end': 22, 'format': 'hex'},
        {'name': 'CRC', 'start': 22, 'end': 24, 'format': 'hex'},
    ],
    # DIMMER_ACK: Dimmer acknowledgment during button handling
    'DIMMER_ACK': [
        {'name': 'Type', 'start': 0, 'end': 1, 'format': 'hex'},
        {'name': 'Sequence', 'start': 1, 'end': 2, 'format': 'decimal'},
        {'name': 'Device ID', 'start': 2, 'end': 6, 'format': 'device_id'},
        {'name': 'Format', 'start': 6, 'end': 8, 'format': 'hex'},
        {'name': 'Payload', 'start': 8, 'end': 22, 'format': 'hex'},
        {'name': 'CRC', 'start': 22, 'end': 24, 'format': 'hex'},
    ],
    # SET_LEVEL: Bridge sending level command to dimmer (format byte 0x0E)
    'SET_LEVEL': [
        {'name': 'Type', 'start': 0, 'end': 1, 'format': 'hex'},
        {'name': 'Sequence', 'start': 1, 'end': 2, 'format': 'decimal'},
        {'name': 'Source ID', 'start': 2, 'end': 6, 'format': 'device_id'},
        {'name': 'Format', 'start': 6, 'end': 8, 'format': 'hex'},
        {'name': 'Fixed', 'start': 8, 'end': 9, 'format': 'hex'},
        {'name': 'Target ID', 'start': 9, 'end': 13, 'format': 'device_id_be'},
        {'name': 'Fixed', 'start': 13, 'end': 16, 'format': 'hex'},
        {'name': 'Level', 'start': 16, 'end': 18, 'format': 'level_16bit'},
        {'name': 'Trailer', 'start': 18, 'end': 22, 'format': 'hex'},
        {'name': 'CRC', 'start': 22, 'end': 24, 'format': 'hex'},
    ],
    # UNPAIR: Bridge removing a device from the network (format byte 0x0C)
    'UNPAIR': [
        {'name': 'Type', 'start': 0, 'end': 1, 'format': 'hex'},
        {'name': 'Sequence', 'start': 1, 'end': 2, 'format': 'decimal'},
        {'name': 'Bridge Zone', 'start': 2, 'end': 6, 'format': 'device_id'},
        {'name': 'Protocol', 'start': 6, 'end': 7, 'format': 'hex'},
        {'name': 'Format', 'start': 7, 'end': 8, 'format': 'hex'},
        {'name': 'Fixed', 'start': 8, 'end': 9, 'format': 'hex'},
        {'name': 'Broadcast', 'start': 9, 'end': 14, 'format': 'hex'},
        {'name': 'Command', 'start': 14, 'end': 16, 'format': 'hex'},
        {'name': 'Target ID', 'start': 16, 'end': 20, 'format': 'device_id_be'},
        {'name': 'Padding', 'start': 20, 'end': 22, 'format': 'hex'},
        {'name': 'CRC', 'start': 22, 'end': 24, 'format': 'hex'},
    ],
    # UNPAIR_PREP: Unpair prepare phase (format byte 0x09)
    'UNPAIR_PREP': [
        {'name': 'Type', 'start': 0, 'end': 1, 'format': 'hex'},
        {'name': 'Sequence', 'start': 1, 'end': 2, 'format': 'decimal'},
        {'name': 'Bridge Zone', 'start': 2, 'end': 6, 'format': 'device_id'},
        {'name': 'Protocol', 'start': 6, 'end': 7, 'format': 'hex'},
        {'name': 'Format', 'start': 7, 'end': 8, 'format': 'hex'},
        {'name': 'Fixed', 'start': 8, 'end': 9, 'format': 'hex'},
        {'name': 'Target ID', 'start': 9, 'end': 13, 'format': 'device_id_be'},
        {'name': 'Marker', 'start': 13, 'end': 14, 'format': 'hex'},
        {'name': 'Command', 'start': 14, 'end': 16, 'format': 'hex'},
        {'name': 'Payload', 'start': 16, 'end': 22, 'format': 'hex'},
        {'name': 'CRC', 'start': 22, 'end': 24, 'format': 'hex'},
    ],
    # BTN_*: Button press packets
    'BTN': [
        {'name': 'Type', 'start': 0, 'end': 1, 'format': 'hex'},
        {'name': 'Sequence', 'start': 1, 'end': 2, 'format': 'decimal'},
        {'name': 'Device ID', 'start': 2, 'end': 6, 'format': 'device_id_be'},
        {'name': 'Protocol', 'start': 6, 'end': 8, 'format': 'hex'},
        {'name': 'Fixed', 'start': 8, 'end': 10, 'format': 'hex'},
        {'name': 'Button', 'start': 10, 'end': 11, 'format': 'button'},
        {'name': 'Action', 'start': 11, 'end': 12, 'format': 'action'},
        {'name': 'Payload', 'start': 12, 'end': 22, 'format': 'hex'},
        {'name': 'CRC', 'start': 22, 'end': 24, 'format': 'hex'},
    ],
    # BEACON: Bridge pairing beacon
    'BEACON': [
        {'name': 'Type', 'start': 0, 'end': 1, 'format': 'hex'},
        {'name': 'Sequence', 'start': 1, 'end': 2, 'format': 'decimal'},
        {'name': 'Load ID', 'start': 2, 'end': 6, 'format': 'device_id_be'},
        {'name': 'Format', 'start': 6, 'end': 8, 'format': 'hex'},
        {'name': 'Fixed', 'start': 8, 'end': 9, 'format': 'hex'},
        {'name': 'Broadcast', 'start': 9, 'end': 14, 'format': 'hex'},
        {'name': 'Fixed', 'start': 14, 'end': 20, 'format': 'hex'},
        {'name': 'Padding', 'start': 20, 'end': 22, 'format': 'hex'},
        {'name': 'CRC', 'start': 22, 'end': 24, 'format': 'hex'},
    ],
    # PAIR_B*: Pico pairing packets (53 bytes)
    'PAIR': [
        {'name': 'Type', 'start': 0, 'end': 1, 'format': 'hex'},
        {'name': 'Sequence', 'start': 1, 'end': 2, 'format': 'decimal'},
        {'name': 'Device ID', 'start': 2, 'end': 6, 'format': 'device_id_be'},
        {'name': 'Format', 'start': 6, 'end': 8, 'format': 'hex'},
        {'name': 'Fixed', 'start': 8, 'end': 10, 'format': 'hex'},
        {'name': 'Btn Scheme', 'start': 10, 'end': 11, 'format': 'hex'},
        {'name': 'Fixed', 'start': 11, 'end': 13, 'format': 'hex'},
        {'name': 'Broadcast', 'start': 13, 'end': 18, 'format': 'hex'},
        {'name': 'Fixed', 'start': 18, 'end': 20, 'format': 'hex'},
        {'name': 'Device ID 2', 'start': 20, 'end': 24, 'format': 'device_id_be'},
        {'name': 'Device ID 3', 'start': 24, 'end': 28, 'format': 'device_id_be'},
        {'name': 'Capabilities', 'start': 28, 'end': 41, 'format': 'hex'},
        {'name': 'Broadcast 2', 'start': 41, 'end': 45, 'format': 'hex'},
        {'name': 'Padding', 'start': 45, 'end': 51, 'format': 'hex'},
        {'name': 'CRC', 'start': 51, 'end': 53, 'format': 'hex'},
    ],
    # PAIR_RESP: Pairing response
    'PAIR_RESP': [
        {'name': 'Type', 'start': 0, 'end': 1, 'format': 'hex'},
        {'name': 'Sequence', 'start': 1, 'end': 2, 'format': 'decimal'},
        {'name': 'Device ID', 'start': 2, 'end': 6, 'format': 'device_id_be'},
        {'name': 'Payload', 'start': 6, 'end': 22, 'format': 'hex'},
        {'name': 'CRC', 'start': 22, 'end': 24, 'format': 'hex'},
    ],
    # Generic fallback for unknown packets
    'UNKNOWN': [
        {'name': 'Type', 'start': 0, 'end': 1, 'format': 'hex'},
        {'name': 'Sequence', 'start': 1, 'end': 2, 'format': 'decimal'},
        {'name': 'Payload', 'start': 2, 'end': 22, 'format': 'hex'},
        {'name': 'CRC', 'start': 22, 'end': 24, 'format': 'hex'},
    ],
}


def _format_field_value(bytes_list: List[str], field: Dict) -> Dict:
    """Format a single field value from raw packet bytes.

    Returns dict with: name, start, end, raw, decoded (or None)
    """
    start = field['start']
    end = min(field['end'], len(bytes_list))
    field_bytes = bytes_list[start:end]
    raw = ' '.join(field_bytes)

    if not field_bytes:
        return {
            'name': field['name'],
            'start': start,
            'end': end,
            'raw': '-',
            'decoded': None
        }

    fmt = field.get('format', 'hex')
    decoded = None

    if fmt == 'device_id' and len(field_bytes) >= 4:
        # Little-endian device ID
        decoded = f"{field_bytes[3]}{field_bytes[2]}{field_bytes[1]}{field_bytes[0]}".upper()
    elif fmt == 'device_id_be' and len(field_bytes) >= 4:
        # Big-endian device ID
        decoded = f"{field_bytes[0]}{field_bytes[1]}{field_bytes[2]}{field_bytes[3]}".upper()
    elif fmt == 'level_16bit' and len(field_bytes) >= 2:
        # 16-bit level (0x0000-0xFEFF = 0-100%)
        level_raw = int(field_bytes[0] + field_bytes[1], 16)
        level = 0 if level_raw == 0 else round((level_raw * 100) / 65279)
        decoded = f"{level}%"
    elif fmt == 'level_byte' and len(field_bytes) >= 1:
        # Single byte level (0x00-0xFE = 0-100%)
        level_byte = int(field_bytes[0], 16)
        level = 0 if level_byte == 0 else round((level_byte * 100) / 254)
        decoded = f"{level}%"
    elif fmt == 'button' and len(field_bytes) >= 1:
        btn_code = int(field_bytes[0], 16)
        decoded = BUTTON_NAMES.get(btn_code, f"0x{btn_code:02X}")
    elif fmt == 'action' and len(field_bytes) >= 1:
        action_code = int(field_bytes[0], 16)
        decoded = ACTION_NAMES.get(action_code, f"0x{action_code:02X}")
    elif fmt == 'decimal' and len(field_bytes) >= 1:
        decoded = str(int(field_bytes[0], 16))
    # hex format: decoded stays None, just show raw

    return {
        'name': field['name'],
        'start': start,
        'end': end,
        'raw': raw,
        'decoded': decoded
    }


def _get_field_defs_for_type(packet_type: str) -> List[Dict]:
    """Get field definitions for a packet type."""
    if packet_type.startswith('BTN_'):
        return FIELD_DEFS['BTN']
    elif packet_type.startswith('PAIR_B'):
        return FIELD_DEFS['PAIR']
    elif packet_type.startswith('BRIDGE_'):
        return FIELD_DEFS['UNKNOWN']
    return FIELD_DEFS.get(packet_type, FIELD_DEFS['UNKNOWN'])


def parse_packet_fields(bytes_list: List[str], packet_type: str) -> List[Dict]:
    """Parse all fields from packet bytes based on packet type.

    Returns list of field dicts: [{name, start, end, raw, decoded}, ...]
    """
    field_defs = _get_field_defs_for_type(packet_type)
    return [_format_field_value(bytes_list, f) for f in field_defs if f['start'] < len(bytes_list)]


def parse_packet_bytes(bytes_list: List[str]) -> Dict:
    """Parse raw packet bytes and extract structured data.

    This is the main packet parsing logic, moved from ESP32 to backend.
    Handles all packet types: STATE_RPT, LEVEL, BTN_*, BEACON, PAIR_*, etc.

    Args:
        bytes_list: List of hex byte strings like ['83', '01', 'AF', ...]

    Returns:
        Dict with parsed fields: packet_type, device_id, source_id, target_id,
        level, button, sequence, decoded_data, etc.
    """
    if len(bytes_list) < 6:
        return {'packet_type': 'UNKNOWN', 'error': 'too_short'}

    # First byte is packet type
    type_byte = int(bytes_list[0], 16)
    packet_type = PACKET_TYPE_MAP.get(type_byte, 'UNKNOWN')
    sequence = int(bytes_list[1], 16) if len(bytes_list) > 1 else 0

    result = {
        'packet_type': packet_type,
        'type_byte': f'0x{type_byte:02X}',
        'sequence': sequence,
        'device_id': None,
        'source_id': None,
        'target_id': None,
        'level': None,
        'button': None,
        'decoded_data': {}
    }

    # STATE_RPT/LEVEL: 0x80-0x83 packets - check format byte at [7] to distinguish
    if type_byte in (0x80, 0x81, 0x82, 0x83):
        # Device ID at [2-5] is little-endian (subnet format)
        if len(bytes_list) >= 6:
            device_id = f"{bytes_list[5]}{bytes_list[4]}{bytes_list[3]}{bytes_list[2]}".upper()
            result['device_id'] = device_id
            result['source_id'] = device_id

        # Check format byte at [7]
        format_byte = int(bytes_list[7], 16) if len(bytes_list) > 7 else 0

        if format_byte == 0x0E and len(bytes_list) >= 18:
            # LEVEL command (bridge -> dimmer)
            result['packet_type'] = 'SET_LEVEL'
            # Target ID at [9-12] is big-endian
            target_id = f"{bytes_list[9]}{bytes_list[10]}{bytes_list[11]}{bytes_list[12]}".upper()
            result['target_id'] = target_id
            result['device_id'] = target_id  # Primary device is target
            # Level at [16-17] is 16-bit big-endian (0x0000-0xFEFF = 0-100%)
            level_raw = int(bytes_list[16] + bytes_list[17], 16)
            result['level'] = 0 if level_raw == 0 else round((level_raw * 100) / 65279)
            result['decoded_data']['level'] = str(result['level'])
            result['decoded_data']['source'] = result['source_id']
            result['decoded_data']['target'] = target_id
        elif format_byte == 0x0C and len(bytes_list) >= 20:
            # UNPAIR command (format 0x0C with cmd 02 08)
            result['packet_type'] = 'UNPAIR'
            # Target ID at [16-19] is big-endian
            target_id = f"{bytes_list[16]}{bytes_list[17]}{bytes_list[18]}{bytes_list[19]}".upper()
            result['target_id'] = target_id
            result['device_id'] = target_id
            result['decoded_data']['bridge'] = result['source_id']
            result['decoded_data']['target'] = target_id
        elif format_byte == 0x09 and len(bytes_list) >= 16:
            # Format 0x09 can be UNPAIR_PREP or DIMMER_ACK
            # UNPAIR_PREP has: byte[13]=0xFE and bytes[14:16]=0x02 0x02
            is_unpair_prep = (len(bytes_list) >= 16 and
                              bytes_list[13].upper() == 'FE' and
                              bytes_list[14].upper() == '02' and
                              bytes_list[15].upper() == '02')
            if is_unpair_prep:
                result['packet_type'] = 'UNPAIR_PREP'
                target_id = f"{bytes_list[9]}{bytes_list[10]}{bytes_list[11]}{bytes_list[12]}".upper()
                result['target_id'] = target_id
            else:
                # This is a dimmer acknowledgment/response, not an unpair command
                result['packet_type'] = 'DIMMER_ACK'
        elif format_byte == 0x0B:
            # Format 0x0B: Dimmer response during button press handling
            result['packet_type'] = 'DIMMER_ACK'
        elif format_byte == 0x08:
            # STATE_RPT (dimmer reporting level)
            result['packet_type'] = 'STATE_RPT'
            if len(bytes_list) >= 12:
                level_byte = int(bytes_list[11], 16)
                result['level'] = 0 if level_byte == 0 else round((level_byte * 100) / 254)
                result['decoded_data']['level'] = str(result['level'])
        else:
            # Unknown format byte - mark as unclassified rather than assuming STATE_RPT
            result['packet_type'] = f'BRIDGE_0x{format_byte:02X}'

    # Button packets: 0x88-0x8B
    elif type_byte in (0x88, 0x89, 0x8A, 0x8B):
        # Device ID at [2-5] - big-endian (matches label on Pico)
        if len(bytes_list) >= 6:
            device_id = f"{bytes_list[2]}{bytes_list[3]}{bytes_list[4]}{bytes_list[5]}".upper()
            result['device_id'] = device_id
        # Button at [10], Action at [11]
        if len(bytes_list) >= 12:
            btn_code = int(bytes_list[10], 16)
            action_code = int(bytes_list[11], 16)
            btn_name = BUTTON_NAMES.get(btn_code, f'0x{btn_code:02X}')
            result['button'] = btn_name
            result['decoded_data']['button'] = btn_name
            result['decoded_data']['action'] = 'RELEASE' if action_code == 1 else 'PRESS'

    # Beacon packets: 0x91-0x93
    elif type_byte in (0x91, 0x92, 0x93):
        # Device/Zone ID at [2-5] - big-endian
        if len(bytes_list) >= 6:
            device_id = f"{bytes_list[2]}{bytes_list[3]}{bytes_list[4]}{bytes_list[5]}".upper()
            result['device_id'] = device_id

    # Pairing packets: 0xB0, 0xB8-0xBB
    elif type_byte in (0xB0, 0xB8, 0xB9, 0xBA, 0xBB):
        # Device ID at [2-5] - big-endian
        if len(bytes_list) >= 6:
            device_id = f"{bytes_list[2]}{bytes_list[3]}{bytes_list[4]}{bytes_list[5]}".upper()
            result['device_id'] = device_id
            result['decoded_data']['seq'] = str(sequence)

    # Pairing response packets: 0xC0-0xCF
    elif 0xC0 <= type_byte <= 0xCF:
        result['packet_type'] = 'PAIR_RESP'
        if len(bytes_list) >= 6:
            device_id = f"{bytes_list[2]}{bytes_list[3]}{bytes_list[4]}{bytes_list[5]}".upper()
            result['device_id'] = device_id

    return result


# Echo detection - track recent TX device IDs to filter from RX
# Key: device_id (uppercase), Value: timestamp
ECHO_WINDOW_MS = 200  # Filter RX packets from same device within this window
recent_tx_devices: Dict[str, float] = {}
recent_tx_lock = threading.Lock()

# Pending RX packet - waiting for Bytes line
pending_rx_packet: Dict = None
pending_rx_lock = threading.Lock()

def _register_tx_device(device_id: str):
    """Register a TX device ID for echo detection."""
    if not device_id:
        return
    normalized = device_id.upper()
    now = time.time()
    with recent_tx_lock:
        recent_tx_devices[normalized] = now
        # Cleanup old entries (older than 2 seconds)
        cutoff = now - 2.0
        to_remove = [k for k, v in recent_tx_devices.items() if v < cutoff]
        for k in to_remove:
            del recent_tx_devices[k]

def _is_echo_from_device(device_id: str) -> bool:
    """Check if RX packet is an echo based on device ID."""
    if not device_id:
        return False
    normalized = device_id.upper()
    now = time.time()
    with recent_tx_lock:
        if normalized in recent_tx_devices:
            tx_time = recent_tx_devices[normalized]
            if (now - tx_time) * 1000 < ECHO_WINDOW_MS:
                return True
    return False

def _store_rx_packet(pkt_data: Dict, raw_hex: str = None):
    """Store RX packet in database and queue, with echo filtering."""
    # Skip UNKNOWN packet types - not useful for display
    packet_type = pkt_data.get('packet_type', 'UNKNOWN')
    if packet_type == 'UNKNOWN':
        return

    # Check for echo BEFORE storing - filter by device_id
    device_id = pkt_data.get('device_id')
    if _is_echo_from_device(device_id):
        return  # Skip echo packets - we recently TX'd as this device

    pkt_data['raw_hex'] = raw_hex

    # Parse field breakdown from raw bytes
    bytes_list = raw_hex.split() if raw_hex else []
    parsed_fields = parse_packet_fields(bytes_list, packet_type) if bytes_list else []

    # Calculate subnet and id_format BEFORE storing/streaming
    # This ensures the packet queue gets the correct data
    decoded_data = pkt_data.get('decoded_data', {})
    if device_id and re.match(r'^[0-9A-Fa-f]{8}$', device_id):
        # Determine ID format based on packet type:
        # - STATE_RPT/LEVEL: little-endian, contains subnet
        # - BTN_*/PAIRING: big-endian, matches printed label
        id_format = 'subnet' if packet_type in ('STATE_RPT', 'LEVEL') else 'label'
        decoded_data['id_format'] = id_format
        decoded_data['packet_type'] = packet_type

        # Extract subnet from the appropriate ID:
        # - For LEVEL packets: extract from source_id (bridge), not target (device)
        # - For STATE_RPT: extract from device_id (the dimmer reporting)
        # Device ID format: [Zone][SubnetLo][SubnetHi][Endpoint]
        # Subnet displayed big-endian (as in Lutron Designer): SubnetHi + SubnetLo
        source_id = pkt_data.get('source_id')
        subnet_source = source_id if packet_type == 'LEVEL' else device_id
        if id_format == 'subnet' and subnet_source and len(subnet_source) == 8:
            subnet_lo = subnet_source[2:4]  # bytes 1
            subnet_hi = subnet_source[4:6]  # bytes 2
            subnet = (subnet_hi + subnet_lo).upper()  # Big-endian for display
            decoded_data['subnet'] = subnet

    # Store in database
    db.insert_decoded_packet(
        direction='rx',
        packet_type=packet_type,
        timestamp=pkt_data.get('timestamp', datetime.now().isoformat()),
        raw_hex=raw_hex,
        device_id=device_id,
        source_id=pkt_data.get('source_id'),
        target_id=pkt_data.get('target_id'),
        level=pkt_data.get('level'),
        button=pkt_data.get('button'),
        rssi=pkt_data.get('rssi'),
        decoded_data=decoded_data
    )

    # Push to packet queue for SSE streaming (with subnet already calculated)
    try:
        timestamp = pkt_data.get('timestamp', '')
        packet_queue.put_nowait({
            'direction': 'rx',
            'type': packet_type,
            'time': timestamp.split('T')[1].split('.')[0] if 'T' in timestamp else timestamp[-8:],
            'device_id': device_id,
            'source_id': pkt_data.get('source_id'),
            'target_id': pkt_data.get('target_id'),
            'summary': f"{pkt_data.get('source_id')} -> {pkt_data.get('target_id')}" if pkt_data.get('source_id') and pkt_data.get('target_id') else device_id or '',
            'details': decoded_data,
            'fields': parsed_fields,  # Full field breakdown for frontend display
            'raw_hex': raw_hex,
            'rssi': pkt_data.get('rssi')
        })
    except queue.Full:
        pass

    # Update device registry
    if device_id and re.match(r'^[0-9A-Fa-f]{8}$', device_id):
        category = _infer_category_from_type(packet_type, pkt_data.get('button'))
        db.upsert_device(
            device_id=device_id,
            category=category,
            bridge_id=pkt_data.get('source_id') if packet_type == 'LEVEL' else None,
            factory_id=pkt_data.get('target_id') if packet_type == 'LEVEL' else device_id,
            info=decoded_data
        )

def _parse_and_store_packet(message: str):
    """Parse a log message and store any packets in the database.

    New JSON format:
      RX: {"bytes":"83 01 AF...","rssi":-43,"len":24}
      TX: {"bytes":"81 00 01...","len":24}

    Legacy format (for backwards compatibility):
      RX: TYPE | DEVICE_ID | ... | RSSI=X | CRC=ok
        Bytes: XX XX XX ...
      TX N bytes: XX XX XX ...
    """
    global pending_rx_packet
    try:
        timestamp = datetime.now().isoformat()

        # ========== New JSON format ==========

        # Parse RX JSON: RX: {"bytes":"83 01 AF...","rssi":-43,"len":24,"crc_ok":true}
        rx_json_match = RX_JSON_PATTERN.search(message)
        if rx_json_match:
            raw_hex = rx_json_match.group(1)
            rssi = int(rx_json_match.group(2))
            # pkt_len = int(rx_json_match.group(3))
            crc_ok_str = rx_json_match.group(4)  # May be None for old format
            crc_ok = crc_ok_str != 'false' if crc_ok_str else True  # Default to true for backwards compat

            # Parse packet from raw bytes
            bytes_list = raw_hex.split()
            parsed = parse_packet_bytes(bytes_list)

            # Include CRC status in decoded data
            decoded_data = parsed['decoded_data']
            decoded_data['crc_ok'] = crc_ok

            pkt_data = {
                'packet_type': parsed['packet_type'],
                'timestamp': timestamp,
                'device_id': parsed['device_id'],
                'source_id': parsed['source_id'],
                'target_id': parsed['target_id'],
                'level': parsed['level'],
                'button': parsed['button'],
                'rssi': rssi,
                'decoded_data': decoded_data
            }

            _store_rx_packet(pkt_data, raw_hex)
            return

        # Parse TX JSON: TX: {"bytes":"81 00 01...","len":24}
        tx_json_match = TX_JSON_PATTERN.search(message)
        if tx_json_match:
            raw_hex = tx_json_match.group(1)
            # pkt_len = int(tx_json_match.group(2))

            # Parse packet from raw bytes
            bytes_list = raw_hex.split()
            parsed = parse_packet_bytes(bytes_list)

            # Register device for echo detection
            if parsed['device_id']:
                _register_tx_device(parsed['device_id'])
            if parsed['source_id'] and parsed['source_id'] != parsed['device_id']:
                _register_tx_device(parsed['source_id'])

            db.insert_decoded_packet(
                direction='tx',
                packet_type=parsed['packet_type'],
                timestamp=timestamp,
                raw_hex=raw_hex,
                device_id=parsed['device_id'],
                source_id=parsed['source_id'],
                target_id=parsed['target_id'],
                level=parsed['level'],
                decoded_data=parsed['decoded_data']
            )

            # Parse fields for TX packets
            tx_fields = parse_packet_fields(bytes_list, parsed['packet_type'])

            # Push to packet queue for SSE streaming
            try:
                packet_queue.put_nowait({
                    'direction': 'tx',
                    'type': parsed['packet_type'],
                    'time': timestamp.split('T')[1].split('.')[0] if 'T' in timestamp else timestamp[-8:],
                    'device_id': parsed['device_id'],
                    'source_id': parsed['source_id'],
                    'target_id': parsed['target_id'],
                    'summary': f"{parsed['source_id']} -> {parsed['target_id']}" if parsed['source_id'] and parsed['target_id'] else parsed['device_id'] or '',
                    'details': parsed['decoded_data'],
                    'fields': tx_fields,  # Backend-parsed field breakdown
                    'raw_hex': raw_hex,
                    'rssi': None
                })
            except queue.Full:
                pass
            return

        # ========== Legacy format (backwards compatibility) ==========

        # Check for Bytes line (follows RX line)
        bytes_match = BYTES_PATTERN.search(message)
        if bytes_match and '  Bytes:' in message:  # Indented = follows RX
            raw_hex = bytes_match.group(1)
            with pending_rx_lock:
                if pending_rx_packet:
                    # Complete pending RX with bytes and store
                    _store_rx_packet(pending_rx_packet, raw_hex)
                    pending_rx_packet = None
            return

        # Parse legacy RX packets: "RX: LEVEL | AF902C00 -> 002C90AF | Level=50%"
        rx_match = RX_PATTERN.search(message)
        if rx_match:
            pkt_type = rx_match.group(1)
            rest = rx_match.group(2)
            parts = [p.strip() for p in rest.split('|')]

            # Extract device ID from first part
            device_id = None
            source_id = None
            target_id = None
            level = None
            button = None

            if parts:
                summary = parts[0]
                # Check for "source -> target" format
                if '->' in summary:
                    ids = [s.strip() for s in summary.split('->')]
                    if len(ids) >= 2:
                        source_id = ids[0]
                        target_id = ids[1]
                        device_id = target_id  # Primary device is target
                else:
                    # Single device ID
                    device_id = summary if re.match(r'^[0-9A-Fa-f]{8}$', summary) else None

            # Parse additional details
            decoded_data = {}
            for part in parts[1:]:
                if '=' in part:
                    key, val = part.split('=', 1)
                    key = key.strip().lower()
                    val = val.strip().rstrip('%')
                    decoded_data[key] = val
                    if key == 'level':
                        try:
                            level = int(val)
                        except ValueError:
                            pass
                elif re.match(r'^(ON|OFF|RAISE|LOWER|FAV|SCENE)', part):
                    button = part.strip()
                    decoded_data['button'] = button

            # Extract RSSI
            rssi_match = RSSI_PATTERN.search(message)
            rssi = int(rssi_match.group(1)) if rssi_match else None

            # Store as pending - wait for Bytes line
            with pending_rx_lock:
                # If there's an old pending packet, store it without bytes
                if pending_rx_packet:
                    _store_rx_packet(pending_rx_packet, None)

                pending_rx_packet = {
                    'packet_type': pkt_type,
                    'timestamp': timestamp,
                    'device_id': device_id,
                    'source_id': source_id,
                    'target_id': target_id,
                    'level': level,
                    'button': button,
                    'rssi': rssi,
                    'decoded_data': decoded_data
                }
            return

        # Parse legacy TX packets: "TX 23 bytes: 81 00 01 ..."
        tx_match = TX_PATTERN.search(message)
        if tx_match:
            raw_hex = tx_match.group(2)
            bytes_list = raw_hex.split()

            # Use the new parsing function
            parsed = parse_packet_bytes(bytes_list)

            # Register device_id for echo detection
            if parsed['device_id']:
                _register_tx_device(parsed['device_id'])
            if parsed['source_id'] and parsed['source_id'] != parsed['device_id']:
                _register_tx_device(parsed['source_id'])

            db.insert_decoded_packet(
                direction='tx',
                packet_type=parsed['packet_type'],
                timestamp=timestamp,
                raw_hex=raw_hex,
                device_id=parsed['device_id'],
                source_id=parsed['source_id'],
                target_id=parsed['target_id'],
                level=parsed['level'],
                decoded_data=parsed['decoded_data']
            )

            # Parse fields for TX packets (legacy format)
            legacy_tx_fields = parse_packet_fields(bytes_list, parsed['packet_type'])

            # Push to packet queue for SSE streaming
            try:
                packet_queue.put_nowait({
                    'direction': 'tx',
                    'type': parsed['packet_type'],
                    'time': timestamp.split('T')[1].split('.')[0] if 'T' in timestamp else timestamp[-8:],
                    'device_id': parsed['device_id'],
                    'source_id': parsed['source_id'],
                    'target_id': parsed['target_id'],
                    'summary': f"{parsed['source_id']} -> {parsed['target_id']}" if parsed['source_id'] and parsed['target_id'] else parsed['device_id'] or '',
                    'details': parsed['decoded_data'],
                    'fields': legacy_tx_fields,  # Backend-parsed field breakdown
                    'raw_hex': raw_hex,
                    'rssi': None
                })
            except queue.Full:
                pass  # Drop if queue is full
    except Exception as e:
        # Don't let parsing errors break the log stream
        pass


def _infer_category_from_type(pkt_type: str, button: str = None) -> str:
    """Infer device category from packet type."""
    if pkt_type == 'LEVEL':
        return 'bridge_controlled'
    elif pkt_type == 'UNPAIR':
        return 'bridge_controlled'
    elif pkt_type == 'STATE_RPT':
        return 'dimmer_passive'
    elif pkt_type.startswith('BTN_'):
        if button and button.startswith('SCENE'):
            return 'scene_pico'
        return 'pico'
    elif pkt_type.startswith('BEACON'):
        return 'beacon'
    elif pkt_type.startswith('PAIR'):
        return 'pairing'
    return 'unknown'


class ESP32Controller:
    """Controller for ESP32 Lutron RF transmitter via native API."""

    def __init__(self, host: str = None, port: int = ESP32_PORT):
        # Use current_esp_host if no host specified
        self.host = host if host is not None else current_esp_host
        self.port = port
        self.client: Optional[APIClient] = None
        self._entities = {}
        self._services = {}

    async def connect(self):
        """Connect to ESP32."""
        self.client = APIClient(
            address=self.host,
            port=self.port,
            password=ESP32_PASSWORD,
            noise_psk=ESP32_ENCRYPTION_KEY,
        )
        await self.client.connect(login=True)

    async def disconnect(self):
        """Disconnect from ESP32."""
        if self.client:
            await self.client.disconnect()

    async def list_entities(self):
        """List all entities and services."""
        entities, services = await self.client.list_entities_services()

        buttons = []
        switches = []
        for entity in entities:
            if hasattr(entity, 'object_id'):
                entity_type = type(entity).__name__
                if 'Button' in entity_type:
                    buttons.append({
                        'key': entity.key,
                        'name': entity.name,
                        'object_id': entity.object_id,
                    })
                    self._entities[entity.object_id] = ('button', entity.key)
                elif 'Switch' in entity_type:
                    switches.append({
                        'key': entity.key,
                        'name': entity.name,
                        'object_id': entity.object_id,
                    })
                    self._entities[entity.object_id] = ('switch', entity.key)

        for svc in services:
            self._services[svc.name] = svc

        return buttons, switches

    async def call_service(self, service_name: str, **kwargs):
        """Call an ESPHome user-defined service."""
        if not self._services:
            await self.list_entities()

        if service_name not in self._services:
            raise ValueError(f"Service not found: {service_name}")

        svc = self._services[service_name]
        await self.client.execute_service(svc, kwargs)

    async def send_button(self, device_id: int, button_code: int):
        """Send a button press."""
        await self.call_service('send_button', device_id=f"0x{device_id:08X}", button_code=button_code)

    async def send_pairing(self, device_id: int, duration: int = 6):
        """Send pairing sequence."""
        await self.call_service('send_pairing', device_id=f"0x{device_id:08X}", duration_seconds=duration)

    async def send_level(self, source_id: int, target_id: int, level: int):
        """Send level command."""
        await self.call_service('send_level', source_id=f"0x{source_id:08X}",
                               target_id=f"0x{target_id:08X}", level_percent=level)

    async def send_state_report(self, device_id: int, level: int):
        """Send state report."""
        await self.call_service('send_state_report', device_id=f"0x{device_id:08X}", level_percent=level)

    async def send_beacon(self, device_id: int, beacon_type: int, duration: int):
        """Send pairing beacon."""
        await self.call_service('send_beacon', device_id=f"0x{device_id:08X}",
                               beacon_type=beacon_type, duration_seconds=duration)

    async def pair_pico(self, device_id: int, pico_type: int = 1, ba_count: int = 12, bb_count: int = 6, button_scheme: int = 0x04):
        """Send Pico pairing.
        pico_type: 0=Scene (bridge only), 1=5-button (direct to dimmer)
        button_scheme: 0x04=5-btn codes (0x02-0x06), 0x0B=4-btn codes (0x08-0x0B)
        """
        await self.call_service('pair_experiment',
                               device_id=f"0x{device_id:08X}",
                               ba_count=ba_count,
                               bb_count=bb_count,
                               protocol_variant=0,  # New protocol (0x25)
                               pico_type=pico_type,  # 0=Scene, 1=5-button
                               button_scheme=button_scheme)  # Byte 10: button code scheme

    async def save_favorite(self, device_id: int, button: int = 0x03, hold_seconds: int = 6):
        """Send save favorite/scene sequence.
        Holds button for extended time to trigger save mode on paired dimmers.
        button: 0x03=FAV for 5-button, 0x08-0x0B for scene pico buttons
        hold_seconds: How long to hold (default 6, dimmer needs ~5s)
        """
        await self.call_service('save_favorite',
                               device_id=f"0x{device_id:08X}",
                               button_code=button,
                               hold_seconds=hold_seconds)

    async def send_reset(self, source_id: int, paired_id: int):
        """Send Reset/Unpair packet to remove a Pico from a device."""
        await self.call_service('send_reset',
                               source_id=f"0x{source_id:08X}",
                               paired_id=f"0x{paired_id:08X}")

    async def send_bridge_unpair(self, bridge_zone_id: int, target_device_id: int):
        """Send bridge-style unpair command to remove a device from the network."""
        await self.call_service('send_bridge_unpair',
                               bridge_zone_id=f"0x{bridge_zone_id:08X}",
                               target_device_id=f"0x{target_device_id:08X}")

    async def send_bridge_unpair_dual(self, zone_id_1: int, zone_id_2: int, target_device_id: int):
        """Send bridge-style unpair from TWO zone IDs (interleaved like real bridge)."""
        await self.call_service('send_bridge_unpair_dual',
                               zone_id_1=f"0x{zone_id_1:08X}",
                               zone_id_2=f"0x{zone_id_2:08X}",
                               target_device_id=f"0x{target_device_id:08X}")

    async def start_pairing(self, subnet: int):
        """Start bridge pairing mode - sends active beacons."""
        await self.call_service('start_pairing', subnet=f"0x{subnet:04X}")

    async def stop_pairing(self, subnet: int):
        """Stop bridge pairing mode - sends stop beacons."""
        await self.call_service('stop_pairing', subnet=f"0x{subnet:04X}")

    async def pair_device(self, subnet: int, factory_id: int, zone_suffix: int):
        """Complete bridge pairing sequence for a device."""
        await self.call_service('pair_device',
                               subnet=f"0x{subnet:04X}",
                               factory_id=f"0x{factory_id:08X}",
                               zone_suffix=f"0x{zone_suffix:02X}")

    async def send_pair_assignment(self, subnet: int, factory_id: int, zone_suffix: int):
        """Send B0 pairing assignment packets only."""
        await self.call_service('send_pair_assignment',
                               subnet=f"0x{subnet:04X}",
                               factory_id=f"0x{factory_id:08X}",
                               zone_suffix=f"0x{zone_suffix:02X}")

    # ========== DEVICE CONFIGURATION ==========

    async def send_led_config(self, bridge_zone_id: int, target_device_id: int, mode: int):
        """Send LED config command.
        mode: 0=Both Off, 1=Both On, 2=On when load on, 3=On when load off
        """
        await self.call_service('send_led_config',
                               bridge_zone_id=f"0x{bridge_zone_id:08X}",
                               target_device_id=f"0x{target_device_id:08X}",
                               mode=mode)

    async def send_fade_config(self, bridge_zone_id: int, target_device_id: int,
                               fade_on_qs: int, fade_off_qs: int):
        """Send fade rate config command.
        Values in quarter-seconds: 1=0.25s, 3=0.75s, 10=2.5s, 12=3s, 20=5s, 60=15s
        """
        await self.call_service('send_fade_config',
                               bridge_zone_id=f"0x{bridge_zone_id:08X}",
                               target_device_id=f"0x{target_device_id:08X}",
                               fade_on_qs=fade_on_qs,
                               fade_off_qs=fade_off_qs)

    async def send_device_state(self, bridge_zone_id: int, target_device_id: int,
                                high_trim: int, low_trim: int, phase_reverse: bool):
        """Send device state config (trim and phase settings).
        high_trim/low_trim: 0-100 (percentage)
        phase_reverse: True for reverse, False for forward
        """
        await self.call_service('send_device_state',
                               bridge_zone_id=f"0x{bridge_zone_id:08X}",
                               target_device_id=f"0x{target_device_id:08X}",
                               high_trim=high_trim,
                               low_trim=low_trim,
                               phase_reverse=1 if phase_reverse else 0)

    async def start_rx(self):
        """Start RX mode by pressing rx_on button."""
        await self.press_button('rx_on')

    async def stop_rx(self):
        """Stop RX mode by pressing rx_off button."""
        await self.press_button('rx_off')

    async def press_button(self, button_id: str):
        """Press a button by ID."""
        if not self._entities:
            await self.list_entities()

        entity_info = self._entities.get(button_id)
        if not entity_info:
            for obj_id, info in self._entities.items():
                if button_id.lower() in obj_id.lower():
                    entity_info = info
                    break

        if entity_info is None:
            raise ValueError(f"Button not found: {button_id}")

        entity_type, key = entity_info
        if entity_type != 'button':
            raise ValueError(f"{button_id} is a {entity_type}, not a button")

        self.client.button_command(key)

    async def set_switch(self, switch_id: str, state: bool):
        """Set a switch on or off."""
        if not self._entities:
            await self.list_entities()

        entity_info = self._entities.get(switch_id)
        if not entity_info:
            for obj_id, info in self._entities.items():
                if switch_id.lower() in obj_id.lower():
                    entity_info = info
                    break

        if entity_info is None:
            raise ValueError(f"Switch not found: {switch_id}")

        entity_type, key = entity_info
        self.client.switch_command(key, state)


def cmd_serve(args):
    """Start local web server with CCA Playground API."""
    try:
        from flask import Flask, jsonify, request, Response
    except ImportError:
        print("Error: Flask not installed. Run: pip install flask")
        sys.exit(1)

    app = Flask(__name__)

    # CORS headers for proxied requests
    @app.after_request
    def add_cors_headers(response):
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return response

    @app.route('/api/health')
    def health():
        return jsonify({'status': 'ok'})

    # Frontend is served by `cca serve` - this is API-only
    @app.route('/')
    def index():
        return jsonify({
            'service': 'CCA Playground API',
            'usage': 'Run `cca serve` for the full web UI',
            'endpoints': '/api/*'
        })

    # ═══════════════════════════════════════════════════════════════════════════
    # API ENDPOINTS
    # ═══════════════════════════════════════════════════════════════════════════

    def parse_hex_int(value: str) -> int:
        """Parse hex (0x...) or decimal string to int."""
        value = value.strip()
        if value.lower().startswith('0x'):
            return int(value, 16)
        return int(value)

    # Async helpers
    async def send_button_async(device_id: int, button_code: int):
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_button(device_id, button_code)
        finally:
            await controller.disconnect()

    async def press_button_async(button_id: str):
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.press_button(button_id)
        finally:
            await controller.disconnect()

    async def send_level_async(source_id: int, target_id: int, level: int):
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_level(source_id, target_id, level)
        finally:
            await controller.disconnect()

    async def send_state_async(device_id: int, level: int):
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_state_report(device_id, level)
        finally:
            await controller.disconnect()

    async def send_beacon_async(device_id: int, beacon_type: int, duration: int):
        """Send beacon - fire and forget since this is a long-running operation."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            # Fire the beacon command - don't wait for completion
            await controller.send_beacon(device_id, beacon_type, duration)
        except asyncio.TimeoutError:
            # Expected - beacon runs longer than API timeout
            pass
        finally:
            try:
                await asyncio.wait_for(controller.disconnect(), timeout=2.0)
            except (asyncio.TimeoutError, Exception):
                # Ignore disconnect timeout - ESP32 is busy with beacon
                pass

    async def pair_pico_async(device_id: int, pico_type: int = 1, button_scheme: int = 0x04):
        """pico_type: 0 = Scene, 1 = 5-button
        button_scheme: 0x04 = 5-btn, 0x0B = 4-btn
        """
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.pair_pico(device_id, pico_type, button_scheme=button_scheme)
        finally:
            await controller.disconnect()

    async def pair_5button_async(device_id: int, duration: int = 10):
        """Pair using 5-button Pico B9 packets (matches real Pico exactly)."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.call_service('pair_5button',
                                         device_id=f"0x{device_id:08X}",
                                         duration_seconds=duration)
        except asyncio.TimeoutError:
            pass  # Expected for long pairing operations
        finally:
            try:
                await asyncio.wait_for(controller.disconnect(), timeout=2.0)
            except (asyncio.TimeoutError, Exception):
                pass

    async def pair_advanced_async(device_id: int, preset: str, duration: int,
                                  pkt_type: str, byte10: int, byte30: int,
                                  byte31: int, byte37: int, byte38: int):
        """Advanced pairing with full parameter control.

        Uses the new pair_advanced service to send pairing with exact byte values.
        Captured Pico types:
        - 2-btn paddle: B9/BB, b10=04, b30=03, b31=08, b37=01, b38=01
        - 5-button:     B9/BB, b10=04, b30=03, b31=00, b37=02, b38=06
        - 4-btn R/L:    B9/BB, b10=0B, b30=02, b31=00, b37=02, b38=21
        - 4-btn scene:  B9/BB, b10=0B, b30=04, b31=00, b37=02, b38=28 (custom)
        - 4-btn scene:  B8/BA, b10=0B, b30=04, b31=00, b37=02, b38=27 (std)
        """
        controller = ESP32Controller()
        try:
            await controller.connect()

            # Determine packet types based on pkt_type parameter
            # B9/BB = direct pair capable, B8/BA = bridge-only
            if pkt_type in ('B8', 'BA'):
                pkt_type_a = 0xB8
                pkt_type_b = 0xBA
            else:
                pkt_type_a = 0xB9
                pkt_type_b = 0xBB

            # Call the new pair_advanced service with ALL parameters
            await controller.call_service('pair_advanced',
                                         device_id=f"0x{device_id:08X}",
                                         duration_seconds=duration,
                                         pkt_type_a=pkt_type_a,
                                         pkt_type_b=pkt_type_b,
                                         byte10=byte10,
                                         byte30=byte30,
                                         byte31=byte31,
                                         byte37=byte37,
                                         byte38=byte38)
        except asyncio.TimeoutError:
            pass  # Expected for long pairing operations
        finally:
            try:
                await asyncio.wait_for(controller.disconnect(), timeout=2.0)
            except (asyncio.TimeoutError, Exception):
                pass

    async def send_reset_async(source_id: int, paired_id: int):
        """Send reset/unpair packet."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_reset(source_id, paired_id)
        finally:
            await controller.disconnect()

    async def send_bridge_unpair_async(bridge_zone_id: int, target_device_id: int):
        """Send bridge-style unpair command."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_bridge_unpair(bridge_zone_id, target_device_id)
        finally:
            await controller.disconnect()

    async def send_bridge_unpair_dual_async(zone_id_1: int, zone_id_2: int, target_device_id: int):
        """Send bridge-style unpair from TWO zone IDs (interleaved like real bridge)."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_bridge_unpair_dual(zone_id_1, zone_id_2, target_device_id)
        finally:
            await controller.disconnect()

    # ========== DEVICE CONFIGURATION ==========

    async def send_led_config_async(bridge_zone_id: int, target_device_id: int, mode: int):
        """Send LED config command."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_led_config(bridge_zone_id, target_device_id, mode)
        finally:
            await controller.disconnect()

    async def send_fade_config_async(bridge_zone_id: int, target_device_id: int,
                                     fade_on_qs: int, fade_off_qs: int):
        """Send fade rate config command."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_fade_config(bridge_zone_id, target_device_id, fade_on_qs, fade_off_qs)
        finally:
            await controller.disconnect()

    async def send_device_state_async(bridge_zone_id: int, target_device_id: int,
                                      high_trim: int, low_trim: int, phase_reverse: bool):
        """Send device state config (trim and phase)."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_device_state(bridge_zone_id, target_device_id,
                                               high_trim, low_trim, phase_reverse)
        finally:
            await controller.disconnect()

    async def save_favorite_async(device_id: int, button: int, hold_seconds: int):
        """Send save favorite/scene sequence."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.save_favorite(device_id, button, hold_seconds)
        except asyncio.TimeoutError:
            pass  # Expected for long hold operations
        finally:
            try:
                await asyncio.wait_for(controller.disconnect(), timeout=2.0)
            except (asyncio.TimeoutError, Exception):
                pass

    async def start_rx_async():
        """Start RX mode."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.start_rx()
        finally:
            await controller.disconnect()

    async def stop_rx_async():
        """Stop RX mode."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.stop_rx()
        finally:
            await controller.disconnect()

    async def check_connection_async():
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.disconnect()
            return True
        except:
            return False

    async def test_connection_async(host: str):
        """Test connection to a specific ESP32 host."""
        controller = ESP32Controller(host=host)
        try:
            await asyncio.wait_for(controller.connect(), timeout=10.0)
            await controller.disconnect()
            return True
        except:
            return False

    async def test_decode_async(hex_bytes: str):
        """Test packet decoding on ESP32 and capture result.

        Calls the test_decode service and waits for TEST_RESULT log message.
        Returns the parsed JSON result.
        """
        result_holder = {'result': None}
        result_event = asyncio.Event()

        def log_callback(message):
            """Callback for log messages - look for TEST_RESULT."""
            msg_text = message.message
            # Handle bytes (ESPHome API returns bytes)
            if isinstance(msg_text, bytes):
                msg_text = msg_text.decode('utf-8', errors='replace')
            if 'TEST_RESULT' in msg_text:
                # Extract JSON from log message
                # Format: [I][TEST_RESULT:xxx]: {...json...}
                try:
                    # Find the JSON part
                    json_start = msg_text.find('{')
                    if json_start >= 0:
                        json_str = msg_text[json_start:]
                        # Remove ANSI escape codes
                        json_str = re.sub(r'\x1b\[[0-9;]*m', '', json_str)
                        result_holder['result'] = json.loads(json_str)
                        result_event.set()
                except json.JSONDecodeError:
                    pass

        controller = ESP32Controller()
        try:
            await controller.connect()

            # Subscribe to logs (not awaitable)
            controller.client.subscribe_logs(
                log_callback,
                log_level=aioesphomeapi.LogLevel.LOG_LEVEL_INFO
            )

            # Call the test_decode service
            await controller.call_service('test_decode', hex_bytes=hex_bytes)

            # Wait for result with timeout
            try:
                await asyncio.wait_for(result_event.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass

            return result_holder['result']
        finally:
            await controller.disconnect()

    async def set_switch_async(switch_id: str, state: bool):
        """Set a switch on or off."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.set_switch(switch_id, state)
        finally:
            try:
                await asyncio.wait_for(controller.disconnect(), timeout=2.0)
            except (asyncio.TimeoutError, Exception):
                pass

    async def set_beacon_device_async(device_id: int):
        """Set the beacon device ID for toggle mode."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.call_service('set_beacon_device', device_id=f"0x{device_id:08X}")
        finally:
            try:
                await asyncio.wait_for(controller.disconnect(), timeout=2.0)
            except (asyncio.TimeoutError, Exception):
                pass

    @app.route('/api/status')
    def api_status():
        """Check ESP32 connection status."""
        try:
            connected = asyncio.run(check_connection_async())
            return jsonify({'connected': connected, 'ip': current_esp_host})
        except:
            return jsonify({'connected': False, 'ip': current_esp_host})

    @app.route('/api/esp/config')
    def api_esp_config():
        """Get ESP32 connection configuration and status."""
        now = time.time()
        heartbeat_age = now - log_thread_heartbeat if log_thread_heartbeat > 0 else -1
        last_log_age = now - log_last_received if log_last_received > 0 else -1
        thread_alive = heartbeat_age >= 0 and heartbeat_age < LOG_THREAD_TIMEOUT
        receiving_logs = last_log_age >= 0 and last_log_age < LOG_STALE_TIMEOUT

        # Calculate last_seen as ISO string
        last_seen = None
        if log_last_received > 0:
            last_seen = datetime.fromtimestamp(log_last_received).isoformat()

        return jsonify({
            'host': current_esp_host,
            'port': ESP32_PORT,
            'default_host': ESP32_IP,
            'last_seen': last_seen,
            'last_log_age': round(last_log_age, 1) if last_log_age >= 0 else None,
            'thread_alive': thread_alive,
            'receiving_logs': receiving_logs,
            'healthy': thread_alive and receiving_logs
        })

    @app.route('/api/esp/config', methods=['POST'])
    def api_esp_config_set():
        """Set ESP32 host and optionally trigger reconnect."""
        global current_esp_host
        data = request.json or {}
        new_host = data.get('host', '').strip()

        if not new_host:
            return jsonify({'status': 'error', 'error': 'host is required'}), 400

        with esp_config_lock:
            old_host = current_esp_host
            current_esp_host = new_host
            print(f"[API] ESP32 host changed: {old_host} -> {new_host}", flush=True)

        return jsonify({
            'status': 'ok',
            'host': current_esp_host,
            'previous_host': old_host
        })

    @app.route('/api/esp/reconnect', methods=['POST'])
    def api_esp_reconnect():
        """Force reconnect to ESP32 (restart log subscription)."""
        global log_subscription_started, log_thread_heartbeat
        with log_subscription_lock:
            print(f"[API] Forcing ESP32 reconnect to {current_esp_host}...", flush=True)
            log_subscription_started = False
            log_thread_heartbeat = 0
            # Clear queues
            while not log_queue.empty():
                try:
                    log_queue.get_nowait()
                except queue.Empty:
                    break
            while not packet_queue.empty():
                try:
                    packet_queue.get_nowait()
                except queue.Empty:
                    break
        return jsonify({
            'status': 'ok',
            'message': f'Reconnecting to {current_esp_host}...',
            'host': current_esp_host
        })

    @app.route('/api/esp/test', methods=['POST'])
    def api_esp_test():
        """Test connection to ESP32 (checks if device is reachable)."""
        host = request.json.get('host', current_esp_host) if request.is_json else current_esp_host
        try:
            connected = asyncio.run(test_connection_async(host))
            return jsonify({
                'status': 'ok',
                'connected': connected,
                'host': host
            })
        except Exception as e:
            return jsonify({
                'status': 'error',
                'connected': False,
                'host': host,
                'error': str(e)
            })

    @app.route('/api/test/decode', methods=['POST'])
    def api_test_decode():
        """Test packet decoding on ESP32.

        Sends hex bytes to ESP32 for parsing and returns the decoded result.
        Used by test framework to verify ESP32 packet parsing logic.

        Request body:
            {"hex_bytes": "88 00 8D E6 95 05 21 04 03 00 02 00 ..."}

        Response:
            {"status": "ok", "result": {...parsed packet JSON...}}
        """
        try:
            hex_bytes = request.json.get('hex_bytes', '') if request.is_json else ''
            if not hex_bytes:
                return jsonify({'status': 'error', 'error': 'Missing hex_bytes'}), 400

            # Call the test_decode service and capture result from logs
            result = asyncio.run(test_decode_async(hex_bytes))
            if result is None:
                return jsonify({'status': 'error', 'error': 'No result from ESP32'}), 500

            return jsonify({
                'status': 'ok',
                'result': result
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    def get_param(name, default=''):
        """Get parameter from JSON body or query args."""
        if request.is_json and request.json:
            return request.json.get(name, request.args.get(name, default))
        return request.args.get(name, default)

    @app.route('/api/send', methods=['POST'])
    def api_send():
        """Send button command."""
        try:
            device = get_param('device', '')
            button = get_param('button', '')
            if not device or not button:
                return jsonify({'status': 'error', 'error': 'Missing device or button'}), 400

            device_id = parse_hex_int(device)
            button_code = int(button) if isinstance(button, int) else parse_hex_int(str(button))
            asyncio.run(send_button_async(device_id, button_code))

            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'button': f'0x{button_code:02X}'
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/level', methods=['POST'])
    def api_level():
        """Send bridge-style level command."""
        try:
            source = get_param('source', '')
            target = get_param('target', '')
            level = int(get_param('level', '0'))
            if not source or not target:
                return jsonify({'status': 'error', 'error': 'Missing source or target'}), 400

            source_id = parse_hex_int(source)
            target_id = parse_hex_int(target)
            asyncio.run(send_level_async(source_id, target_id, level))

            return jsonify({
                'status': 'ok',
                'source': f'0x{source_id:08X}',
                'target': f'0x{target_id:08X}',
                'level': level
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/state', methods=['POST'])
    def api_state():
        """Send state report (fake dimmer level broadcast)."""
        try:
            device = get_param('device', '')
            level = int(get_param('level', '0'))
            if not device:
                return jsonify({'status': 'error', 'error': 'Missing device'}), 400

            device_id = parse_hex_int(device)
            asyncio.run(send_state_async(device_id, level))

            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'level': level
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    # ========== DEVICE CONFIGURATION ENDPOINTS ==========

    @app.route('/api/config/led', methods=['POST'])
    def api_config_led():
        """Set status LED behavior.
        Args:
            bridge: Bridge zone ID (e.g., 0x002C90AD)
            target: Target device ID (e.g., 0x06FE8006)
            mode: 0=Both Off, 1=Both On, 2=On when load on, 3=On when load off
        """
        try:
            bridge = get_param('bridge', '')
            target = get_param('target', '')
            mode = int(get_param('mode', '0'))
            if not bridge or not target:
                return jsonify({'status': 'error', 'error': 'Missing bridge or target'}), 400
            if mode < 0 or mode > 3:
                return jsonify({'status': 'error', 'error': 'Mode must be 0-3'}), 400

            bridge_id = parse_hex_int(bridge)
            target_id = parse_hex_int(target)
            asyncio.run(send_led_config_async(bridge_id, target_id, mode))

            mode_names = ['Both Off', 'Both On', 'On when load on', 'On when load off']
            return jsonify({
                'status': 'ok',
                'bridge': f'0x{bridge_id:08X}',
                'target': f'0x{target_id:08X}',
                'mode': mode,
                'mode_name': mode_names[mode]
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/config/fade', methods=['POST'])
    def api_config_fade():
        """Set fade on/off rates.
        Args:
            bridge: Bridge zone ID
            target: Target device ID
            fade_on: Fade-on time in seconds (0.25, 0.75, 2.5, 3, 5, 15)
            fade_off: Fade-off time in seconds
        """
        try:
            bridge = get_param('bridge', '')
            target = get_param('target', '')
            fade_on = float(get_param('fade_on', '0'))
            fade_off = float(get_param('fade_off', '0'))
            if not bridge or not target:
                return jsonify({'status': 'error', 'error': 'Missing bridge or target'}), 400

            bridge_id = parse_hex_int(bridge)
            target_id = parse_hex_int(target)
            # Convert seconds to quarter-seconds
            fade_on_qs = int(fade_on * 4)
            fade_off_qs = int(fade_off * 4)
            asyncio.run(send_fade_config_async(bridge_id, target_id, fade_on_qs, fade_off_qs))

            return jsonify({
                'status': 'ok',
                'bridge': f'0x{bridge_id:08X}',
                'target': f'0x{target_id:08X}',
                'fade_on': fade_on,
                'fade_off': fade_off,
                'fade_on_qs': fade_on_qs,
                'fade_off_qs': fade_off_qs
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/config/trim', methods=['POST'])
    def api_config_trim():
        """Set trim levels (low-end and high-end).
        Args:
            bridge: Bridge zone ID
            target: Target device ID
            high: High-end trim 0-100%
            low: Low-end trim 0-100%
            phase: Optional - 'forward' or 'reverse' (default: forward)
        """
        try:
            bridge = get_param('bridge', '')
            target = get_param('target', '')
            high_trim = int(get_param('high', '100'))
            low_trim = int(get_param('low', '1'))
            phase = get_param('phase', 'forward').lower()
            if not bridge or not target:
                return jsonify({'status': 'error', 'error': 'Missing bridge or target'}), 400

            bridge_id = parse_hex_int(bridge)
            target_id = parse_hex_int(target)
            phase_reverse = (phase == 'reverse')
            asyncio.run(send_device_state_async(bridge_id, target_id, high_trim, low_trim, phase_reverse))

            return jsonify({
                'status': 'ok',
                'bridge': f'0x{bridge_id:08X}',
                'target': f'0x{target_id:08X}',
                'high_trim': high_trim,
                'low_trim': low_trim,
                'phase': 'reverse' if phase_reverse else 'forward'
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/config/phase', methods=['POST'])
    def api_config_phase():
        """Set phase mode (forward or reverse).
        Args:
            bridge: Bridge zone ID
            target: Target device ID
            phase: 'forward' or 'reverse'
            high: Optional high-end trim (default: 100)
            low: Optional low-end trim (default: 1)
        """
        try:
            bridge = get_param('bridge', '')
            target = get_param('target', '')
            phase = get_param('phase', 'forward').lower()
            high_trim = int(get_param('high', '100'))
            low_trim = int(get_param('low', '1'))
            if not bridge or not target:
                return jsonify({'status': 'error', 'error': 'Missing bridge or target'}), 400
            if phase not in ('forward', 'reverse'):
                return jsonify({'status': 'error', 'error': 'Phase must be forward or reverse'}), 400

            bridge_id = parse_hex_int(bridge)
            target_id = parse_hex_int(target)
            phase_reverse = (phase == 'reverse')
            asyncio.run(send_device_state_async(bridge_id, target_id, high_trim, low_trim, phase_reverse))

            return jsonify({
                'status': 'ok',
                'bridge': f'0x{bridge_id:08X}',
                'target': f'0x{target_id:08X}',
                'phase': phase,
                'high_trim': high_trim,
                'low_trim': low_trim
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/reset', methods=['POST'])
    def api_reset():
        """Send Pico reset packet (broadcasts 'forget me')."""
        try:
            pico = request.args.get('pico', '')
            if not pico:
                return jsonify({'status': 'error', 'error': 'Missing pico ID'}), 400

            pico_id = parse_hex_int(pico)
            # Pass same ID twice (paired_id is ignored in new implementation)
            asyncio.run(send_reset_async(pico_id, pico_id))

            return jsonify({
                'status': 'ok',
                'pico': f'0x{pico_id:08X}'
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/unpair', methods=['POST'])
    def api_unpair():
        """Send bridge-style unpair command to remove a device from the network.

        Args:
            bridge: Primary bridge zone ID (e.g., 0x002C90AD)
            zone2: Optional secondary zone ID for dual-zone mode (e.g., 0x002C90AF)
            target: Device to unpair (e.g., 0x06F4587E)

        Dual-zone mode sends interleaved packets from both zones like the real bridge.
        """
        try:
            bridge = get_param('bridge', '')
            zone2 = get_param('zone2', '')
            target = get_param('target', '')
            if not bridge or not target:
                return jsonify({'status': 'error', 'error': 'Missing bridge or target'}), 400

            bridge_id = parse_hex_int(bridge)
            target_id = parse_hex_int(target)

            if zone2:
                zone2_id = parse_hex_int(zone2)
                asyncio.run(send_bridge_unpair_dual_async(bridge_id, zone2_id, target_id))
                return jsonify({
                    'status': 'ok',
                    'zone1': f'0x{bridge_id:08X}',
                    'zone2': f'0x{zone2_id:08X}',
                    'target': f'0x{target_id:08X}',
                    'mode': 'dual'
                })
            else:
                asyncio.run(send_bridge_unpair_async(bridge_id, target_id))
                return jsonify({
                    'status': 'ok',
                    'bridge': f'0x{bridge_id:08X}',
                    'target': f'0x{target_id:08X}',
                    'mode': 'single'
                })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/beacon', methods=['POST'])
    def api_beacon():
        """Send pairing beacon."""
        try:
            device = request.args.get('device', '')
            duration = int(request.args.get('duration', '30'))
            beacon_type = parse_hex_int(request.args.get('type', '0x92'))
            if not device:
                return jsonify({'status': 'error', 'error': 'Missing device'}), 400

            device_id = parse_hex_int(device)
            asyncio.run(send_beacon_async(device_id, beacon_type, duration))

            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'duration': duration
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/pair-pico', methods=['POST'])
    def api_pair_pico():
        """Pair as Pico with preset or custom parameters.

        Presets (based on real Pico captures):
        - 5btn: 5-Button Pico (B9, FAV works) - direct pair to dimmers
        - 2btn: 2-Button Paddle (B9, FAV=ON)
        - 4btn-rl: 4-Button Raise/Lower (B9)
        - 4btn-scene-custom: 4-Button Scene Custom (B9, direct!)
        - 4btn-scene-std: 4-Button Scene Standard (BA/BB, bridge only)
        - custom: Use advanced byte parameters

        Parameters:
        - device: Pico ID (hex string like 0xCC110001)
        - preset: Preset name (see above)
        - duration: Pairing duration in seconds
        - pkt_type: 'B9' (direct) or 'BA' (bridge)
        - byte10, byte30, byte31, byte37, byte38: Advanced capability bytes
        """
        try:
            device = get_param('device', '')
            preset = get_param('preset', '5btn')
            duration = int(get_param('duration', '10'))

            # Advanced parameters (used for custom preset)
            pkt_type = get_param('pkt_type', 'B9')
            byte10 = parse_hex_int(get_param('byte10', '0x04'))
            byte30 = parse_hex_int(get_param('byte30', '0x03'))
            byte31 = parse_hex_int(get_param('byte31', '0x00'))
            byte37 = parse_hex_int(get_param('byte37', '0x02'))
            byte38 = parse_hex_int(get_param('byte38', '0x06'))

            if not device:
                return jsonify({'status': 'error', 'error': 'Missing device'}), 400

            device_id = parse_hex_int(device)

            # Use the advanced async function
            asyncio.run(pair_advanced_async(
                device_id, preset, duration,
                pkt_type, byte10, byte30, byte31, byte37, byte38
            ))

            preset_names = {
                '5btn': '5-Button Pico (B9)',
                '2btn': '2-Button Paddle (B9)',
                '4btn-rl': '4-Button R/L (B9)',
                '4btn-scene-custom': '4-Button Scene (B9)',
                '4btn-scene-std': '4-Button Scene (BA/BB)',
                'custom': f'Custom (B10={byte10:02X})'
            }

            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'preset': preset_names.get(preset, preset),
                'duration': duration
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/save-favorite', methods=['POST'])
    def api_save_favorite():
        """Save favorite/scene level.

        Holds button for extended time to trigger save mode on paired dimmers.
        First set the dimmer to desired level, then call this to save.

        Parameters:
        - device: Pico ID (hex string like 0x05851117)
        - button: Button code (0x03=FAV for 5-btn, 0x08-0x0B for scene pico)
        - hold: Duration in seconds (default 6, dimmer needs ~5s)
        """
        try:
            device = get_param('device', '')
            button = get_param('button', '0x03')
            hold_seconds = int(get_param('hold', '6'))

            if not device:
                return jsonify({'status': 'error', 'error': 'Missing device'}), 400

            device_id = parse_hex_int(device)
            button_code = parse_hex_int(button)

            asyncio.run(save_favorite_async(device_id, button_code, hold_seconds))

            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'button': f'0x{button_code:02X}',
                'hold_seconds': hold_seconds
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/rx/start', methods=['POST'])
    def api_rx_start():
        """Start RX mode."""
        try:
            asyncio.run(start_rx_async())
            return jsonify({'status': 'ok'})
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/rx/stop', methods=['POST'])
    def api_rx_stop():
        """Stop RX mode."""
        try:
            asyncio.run(stop_rx_async())
            return jsonify({'status': 'ok'})
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/devices')
    def api_devices():
        """Get all discovered devices."""
        return jsonify(db.get_all_devices())

    @app.route('/api/devices', methods=['POST'])
    def api_register_device():
        """Register a device from RX packet."""
        data = request.json
        device_id = data.get('device_id')
        device_type = data.get('type', 'unknown')
        info = data.get('info', {})
        if not device_id:
            return jsonify({'status': 'error', 'error': 'device_id required'}), 400
        device = register_device(device_id, device_type, info)
        return jsonify({'status': 'ok', 'device': device})

    @app.route('/api/devices/<device_id>', methods=['DELETE'])
    def api_delete_device(device_id):
        """Delete a device from the database."""
        if db.delete_device(device_id):
            return jsonify({'status': 'ok'})
        return jsonify({'status': 'error', 'error': 'not found'}), 404

    @app.route('/api/links')
    def api_links():
        """Get devices grouped by link ID.

        Returns a structure like:
        {
          "2C90": {
            "link_id": "2C90",
            "devices": [
              {"id": "002C90AF", "type": "LEVEL", ...},
              {"id": "002C90AD", "type": "LEVEL", ...}
            ],
            "device_count": 2,
            "last_seen": "2026-01-03T..."
          }
        }
        """
        devices = db.get_all_devices()
        links = {}

        for device_id, device in devices.items():
            # Compute link_id if not present
            link_id = device.get('link_id') or extract_link_id(device_id)

            if link_id not in links:
                links[link_id] = {
                    "link_id": link_id,
                    "devices": [],
                    "device_count": 0,
                    "last_seen": device.get("last_seen", ""),
                    "total_count": 0
                }

            links[link_id]["devices"].append(device)
            links[link_id]["device_count"] += 1
            links[link_id]["total_count"] += device.get("count", 0)

            # Track most recent activity
            if device.get("last_seen", "") > links[link_id]["last_seen"]:
                links[link_id]["last_seen"] = device.get("last_seen", "")

        # Sort devices within each link by type and ID
        for link_id in links:
            links[link_id]["devices"].sort(key=lambda d: (d.get("type", ""), d.get("id", "")))

        return jsonify(links)

    @app.route('/api/devices/<device_id>/label', methods=['POST'])
    def api_label_device(device_id):
        """Set a user-friendly label for a device."""
        data = request.json or {}
        label = data.get('label', '').strip()
        if db.update_device_label(device_id, label):
            return jsonify({'status': 'ok', 'device_id': device_id, 'label': label})
        return jsonify({'status': 'error', 'error': 'not found'}), 404

    @app.route('/api/devices/<device_id>/type', methods=['POST'])
    def api_set_device_type(device_id):
        """Set the device type for a device (controls buttons shown)."""
        data = request.json or {}
        device_type = data.get('device_type', 'auto').strip()
        if db.update_device_type(device_id, device_type):
            return jsonify({'status': 'ok', 'device_id': device_id, 'device_type': device_type})
        return jsonify({'status': 'error', 'error': 'not found'}), 404

    @app.route('/api/devices/<device_id>/model', methods=['POST'])
    def api_set_device_model(device_id):
        """Set the Lutron model number for a device (informational only)."""
        data = request.json or {}
        model = data.get('model', '').strip()
        if db.update_device_model(device_id, model):
            return jsonify({'status': 'ok', 'device_id': device_id, 'model': model})
        return jsonify({'status': 'error', 'error': 'not found'}), 404

    @app.route('/api/devices/clear', methods=['POST'])
    def api_clear_devices():
        """Clear all devices."""
        count = db.clear_all_devices()
        return jsonify({'status': 'ok', 'deleted': count})

    # ═══════════════════════════════════════════════════════════════════════════
    # DATABASE QUERY ENDPOINTS
    # ═══════════════════════════════════════════════════════════════════════════

    @app.route('/api/db/stats')
    def api_db_stats():
        """Get database statistics."""
        return jsonify(db.get_stats())

    @app.route('/api/db/packets')
    def api_db_packets():
        """Query decoded packets.

        Query params:
        - direction: 'rx' or 'tx'
        - type: packet type (LEVEL, BTN_SHORT_A, etc.)
        - device: device ID to filter (matches device_id, source_id, or target_id)
        - subnet: subnet address to filter (matches source_id for LEVEL commands)
        - limit: max results (default 100)
        - offset: pagination offset
        """
        direction = request.args.get('direction')
        packet_type = request.args.get('type')
        device_id = request.args.get('device')
        subnet = request.args.get('subnet')
        limit = int(request.args.get('limit', 100))
        offset = int(request.args.get('offset', 0))

        packets = db.get_decoded_packets(
            direction=direction,
            packet_type=packet_type,
            device_id=device_id,
            subnet=subnet,
            limit=limit,
            offset=offset
        )
        return jsonify(packets)

    @app.route('/api/db/raw-packets')
    def api_db_raw_packets():
        """Query unique raw packets.

        Query params:
        - limit: max results (default 100)
        - offset: pagination offset
        """
        limit = int(request.args.get('limit', 100))
        offset = int(request.args.get('offset', 0))
        packets = db.get_raw_packets(limit=limit, offset=offset)
        return jsonify(packets)

    @app.route('/api/db/bridges')
    def api_db_bridges():
        """Get list of unique bridge pairing IDs."""
        return jsonify(db.get_bridge_pairings())

    @app.route('/api/button/<button_id>/press', methods=['POST', 'GET'])
    def api_button_press(button_id):
        """Press a button by ID."""
        try:
            asyncio.run(press_button_async(button_id))
            return jsonify({'status': 'ok', 'button': button_id})
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/switch/<switch_id>', methods=['POST'])
    def api_switch_control(switch_id):
        """Control a switch (on/off)."""
        try:
            data = request.json or {}
            state = data.get('state', False)
            asyncio.run(set_switch_async(switch_id, state))
            return jsonify({'status': 'ok', 'switch': switch_id, 'state': state})
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/beacon/device', methods=['POST'])
    def api_beacon_device():
        """Set the beacon device ID for toggle mode."""
        try:
            data = request.json or {}
            device_id = data.get('device_id', 0)
            if isinstance(device_id, str):
                device_id = int(device_id, 16) if device_id.startswith('0x') else int(device_id)
            asyncio.run(set_beacon_device_async(device_id))
            return jsonify({'status': 'ok', 'device_id': f"0x{device_id:08X}"})
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    # ========== Bridge Pairing API ==========

    def parse_hex(value, default=0):
        """Parse hex string to int."""
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            return int(value, 16) if value.startswith('0x') else int(value, 16)
        return default

    @app.route('/api/pairing/start', methods=['POST'])
    def api_pairing_start():
        """Start bridge pairing mode - sends active beacons."""
        try:
            data = request.json or {}
            subnet = parse_hex(data.get('subnet', '0x2C90'))

            async def do_start():
                controller = ESP32Controller(current_esp_host)
                try:
                    await controller.connect()
                    await controller.start_pairing(subnet)
                finally:
                    try:
                        await controller.disconnect()
                    except:
                        pass

            asyncio.run(do_start())
            return jsonify({'status': 'ok', 'subnet': f"0x{subnet:04X}"})
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/pairing/stop', methods=['POST'])
    def api_pairing_stop():
        """Stop bridge pairing mode - sends stop beacons."""
        try:
            data = request.json or {}
            subnet = parse_hex(data.get('subnet', '0x2C90'))

            async def do_stop():
                controller = ESP32Controller(current_esp_host)
                try:
                    await controller.connect()
                    await controller.stop_pairing(subnet)
                finally:
                    try:
                        await controller.disconnect()
                    except:
                        pass

            asyncio.run(do_stop())
            return jsonify({'status': 'ok', 'subnet': f"0x{subnet:04X}"})
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/pairing/pair', methods=['POST'])
    def api_pairing_pair():
        """Complete bridge pairing sequence for a device."""
        try:
            data = request.json or {}
            subnet = parse_hex(data.get('subnet', '0x2C90'))
            factory_id = parse_hex(data.get('factory_id', '0x0'))
            zone_suffix = parse_hex(data.get('zone_suffix', '0x8F'))

            async def do_pair():
                controller = ESP32Controller(current_esp_host)
                try:
                    await controller.connect()
                    await controller.pair_device(subnet, factory_id, zone_suffix)
                finally:
                    try:
                        await controller.disconnect()
                    except:
                        pass

            asyncio.run(do_pair())
            return jsonify({
                'status': 'ok',
                'subnet': f"0x{subnet:04X}",
                'factory_id': f"0x{factory_id:08X}",
                'zone': f"0x06{subnet:04X}{zone_suffix:02X}"
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/pairing/assign', methods=['POST'])
    def api_pairing_assign():
        """Send B0 pairing assignment packets only."""
        try:
            data = request.json or {}
            subnet = parse_hex(data.get('subnet', '0x2C90'))
            factory_id = parse_hex(data.get('factory_id', '0x0'))
            zone_suffix = parse_hex(data.get('zone_suffix', '0x8F'))

            async def do_assign():
                controller = ESP32Controller(current_esp_host)
                try:
                    await controller.connect()
                    await controller.send_pair_assignment(subnet, factory_id, zone_suffix)
                finally:
                    try:
                        await controller.disconnect()
                    except:
                        pass

            asyncio.run(do_assign())
            return jsonify({
                'status': 'ok',
                'subnet': f"0x{subnet:04X}",
                'factory_id': f"0x{factory_id:08X}",
                'zone': f"0x06{subnet:04X}{zone_suffix:02X}"
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/logs/stream')
    def api_logs_stream():
        """Stream ESP32 logs via Server-Sent Events."""
        global log_subscription_started, log_thread_heartbeat

        def generate():
            global log_subscription_started, log_thread_heartbeat

            # Send initial connection message
            yield f"data: {json.dumps({'time': datetime.now().isoformat(), 'level': 'I', 'msg': 'Connected to log stream'})}\n\n"

            # Start log subscription thread if needed
            with log_subscription_lock:
                now = time.time()
                thread_is_stale = (now - log_thread_heartbeat) > LOG_THREAD_TIMEOUT

                if not log_subscription_started or thread_is_stale:
                    if thread_is_stale and log_subscription_started:
                        print(f"[LOG STREAM] Log thread appears dead (no heartbeat for {now - log_thread_heartbeat:.0f}s), restarting...", flush=True)
                        # Clear the queue of stale messages
                        while not log_queue.empty():
                            try:
                                log_queue.get_nowait()
                            except queue.Empty:
                                break

                    log_subscription_started = True
                    log_thread_heartbeat = now
                    log_thread = threading.Thread(target=subscribe_to_logs, daemon=True)
                    log_thread.start()
                    yield f"data: {json.dumps({'time': datetime.now().isoformat(), 'level': 'I', 'msg': 'Starting ESP32 log subscription...'})}\n\n"

            # Stream logs from queue
            while True:
                try:
                    log_entry = log_queue.get(timeout=10)
                    yield f"data: {json.dumps(log_entry)}\n\n"
                except queue.Empty:
                    # Send heartbeat to keep connection alive
                    yield f"data: {json.dumps({'type': 'heartbeat', 'time': datetime.now().isoformat()})}\n\n"

        return Response(generate(), mimetype='text/event-stream',
                       headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

    @app.route('/api/packets/stream')
    def api_packets_stream():
        """Stream parsed packets via Server-Sent Events.

        Unlike /api/logs/stream which streams raw logs, this streams
        already-parsed packets with type, device_id, summary, details, and raw_hex.
        """
        def generate():
            # Initial connection
            yield f"data: {json.dumps({'type': 'connected', 'time': datetime.now().isoformat()})}\n\n"

            while True:
                try:
                    packet = packet_queue.get(timeout=10)
                    yield f"data: {json.dumps(packet)}\n\n"
                except queue.Empty:
                    # Heartbeat
                    yield f"data: {json.dumps({'type': 'heartbeat', 'time': datetime.now().isoformat()})}\n\n"

        return Response(generate(), mimetype='text/event-stream',
                       headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

    @app.route('/api/logs/status')
    def api_logs_status():
        """Get log subscription status."""
        now = time.time()
        heartbeat_age = now - log_thread_heartbeat if log_thread_heartbeat > 0 else -1
        last_log_age = now - log_last_received if log_last_received > 0 else -1
        thread_alive = heartbeat_age >= 0 and heartbeat_age < LOG_THREAD_TIMEOUT
        receiving_logs = last_log_age >= 0 and last_log_age < LOG_STALE_TIMEOUT
        return jsonify({
            'started': log_subscription_started,
            'heartbeat_age': round(heartbeat_age, 1),
            'last_log_age': round(last_log_age, 1),
            'thread_alive': thread_alive,
            'receiving_logs': receiving_logs,
            'healthy': thread_alive and receiving_logs
        })

    @app.route('/api/logs/restart', methods=['POST'])
    def api_logs_restart():
        """Force restart the log subscription thread."""
        global log_subscription_started, log_thread_heartbeat
        with log_subscription_lock:
            print("[API] Forcing log thread restart...", flush=True)
            log_subscription_started = False
            log_thread_heartbeat = 0
            # Clear queue
            while not log_queue.empty():
                try:
                    log_queue.get_nowait()
                except queue.Empty:
                    break
        return jsonify({'status': 'ok', 'message': 'Log subscription will restart on next stream connection'})

    def subscribe_to_logs():
        """Subscribe to ESP32 logs and push to queue. Runs forever with reconnect."""
        global log_subscription_started, log_thread_heartbeat, log_last_received
        print("[LOG THREAD] Starting subscribe_to_logs thread", flush=True)

        async def _subscribe():
            global log_subscription_started, log_thread_heartbeat, log_last_received
            print("[LOG THREAD] _subscribe async started", flush=True)

            while True:  # Reconnect loop
                # Update heartbeat
                log_thread_heartbeat = time.time()
                connection_stale = False

                host = current_esp_host
                print(f"[LOG THREAD] Connecting to {host}:{ESP32_PORT}...", flush=True)
                client = APIClient(
                    address=host,
                    port=ESP32_PORT,
                    password=ESP32_PASSWORD,
                    noise_psk=ESP32_ENCRYPTION_KEY,
                )
                try:
                    await asyncio.wait_for(client.connect(login=True), timeout=15.0)
                    print("[LOG THREAD] Connected successfully!", flush=True)
                    now = time.time()
                    log_thread_heartbeat = now
                    log_last_received = now  # Reset on new connection
                    log_queue.put_nowait({
                        'time': datetime.now().isoformat(),
                        'level': 'I',
                        'msg': 'Log subscription connected to ESP32',
                        'type': 'status',
                        'status': 'connected'
                    })

                    def on_log(msg):
                        global log_thread_heartbeat, log_last_received
                        try:
                            # Update timestamps on every log received
                            now = time.time()
                            log_thread_heartbeat = now
                            log_last_received = now
                            # msg.level is an int: 0=NONE, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG, 5=VERBOSE
                            level_map = {0: 'N', 1: 'E', 2: 'W', 3: 'I', 4: 'D', 5: 'V'}
                            level_int = msg.level if isinstance(msg.level, int) else 3
                            # msg.message may be bytes
                            message = msg.message if hasattr(msg, 'message') else str(msg)
                            if isinstance(message, bytes):
                                message = message.decode('utf-8', errors='replace')
                            # Strip ANSI escape codes (color codes from ESP32 logs)
                            message = re.sub(r'\x1b\[[0-9;]*m', '', message)

                            # Parse and store packets in database
                            _parse_and_store_packet(message)

                            log_queue.put_nowait({
                                'time': datetime.now().isoformat(),
                                'level': level_map.get(level_int, 'I'),
                                'msg': message
                            })
                        except queue.Full:
                            pass

                    # subscribe_logs returns an unsubscribe callback, not a coroutine
                    unsub = client.subscribe_logs(on_log, log_level=aioesphomeapi.LogLevel.LOG_LEVEL_DEBUG)

                    # Keep connection alive with periodic heartbeat and stale check
                    try:
                        while not connection_stale:
                            await asyncio.sleep(5)
                            log_thread_heartbeat = time.time()

                            # Check if connection is stale (no logs received)
                            stale_seconds = time.time() - log_last_received
                            if stale_seconds > LOG_STALE_TIMEOUT:
                                print(f"[LOG THREAD] Connection stale ({stale_seconds:.0f}s since last log), forcing reconnect", flush=True)
                                connection_stale = True
                                try:
                                    log_queue.put_nowait({
                                        'time': datetime.now().isoformat(),
                                        'level': 'W',
                                        'msg': f'Connection stale ({stale_seconds:.0f}s), reconnecting...',
                                        'type': 'status',
                                        'status': 'stale'
                                    })
                                except queue.Full:
                                    pass
                    finally:
                        unsub()

                except asyncio.TimeoutError:
                    print(f"[LOG THREAD] Connection timeout", flush=True)
                    try:
                        log_queue.put_nowait({
                            'time': datetime.now().isoformat(),
                            'level': 'E',
                            'msg': 'Connection timeout',
                            'type': 'status',
                            'status': 'timeout'
                        })
                    except queue.Full:
                        pass
                except Exception as e:
                    print(f"[LOG THREAD] Error: {e}", flush=True)
                    try:
                        log_queue.put_nowait({
                            'time': datetime.now().isoformat(),
                            'level': 'E',
                            'msg': f'Log subscription error: {e}',
                            'type': 'status',
                            'status': 'error'
                        })
                    except queue.Full:
                        pass
                finally:
                    try:
                        await asyncio.wait_for(client.disconnect(), timeout=5.0)
                    except:
                        pass

                # Send reconnecting status
                try:
                    log_queue.put_nowait({
                        'time': datetime.now().isoformat(),
                        'level': 'W',
                        'msg': 'Reconnecting to ESP32 in 3s...',
                        'type': 'status',
                        'status': 'reconnecting'
                    })
                except queue.Full:
                    pass

                # Wait before reconnecting (shorter delay)
                print("[LOG THREAD] Waiting 3s before reconnect...", flush=True)
                await asyncio.sleep(3)
                log_thread_heartbeat = time.time()

        try:
            asyncio.run(_subscribe())
        except Exception as e:
            print(f"[LOG THREAD] Fatal error, thread dying: {e}", flush=True)
        finally:
            # Reset flag so a new thread can be started
            print("[LOG THREAD] Thread exiting, resetting log_subscription_started", flush=True)
            log_subscription_started = False

    print(f"\n{'='*60}")
    print(f"  CCA Playground - Lutron Clear Connect Dashboard")
    print(f"{'='*60}")
    print(f"  Web UI:  http://localhost:{args.port}")
    print(f"  ESP32:   {ESP32_IP}")
    print(f"{'='*60}\n")

    app.run(host='0.0.0.0', port=args.port, debug=False, threaded=True)


# ═══════════════════════════════════════════════════════════════════════════════
# CLI COMMANDS
# ═══════════════════════════════════════════════════════════════════════════════

async def cmd_list(args):
    """List available buttons and switches."""
    controller = ESP32Controller()
    try:
        await controller.connect()
        buttons, switches = await controller.list_entities()

        print("\nAvailable buttons:")
        for btn in sorted(buttons, key=lambda x: x['name']):
            print(f"  {btn['object_id']:40s} - {btn['name']}")

        print("\nAvailable switches:")
        for sw in sorted(switches, key=lambda x: x['name']):
            print(f"  {sw['object_id']:40s} - {sw['name']}")
    finally:
        await controller.disconnect()


async def cmd_press(args):
    """Press a button."""
    button = args.button
    if button in BUTTONS:
        button = BUTTONS[button]

    controller = ESP32Controller()
    try:
        await controller.connect()
        await controller.press_button(button)
    finally:
        await controller.disconnect()


def parse_hex_or_int(value: str) -> int:
    """Parse hex (0x...) or decimal string to int."""
    value = value.strip()
    if value.lower().startswith('0x'):
        return int(value, 16)
    return int(value)


async def cmd_send(args):
    """Send button to any device."""
    device_id = parse_hex_or_int(args.device)
    button_code = parse_hex_or_int(args.button)

    controller = ESP32Controller()
    try:
        await controller.connect()
        await controller.send_button(device_id, button_code)
        print(f"Sent 0x{button_code:02X} to 0x{device_id:08X}")
    finally:
        await controller.disconnect()


async def cmd_pair(args):
    """Pair as 5-button Pico."""
    device_id = parse_hex_or_int(args.device)

    controller = ESP32Controller()
    try:
        await controller.connect()
        await controller.pair_pico(device_id)
        print(f"Paired 0x{device_id:08X} as 5-button Pico")
    finally:
        await controller.disconnect()


async def cmd_level(args):
    """Send level command."""
    source_id = parse_hex_or_int(args.source)
    target_id = parse_hex_or_int(args.target)

    controller = ESP32Controller()
    try:
        await controller.connect()
        await controller.send_level(source_id, target_id, args.level)
        print(f"Set 0x{target_id:08X} to {args.level}%")
    finally:
        await controller.disconnect()


def main():
    parser = argparse.ArgumentParser(
        description='CCA Playground - Lutron Clear Connect Controller',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    %(prog)s serve                         # Start web dashboard
    %(prog)s list                          # List available buttons
    %(prog)s send 0xCC110001 0x02          # Send ON to device
    %(prog)s pair 0xCC110001               # Pair as 5-button Pico
    %(prog)s level 0xAF902C00 0x06FDEFF4 50  # Set level to 50%%
"""
    )

    subparsers = parser.add_subparsers(dest='command', help='Commands')

    # Serve command
    serve_cmd = subparsers.add_parser('serve', aliases=['s'], help='Start web dashboard')
    serve_cmd.add_argument('--port', '-p', type=int, default=8080, help='Port (default: 8080)')

    # List command
    subparsers.add_parser('list', aliases=['ls'], help='List available buttons')

    # Press command
    press_cmd = subparsers.add_parser('press', aliases=['p'], help='Press a predefined button')
    press_cmd.add_argument('button', help='Button ID or alias')

    # Send command
    send_cmd = subparsers.add_parser('send', help='Send button to any device')
    send_cmd.add_argument('device', help='Device ID (hex or decimal)')
    send_cmd.add_argument('button', help='Button code (hex or decimal)')

    # Pair command
    pair_cmd = subparsers.add_parser('pair', help='Pair as 5-button Pico')
    pair_cmd.add_argument('device', help='Device ID (hex or decimal)')

    # Level command
    level_cmd = subparsers.add_parser('level', help='Send bridge level command')
    level_cmd.add_argument('source', help='Source/bridge ID')
    level_cmd.add_argument('target', help='Target device ID')
    level_cmd.add_argument('level', type=int, help='Level 0-100')

    # Logs command - stream logs to stdout
    logs_cmd = subparsers.add_parser('logs', aliases=['l'], help='Stream ESP32 logs to stdout')
    logs_cmd.add_argument('--host', '-H', default=ESP32_IP, help=f'ESP32 IP (default: {ESP32_IP})')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    if args.command in ['serve', 's']:
        cmd_serve(args)
    elif args.command in ['list', 'ls']:
        asyncio.run(cmd_list(args))
    elif args.command in ['press', 'p']:
        asyncio.run(cmd_press(args))
    elif args.command == 'send':
        asyncio.run(cmd_send(args))
    elif args.command == 'pair':
        asyncio.run(cmd_pair(args))
    elif args.command == 'level':
        asyncio.run(cmd_level(args))
    elif args.command in ['logs', 'l']:
        asyncio.run(cmd_logs(args))

    return 0


async def cmd_logs(args):
    """Stream ESP32 logs to stdout."""
    import sys
    host = args.host
    print(f"Connecting to {host}:{ESP32_PORT}...", file=sys.stderr)

    client = APIClient(
        host,
        ESP32_PORT,
        ESP32_PASSWORD,
        noise_psk=ESP32_ENCRYPTION_KEY
    )

    try:
        await client.connect(login=True)
        print(f"Connected. Streaming logs (Ctrl+C to stop)...", file=sys.stderr)

        def on_log(msg):
            level_map = {0: 'N', 1: 'E', 2: 'W', 3: 'I', 4: 'D', 5: 'V'}
            level_int = msg.level if isinstance(msg.level, int) else 3
            level = level_map.get(level_int, 'I')

            message = msg.message if hasattr(msg, 'message') else str(msg)
            if isinstance(message, bytes):
                message = message.decode('utf-8', errors='replace')
            # Strip ANSI escape codes
            message = re.sub(r'\x1b\[[0-9;]*m', '', message)

            timestamp = datetime.now().strftime('%H:%M:%S')
            print(f"{timestamp} [{level}] {message}", flush=True)

        client.subscribe_logs(on_log, log_level=aioesphomeapi.LogLevel.LOG_LEVEL_DEBUG)

        # Keep running
        while True:
            await asyncio.sleep(1)

    except KeyboardInterrupt:
        print("\nDisconnecting...", file=sys.stderr)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        await client.disconnect()


if __name__ == '__main__':
    sys.exit(main())
