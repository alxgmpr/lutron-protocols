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


# Regex patterns for parsing ESP32 logs
RX_PATTERN = re.compile(r'RX:\s+(\S+)\s+\|\s*(.+)')
TX_PATTERN = re.compile(r'TX\s+(\d+)\s+bytes:\s*([A-F0-9]{2}(?:\s+[A-F0-9]{2})+)', re.IGNORECASE)
BYTES_PATTERN = re.compile(r'Bytes:\s*([A-F0-9]{2}(?:\s+[A-F0-9]{2})+)', re.IGNORECASE)
RSSI_PATTERN = re.compile(r'RSSI=(-?\d+)')

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

    # Store in database
    db.insert_decoded_packet(
        direction='rx',
        packet_type=pkt_data.get('packet_type', 'UNKNOWN'),
        timestamp=pkt_data.get('timestamp', datetime.now().isoformat()),
        raw_hex=raw_hex,
        device_id=pkt_data.get('device_id'),
        source_id=pkt_data.get('source_id'),
        target_id=pkt_data.get('target_id'),
        level=pkt_data.get('level'),
        button=pkt_data.get('button'),
        rssi=pkt_data.get('rssi'),
        decoded_data=pkt_data.get('decoded_data')
    )

    # Push to packet queue for SSE streaming
    try:
        timestamp = pkt_data.get('timestamp', '')
        packet_queue.put_nowait({
            'direction': 'rx',
            'type': pkt_data.get('packet_type', 'UNKNOWN'),
            'time': timestamp.split('T')[1].split('.')[0] if 'T' in timestamp else timestamp[-8:],
            'device_id': pkt_data.get('device_id'),
            'source_id': pkt_data.get('source_id'),
            'target_id': pkt_data.get('target_id'),
            'summary': f"{pkt_data.get('source_id')} -> {pkt_data.get('target_id')}" if pkt_data.get('source_id') and pkt_data.get('target_id') else pkt_data.get('device_id') or '',
            'details': pkt_data.get('decoded_data', {}),
            'raw_hex': raw_hex,
            'rssi': pkt_data.get('rssi')
        })
    except queue.Full:
        pass

    # Update device registry
    device_id = pkt_data.get('device_id')
    packet_type = pkt_data.get('packet_type', '')
    if device_id and re.match(r'^[0-9A-Fa-f]{8}$', device_id):
        category = _infer_category_from_type(packet_type, pkt_data.get('button'))
        # Determine ID format based on packet type:
        # - STATE_RPT/LEVEL: little-endian, contains subnet
        # - BTN_*/PAIRING: big-endian, matches printed label
        id_format = 'subnet' if packet_type in ('STATE_RPT', 'LEVEL') else 'label'
        decoded_data = pkt_data.get('decoded_data', {})
        decoded_data['id_format'] = id_format
        decoded_data['packet_type'] = packet_type

        # Extract subnet from subnet-style device IDs
        # Device ID format for subnet-style: [Zone][SubnetLo][SubnetHi][Endpoint]
        # Subnet displayed big-endian (as in Lutron Designer): SubnetHi + SubnetLo
        if id_format == 'subnet' and len(device_id) == 8:
            subnet_lo = device_id[2:4]  # bytes 1
            subnet_hi = device_id[4:6]  # bytes 2
            subnet = (subnet_hi + subnet_lo).upper()  # Big-endian for display
            decoded_data['subnet'] = subnet

        db.upsert_device(
            device_id=device_id,
            category=category,
            bridge_id=pkt_data.get('source_id') if packet_type == 'LEVEL' else None,
            factory_id=pkt_data.get('target_id') if packet_type == 'LEVEL' else device_id,
            info=decoded_data
        )

def _parse_and_store_packet(message: str):
    """Parse a log message and store any packets in the database.

    RX packets come in two log lines:
      1. RX: TYPE | DEVICE_ID | ... | RSSI=X | CRC=ok
      2.   Bytes: XX XX XX ...

    TX packets come in one line:
      TX N bytes: XX XX XX ...
    """
    global pending_rx_packet
    try:
        timestamp = datetime.now().isoformat()

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

        # Parse RX packets: "RX: LEVEL | AF902C00 -> 002C90AF | Level=50%"
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

        # Parse TX packets: "TX 23 bytes: 81 00 01 ..."
        tx_match = TX_PATTERN.search(message)
        if tx_match:
            raw_hex = tx_match.group(2)
            bytes_list = raw_hex.split()

            # Decode based on first byte
            pkt_type_byte = bytes_list[0].upper() if bytes_list else '??'
            pkt_type = 'TX'
            device_id = None
            source_id = None
            target_id = None
            level = None
            decoded_data = {}

            if pkt_type_byte in ('81', '82', '83'):
                pkt_type = 'LEVEL'
                if len(bytes_list) >= 13:
                    source_id = f"{bytes_list[5]}{bytes_list[4]}{bytes_list[3]}{bytes_list[2]}".upper()
                    target_id = f"{bytes_list[9]}{bytes_list[10]}{bytes_list[11]}{bytes_list[12]}".upper()
                    device_id = target_id
                    decoded_data['source'] = source_id
                    decoded_data['target'] = target_id
                if len(bytes_list) >= 18:
                    level_raw = int(bytes_list[16] + bytes_list[17], 16)
                    level = 0 if level_raw == 0 else round((level_raw * 100) / 65279)
                    decoded_data['level'] = str(level)
            elif pkt_type_byte in ('B9', 'BA', 'BB', 'B8'):
                pkt_type = f'PAIR_{pkt_type_byte}'
                if len(bytes_list) >= 6:
                    device_id = f"{bytes_list[5]}{bytes_list[4]}{bytes_list[3]}{bytes_list[2]}".upper()
                    decoded_data['seq'] = str(int(bytes_list[1], 16))
            elif pkt_type_byte in ('02', '03', '04', '05', '06'):
                pkt_type = 'BUTTON'
                btn_names = {'02': 'ON', '03': 'FAV', '04': 'OFF', '05': 'RAISE', '06': 'LOWER'}
                if len(bytes_list) >= 6:
                    device_id = f"{bytes_list[5]}{bytes_list[4]}{bytes_list[3]}{bytes_list[2]}".upper()
                    decoded_data['button'] = btn_names.get(pkt_type_byte, f'0x{pkt_type_byte}')
            elif pkt_type_byte in ('91', '92', '93'):
                pkt_type = 'BEACON'
                if len(bytes_list) >= 6:
                    device_id = f"{bytes_list[5]}{bytes_list[4]}{bytes_list[3]}{bytes_list[2]}".upper()
            elif pkt_type_byte == '89':
                pkt_type = 'RESET'
                if len(bytes_list) >= 6:
                    device_id = f"{bytes_list[5]}{bytes_list[4]}{bytes_list[3]}{bytes_list[2]}".upper()

            # Register device_id for echo detection
            if device_id:
                _register_tx_device(device_id)
            if source_id and source_id != device_id:
                _register_tx_device(source_id)

            db.insert_decoded_packet(
                direction='tx',
                packet_type=pkt_type,
                timestamp=timestamp,
                raw_hex=raw_hex,
                device_id=device_id,
                source_id=source_id,
                target_id=target_id,
                level=level,
                decoded_data=decoded_data
            )

            # Push to packet queue for SSE streaming
            try:
                packet_queue.put_nowait({
                    'direction': 'tx',
                    'type': pkt_type,
                    'time': timestamp.split('T')[1].split('.')[0] if 'T' in timestamp else timestamp[-8:],
                    'device_id': device_id,
                    'source_id': source_id,
                    'target_id': target_id,
                    'summary': f"{source_id} -> {target_id}" if source_id and target_id else device_id or '',
                    'details': decoded_data,
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
        from flask import Flask, jsonify, request, Response, send_from_directory
    except ImportError:
        print("Error: Flask not installed. Run: pip install flask")
        sys.exit(1)

    app = Flask(__name__, static_folder='web/dist', static_url_path='')

    # CORS headers for development (Vite dev server runs on different port)
    @app.after_request
    def add_cors_headers(response):
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return response

    @app.route('/api/health')
    def health():
        return jsonify({'status': 'ok'})

    # Serve React app (production build)
    @app.route('/')
    def index():
        web_dist = os.path.join(os.path.dirname(__file__), 'web', 'dist')
        if os.path.exists(os.path.join(web_dist, 'index.html')):
            return send_from_directory(web_dist, 'index.html')
        return '''<!DOCTYPE html>
<html>
<head><title>CCA Playground</title></head>
<body style="background:#0a0c10;color:#e6edf3;font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
<div style="text-align:center;">
<h1 style="color:#3b82f6;">CCA Playground API Server</h1>
<p style="color:#9ca3af;">Frontend not built. Run:</p>
<pre style="background:#12161c;padding:20px;border-radius:8px;margin-top:20px;color:#22c55e;">cd rf/web && npm install && npm run build</pre>
<p style="color:#9ca3af;margin-top:20px;">Or for development:</p>
<pre style="background:#12161c;padding:20px;border-radius:8px;margin-top:10px;color:#22c55e;">cd rf/web && npm install && npm run dev</pre>
<p style="color:#6b7280;margin-top:10px;font-size:14px;">Then open http://localhost:5173</p>
</div>
</body>
</html>'''

    # Serve static assets from Vite build
    @app.route('/assets/<path:filename>')
    def serve_assets(filename):
        web_dist = os.path.join(os.path.dirname(__file__), 'web', 'dist', 'assets')
        return send_from_directory(web_dist, filename)

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
        - device: device ID to filter
        - limit: max results (default 100)
        - offset: pagination offset
        """
        direction = request.args.get('direction')
        packet_type = request.args.get('type')
        device_id = request.args.get('device')
        limit = int(request.args.get('limit', 100))
        offset = int(request.args.get('offset', 0))

        packets = db.get_decoded_packets(
            direction=direction,
            packet_type=packet_type,
            device_id=device_id,
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

    return 0


if __name__ == '__main__':
    sys.exit(main())
