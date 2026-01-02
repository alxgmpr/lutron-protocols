#!/usr/bin/env python3
"""
ESP32 Lutron RF Controller

Controls the ESP32 CC1101 RF transmitter via ESPHome native API.
Replaces the web_server component to save ESP32 memory.

Usage:
    # List available buttons
    python esp32_controller.py list

    # Press a button
    python esp32_controller.py press rf-on
    python esp32_controller.py press level-100-af902c00

    # Start local web server (optional)
    python esp32_controller.py serve --port 8080

Requirements:
    pip install aioesphomeapi

Connection:
    IP: 10.1.4.59
    Encryption key from YAML
"""

import asyncio
import argparse
import sys
from typing import Optional

try:
    import aioesphomeapi
    from aioesphomeapi import APIClient
except ImportError:
    print("Error: aioesphomeapi not installed")
    print("Run: pip install aioesphomeapi")
    sys.exit(1)

# ESP32 connection settings
ESP32_IP = "10.1.4.59"
ESP32_PORT = 6053
ESP32_PASSWORD = ""  # No password, just encryption key
ESP32_ENCRYPTION_KEY = "EixuPCx/wLtc5a55a/16gNEubH7qiZWFhn7LR98qQU8="

# Button ID mappings (ESPHome converts names to IDs)
# Format: user-friendly alias -> ESPHome object_id (from list command)
BUTTONS = {
    # Pico-style buttons for device 05851117
    "rf-on": "rf_on__pico_",
    "rf-off": "rf_off__pico_",
    "rf-raise": "rf_raise__pico_",
    "rf-lower": "rf_lower__pico_",
    "rf-favorite": "rf_favorite__pico_",

    # FAKE PICO (CC110001) - our ESP32's virtual Scene Pico
    # Uses Scene Pico button codes: 0x08=ON, 0x09=BTN2, 0x0A=BTN3, 0x0B=OFF
    "fake-on": "fake_pico_on__cc110001_",
    "fake-off": "fake_pico_off__cc110001_",
    "fake-btn2": "fake_pico_btn2__cc110001_",
    "fake-btn3": "fake_pico_btn3__cc110001_",

    # Bridge-style level commands for device AF902C00
    "level-0": "level_0___af902c00_",
    "level-25": "level_25___af902c00_",
    "level-50": "level_50___af902c00_",
    "level-75": "level_75___af902c00_",
    "level-100": "level_100___af902c00_",

    # Pairing
    "pair-b9": "pair__0xb9_",
    "pair-esp32": "pair_esp32__b9_",
    "pair-pico": "pair_pico-style__bb_",  # Pico-style BA/BB pairing
    "test-pkt": "test_pkt",

    # Scene Pico 084b1ebb
    "bright": "bright__084b1ebb_",
    "entertain": "entertain__084b1ebb_",
    "relax": "relax__084b1ebb_",
    "off-084b1ebb": "off__084b1ebb_",

    # Beacon
    "beacon": "beacon__pairing_mode_",
    "beacon-5s": "beacon_5s",
    "beacon-91": "beacon_0x91",
    "beacon-93": "beacon_0x93",

    # ESP32 as Bridge (load ID AF902C01)
    "esp32-beacon": "esp32_beacon__af902c01_",
    "esp32-pair": "esp32_pair_06fdeff4",
    "esp32-100": "esp32_level_100___06fdeff4_",
    "esp32-0": "esp32_level_0___06fdeff4_",

    # Bridge level commands for dimmer 06fdeff4
    "bridge-100": "bridge_level_100___06fdeff4_",
    "bridge-50": "bridge_level_50___06fdeff4_",
    "bridge-0": "bridge_level_0___06fdeff4_",

    # Bridge level commands for dimmer 07004e8c
    "bridge2-100": "bridge2_level_100___07004e8c_",
    "bridge2-50": "bridge2_level_50___07004e8c_",
    "bridge2-0": "bridge2_level_0___07004e8c_",

    # 4-button Pico 08692d70 (ON/OFF/RAISE/LOWER)
    "pico2-on": "pico2_on__08692d70_",
    "pico2-off": "pico2_off__08692d70_",
    "pico2-raise": "pico2_raise__08692d70_",
    "pico2-lower": "pico2_lower__08692d70_",

    # Debug
    "debug-pattern": "debug_pattern",

    # Fake state reports
    "fake-0": "fake_state_0___8f902c08_",
    "fake-50": "fake_state_50___8f902c08_",
    "fake-100": "fake_state_100___8f902c08_",
}

# Switch aliases
SWITCHES = {
    "beacon": "esp32_beacon_mode",
}


class ESP32Controller:
    """Controller for ESP32 Lutron RF transmitter via native API."""

    def __init__(self, host: str = ESP32_IP, port: int = ESP32_PORT):
        self.host = host
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
        print(f"Connected to ESP32 at {self.host}")

        # Get device info
        device_info = await self.client.device_info()
        print(f"Device: {device_info.friendly_name} ({device_info.name})")

    async def disconnect(self):
        """Disconnect from ESP32."""
        if self.client:
            await self.client.disconnect()

    async def list_entities(self):
        """List all button, switch entities and services."""
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

        # Store services for dynamic calling
        for svc in services:
            self._services[svc.name] = svc

        return buttons, switches

    async def call_service(self, service_name: str, **kwargs):
        """Call an ESPHome user-defined service with parameters."""
        # Get services if not cached
        if not self._services:
            await self.list_entities()

        if service_name not in self._services:
            raise ValueError(f"Service not found: {service_name}. Available: {list(self._services.keys())}")

        svc = self._services[service_name]
        print(f"Calling service: {service_name} with {kwargs}")

        # Execute the service (async method)
        await self.client.execute_service(svc, kwargs)

    async def send_button(self, device_id: int, button_code: int):
        """Send a button press via dynamic service."""
        # Pass device_id as hex string to support full 32-bit unsigned range
        await self.call_service('send_button', device_id=f"0x{device_id:08X}", button_code=button_code)
        print(f"Sent button 0x{button_code:02X} to device 0x{device_id:08X}")

    async def send_pairing(self, device_id: int, duration: int = 6):
        """Send pairing sequence via dynamic service."""
        await self.call_service('send_pairing', device_id=f"0x{device_id:08X}", duration_seconds=duration)
        print(f"Pairing device 0x{device_id:08X} for {duration}s")

    async def send_level(self, source_id: int, target_id: int, level: int):
        """Send level command via dynamic service."""
        await self.call_service('send_level', source_id=f"0x{source_id:08X}", target_id=f"0x{target_id:08X}", level_percent=level)
        print(f"Set level {level}% on target 0x{target_id:08X}")

    async def press_button(self, button_id: str):
        """Press a button by ID."""
        # Get entities if not cached
        if not self._entities:
            await self.list_entities()

        # Look up the entity key
        entity_info = None
        if button_id in self._entities:
            entity_info = self._entities[button_id]
        else:
            # Try to find by partial match
            for obj_id, info in self._entities.items():
                if button_id.lower() in obj_id.lower():
                    entity_info = info
                    break

        if entity_info is None:
            raise ValueError(f"Button not found: {button_id}")

        entity_type, key = entity_info
        if entity_type != 'button':
            raise ValueError(f"{button_id} is a {entity_type}, not a button")

        # Press the button
        self.client.button_command(key)
        print(f"Pressed: {button_id}")

    async def set_switch(self, switch_id: str, state: bool):
        """Set a switch on or off."""
        # Get entities if not cached
        if not self._entities:
            await self.list_entities()

        # Look up the entity key
        entity_info = None
        if switch_id in self._entities:
            entity_info = self._entities[switch_id]
        else:
            # Try to find by partial match
            for obj_id, info in self._entities.items():
                if switch_id.lower() in obj_id.lower():
                    entity_info = info
                    break

        if entity_info is None:
            raise ValueError(f"Switch not found: {switch_id}")

        entity_type, key = entity_info
        if entity_type != 'switch':
            raise ValueError(f"{switch_id} is a {entity_type}, not a switch")

        # Set the switch
        self.client.switch_command(key, state)
        print(f"Switch {switch_id}: {'ON' if state else 'OFF'}")


async def cmd_list(args):
    """List available buttons and switches."""
    controller = ESP32Controller()
    try:
        await controller.connect()
        buttons, switches = await controller.list_entities()

        print("\nAvailable buttons:")
        print("-" * 60)
        for btn in sorted(buttons, key=lambda x: x['name']):
            print(f"  {btn['object_id']:40s} - {btn['name']}")

        print("\nAvailable switches:")
        print("-" * 60)
        for sw in sorted(switches, key=lambda x: x['name']):
            print(f"  {sw['object_id']:40s} - {sw['name']}")

        print("\nButton aliases:")
        print("-" * 60)
        for alias, entity_id in sorted(BUTTONS.items()):
            print(f"  {alias:20s} -> {entity_id}")

        print("\nSwitch aliases:")
        print("-" * 60)
        for alias, entity_id in sorted(SWITCHES.items()):
            print(f"  {alias:20s} -> {entity_id}")

    finally:
        await controller.disconnect()


async def cmd_press(args):
    """Press a button."""
    button = args.button

    # Check if it's an alias
    if button in BUTTONS:
        button = BUTTONS[button].replace("button.", "")

    controller = ESP32Controller()
    try:
        await controller.connect()
        await controller.press_button(button)
    finally:
        await controller.disconnect()


async def cmd_switch(args):
    """Turn a switch on or off."""
    switch = args.switch
    state = args.state.lower() in ('on', '1', 'true', 'yes')

    # Check if it's an alias
    if switch in SWITCHES:
        switch = SWITCHES[switch]

    controller = ESP32Controller()
    try:
        await controller.connect()
        await controller.set_switch(switch, state)
    finally:
        await controller.disconnect()


def cmd_serve(args):
    """Start local web server."""
    try:
        from flask import Flask, jsonify, request
    except ImportError:
        print("Error: Flask not installed")
        print("Run: pip install flask")
        sys.exit(1)

    app = Flask(__name__)

    @app.route('/')
    def index():
        """Simple web UI."""
        html = """
<!DOCTYPE html>
<html>
<head>
    <title>Lutron RF Controller</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; }
        h1 { color: #333; }
        .section { margin: 20px 0; padding: 15px; background: #f5f5f5; border-radius: 8px; }
        .section h2 { margin-top: 0; font-size: 16px; color: #666; }
        button { padding: 10px 20px; margin: 5px; font-size: 14px; cursor: pointer; border: none; border-radius: 4px; background: #007bff; color: white; }
        button:hover { background: #0056b3; }
        button.off { background: #dc3545; }
        button.off:hover { background: #c82333; }
        button.dim { background: #6c757d; }
        button.dim:hover { background: #545b62; }
        button.pair { background: #28a745; }
        button.pair:hover { background: #1e7e34; }
        #status { margin-top: 20px; padding: 10px; background: #e9ecef; border-radius: 4px; }
        .custom-section { background: #fff3cd; }
        .custom-section input { padding: 8px; margin: 5px; width: 120px; font-family: monospace; }
        .custom-section select { padding: 8px; margin: 5px; }
    </style>
</head>
<body>
    <h1>Lutron RF Controller</h1>

    <!-- FAKE PICO - Our ESP32's virtual Scene Pico -->
    <div class="section" style="background: #d4edda;">
        <h2>ESP32 Virtual Pico (CC110001) - PAIR FIRST!</h2>
        <button onclick="press('pair-pico')" class="pair">PAIR (6s)</button>
        <span style="margin: 0 10px;">|</span>
        <button onclick="press('fake-on')">ON (0x08)</button>
        <button onclick="press('fake-off')" class="off">OFF (0x0B)</button>
        <button onclick="press('fake-btn2')" class="dim">BTN2 (0x09)</button>
        <button onclick="press('fake-btn3')" class="dim">BTN3 (0x0A)</button>
    </div>

    <!-- Dynamic Commands - Works with ANY device ID -->
    <div class="section custom-section">
        <h2>Dynamic Commands (any device ID)</h2>
        <div style="margin-bottom: 10px;">
            <label>Device ID:</label>
            <input type="text" id="custom-device" placeholder="0xCC110001" value="0xCC110001" style="width: 140px;">
        </div>
        <div style="margin-bottom: 10px;">
            <label>Button:</label>
            <select id="custom-button">
                <option value="0x02">ON (0x02) - 5btn</option>
                <option value="0x03">FAV (0x03) - 5btn</option>
                <option value="0x04">OFF (0x04) - 5btn</option>
                <option value="0x05">RAISE (0x05) - 5btn</option>
                <option value="0x06">LOWER (0x06) - 5btn</option>
                <option value="0x08">BTN1 (0x08) - Scene/4btn</option>
                <option value="0x09">BTN2 (0x09) - Scene/4btn</option>
                <option value="0x0A">BTN3 (0x0A) - Scene/4btn</option>
                <option value="0x0B">BTN4 (0x0B) - Scene/4btn</option>
            </select>
            <input type="text" id="custom-button-raw" placeholder="or hex: 0x02" style="width: 100px;">
            <button onclick="sendCustomButton()">SEND BUTTON</button>
        </div>
        <div style="margin-bottom: 10px;">
            <label>Pairing:</label>
            <input type="number" id="pair-duration" value="6" min="1" max="30" style="width: 50px;"> seconds
            <button onclick="sendCustomPair()" class="pair">PAIR DEVICE</button>
        </div>
    </div>

    <!-- Bridge-style Level Commands -->
    <div class="section" style="background: #e7f3ff;">
        <h2>Bridge-Style Level (direct dimmer control)</h2>
        <div style="margin-bottom: 10px;">
            <label>Source ID:</label>
            <input type="text" id="level-source" placeholder="0xAF902C00" value="0xAF902C00" style="width: 140px;">
            <label>Target ID:</label>
            <input type="text" id="level-target" placeholder="0x06FDEFF4" value="0x06FDEFF4" style="width: 140px;">
        </div>
        <div>
            <button onclick="sendLevel(0)" class="off">0%</button>
            <button onclick="sendLevel(25)" class="dim">25%</button>
            <button onclick="sendLevel(50)" class="dim">50%</button>
            <button onclick="sendLevel(75)">75%</button>
            <button onclick="sendLevel(100)">100%</button>
            <input type="number" id="level-custom" value="50" min="0" max="100" style="width: 50px;">
            <button onclick="sendLevel(document.getElementById('level-custom').value)">SET</button>
        </div>
    </div>

    <div class="section">
        <h2>Real Pico Buttons (05851117)</h2>
        <button onclick="press('rf-on')">ON</button>
        <button onclick="press('rf-off')" class="off">OFF</button>
        <button onclick="press('rf-raise')" class="dim">RAISE</button>
        <button onclick="press('rf-lower')" class="dim">LOWER</button>
        <button onclick="press('rf-favorite')">FAVORITE</button>
    </div>

    <div class="section">
        <h2>Level Commands (AF902C00)</h2>
        <button onclick="press('level-0')" class="off">0%</button>
        <button onclick="press('level-25')" class="dim">25%</button>
        <button onclick="press('level-50')" class="dim">50%</button>
        <button onclick="press('level-75')">75%</button>
        <button onclick="press('level-100')">100%</button>
    </div>

    <div class="section">
        <h2>Bridge Level (06fdeff4)</h2>
        <button onclick="press('bridge-0')" class="off">0%</button>
        <button onclick="press('bridge-50')" class="dim">50%</button>
        <button onclick="press('bridge-100')">100%</button>
    </div>

    <div class="section">
        <h2>Scene Pico (084b1ebb)</h2>
        <button onclick="press('bright')">BRIGHT</button>
        <button onclick="press('entertain')">ENTERTAIN</button>
        <button onclick="press('relax')">RELAX</button>
        <button onclick="press('off-084b1ebb')" class="off">OFF</button>
    </div>

    <div class="section">
        <h2>4-Button Pico (08692d70)</h2>
        <button onclick="press('pico2-on')">ON</button>
        <button onclick="press('pico2-off')" class="off">OFF</button>
        <button onclick="press('pico2-raise')" class="dim">RAISE</button>
        <button onclick="press('pico2-lower')" class="dim">LOWER</button>
    </div>

    <div id="status">Ready</div>

    <script>
        async function press(button) {
            const status = document.getElementById('status');
            status.textContent = `Pressing ${button}...`;
            try {
                const resp = await fetch(`/button/${button}/press`, {method: 'POST'});
                const data = await resp.json();
                status.textContent = data.status === 'ok' ? `Pressed: ${button}` : `Error: ${data.error}`;
            } catch (e) {
                status.textContent = `Error: ${e.message}`;
            }
        }

        async function sendCustomButton() {
            const deviceId = document.getElementById('custom-device').value.trim();
            // Use raw input if provided, otherwise use dropdown
            const rawBtn = document.getElementById('custom-button-raw').value.trim();
            const button = rawBtn || document.getElementById('custom-button').value;
            const status = document.getElementById('status');
            status.textContent = `Sending button ${button} to ${deviceId}...`;
            try {
                const resp = await fetch(`/api/send?device=${encodeURIComponent(deviceId)}&button=${encodeURIComponent(button)}`, {method: 'POST'});
                const data = await resp.json();
                status.textContent = data.status === 'ok' ? `Sent: ${data.button} to ${data.device}` : `Error: ${data.error}`;
            } catch (e) {
                status.textContent = `Error: ${e.message}`;
            }
        }

        async function sendCustomPair() {
            const deviceId = document.getElementById('custom-device').value.trim();
            const duration = document.getElementById('pair-duration').value || '6';
            const status = document.getElementById('status');
            status.textContent = `Pairing ${deviceId} for ${duration}s...`;
            try {
                const resp = await fetch(`/api/pair?device=${encodeURIComponent(deviceId)}&duration=${duration}`, {method: 'POST'});
                const data = await resp.json();
                status.textContent = data.status === 'ok' ? `Pairing ${data.device} (${data.duration}s)` : `Error: ${data.error}`;
            } catch (e) {
                status.textContent = `Error: ${e.message}`;
            }
        }

        async function sendLevel(level) {
            const source = document.getElementById('level-source').value.trim();
            const target = document.getElementById('level-target').value.trim();
            const status = document.getElementById('status');
            status.textContent = `Setting ${target} to ${level}%...`;
            try {
                const resp = await fetch(`/api/level?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}&level=${level}`, {method: 'POST'});
                const data = await resp.json();
                status.textContent = data.status === 'ok' ? `Set ${data.target} to ${data.level}%` : `Error: ${data.error}`;
            } catch (e) {
                status.textContent = `Error: ${e.message}`;
            }
        }
    </script>
</body>
</html>
"""
        return html

    @app.route('/button/<button_id>/press', methods=['POST'])
    def press_button(button_id):
        """Press a button via API."""
        try:
            # Run async press in sync context
            asyncio.run(press_async(button_id))
            return jsonify({'status': 'ok', 'button': button_id})
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    async def press_async(button_id):
        # Check if it's an alias
        if button_id in BUTTONS:
            button_id = BUTTONS[button_id].replace("button.", "")

        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.press_button(button_id)
        finally:
            await controller.disconnect()

    @app.route('/buttons', methods=['GET'])
    def list_buttons():
        """List available buttons."""
        return jsonify(BUTTONS)

    def parse_hex_int(value: str) -> int:
        """Parse hex (0x...) or decimal string to int."""
        value = value.strip()
        if value.lower().startswith('0x'):
            return int(value, 16)
        return int(value)

    async def send_button_async(device_id: int, button_code: int):
        """Send button via ESPHome service."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_button(device_id, button_code)
        finally:
            await controller.disconnect()

    async def send_pairing_async(device_id: int, duration: int):
        """Send pairing via ESPHome service."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_pairing(device_id, duration)
        finally:
            await controller.disconnect()

    async def send_level_async(source_id: int, target_id: int, level: int):
        """Send level via ESPHome service."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_level(source_id, target_id, level)
        finally:
            await controller.disconnect()

    @app.route('/api/send', methods=['POST'])
    def api_send():
        """Send dynamic button command to any device ID."""
        try:
            device = request.args.get('device', '')
            button = request.args.get('button', '')

            if not device or not button:
                return jsonify({'status': 'error', 'error': 'Missing device or button parameter'}), 400

            device_id = parse_hex_int(device)
            button_code = parse_hex_int(button)

            asyncio.run(send_button_async(device_id, button_code))
            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'button': f'0x{button_code:02X}'
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/pair', methods=['POST'])
    def api_pair():
        """Send pairing sequence to any device ID."""
        try:
            device = request.args.get('device', '')
            duration = int(request.args.get('duration', '6'))

            if not device:
                return jsonify({'status': 'error', 'error': 'Missing device parameter'}), 400

            device_id = parse_hex_int(device)

            asyncio.run(send_pairing_async(device_id, duration))
            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'duration': duration
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/level', methods=['POST'])
    def api_level():
        """Send level command to any device."""
        try:
            source = request.args.get('source', '')
            target = request.args.get('target', '')
            level = int(request.args.get('level', '0'))

            if not source or not target:
                return jsonify({'status': 'error', 'error': 'Missing source or target parameter'}), 400

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

    print(f"Starting web server on http://localhost:{args.port}")
    print(f"Proxying to ESP32 at {ESP32_IP}")
    print("Press Ctrl+C to stop\n")

    app.run(host='0.0.0.0', port=args.port, debug=False)


def parse_hex_or_int(value: str) -> int:
    """Parse a value as hex (0x prefix) or decimal."""
    value = value.strip()
    if value.lower().startswith('0x'):
        return int(value, 16)
    return int(value)


async def cmd_send(args):
    """Send dynamic button command."""
    device_id = parse_hex_or_int(args.device)
    button_code = parse_hex_or_int(args.button)

    controller = ESP32Controller()
    try:
        await controller.connect()
        await controller.send_button(device_id, button_code)
    finally:
        await controller.disconnect()


async def cmd_pair(args):
    """Send dynamic pairing command."""
    device_id = parse_hex_or_int(args.device)
    duration = args.duration

    controller = ESP32Controller()
    try:
        await controller.connect()
        await controller.send_pairing(device_id, duration)
    finally:
        await controller.disconnect()


async def cmd_level(args):
    """Send dynamic level command."""
    source_id = parse_hex_or_int(args.source)
    target_id = parse_hex_or_int(args.target)
    level = args.level

    controller = ESP32Controller()
    try:
        await controller.connect()
        await controller.send_level(source_id, target_id, level)
    finally:
        await controller.disconnect()


def main():
    parser = argparse.ArgumentParser(
        description='Control ESP32 Lutron RF transmitter via native API',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    %(prog)s list                           # List available buttons/switches
    %(prog)s press rf-on                    # Press RF On button
    %(prog)s send 0xCC110001 0x02           # Send button 0x02 to device CC110001
    %(prog)s send CC110001 2                # Same (decimal)
    %(prog)s pair 0xCC110001                # Pair device CC110001 (6s default)
    %(prog)s pair 0xCC110001 -d 10          # Pair for 10 seconds
    %(prog)s level 0xAF902C00 0x06FDEFF4 50 # Set dimmer to 50%%
    %(prog)s serve --port 8080              # Start web server on port 8080
"""
    )

    subparsers = parser.add_subparsers(dest='command', help='Commands')

    # List command
    list_cmd = subparsers.add_parser('list', aliases=['ls'], help='List available buttons/switches')

    # Press command (legacy - uses predefined buttons)
    press_cmd = subparsers.add_parser('press', aliases=['p'], help='Press a predefined button')
    press_cmd.add_argument('button', help='Button ID or alias')

    # Send command (NEW - dynamic device/button)
    send_cmd = subparsers.add_parser('send', help='Send button to any device (dynamic)')
    send_cmd.add_argument('device', help='Device ID (hex 0x... or decimal)')
    send_cmd.add_argument('button', help='Button code (hex 0x... or decimal)')

    # Pair command (NEW - dynamic pairing)
    pair_cmd = subparsers.add_parser('pair', help='Send pairing sequence to any device')
    pair_cmd.add_argument('device', help='Device ID (hex 0x... or decimal)')
    pair_cmd.add_argument('-d', '--duration', type=int, default=6, help='Duration in seconds (default: 6)')

    # Level command (NEW - dynamic level)
    level_cmd = subparsers.add_parser('level', help='Send level command (bridge-style)')
    level_cmd.add_argument('source', help='Source/bridge ID (hex or decimal)')
    level_cmd.add_argument('target', help='Target dimmer ID (hex or decimal)')
    level_cmd.add_argument('level', type=int, help='Level 0-100')

    # Switch command
    switch_cmd = subparsers.add_parser('switch', aliases=['sw'], help='Turn a switch on or off')
    switch_cmd.add_argument('switch', help='Switch ID or alias')
    switch_cmd.add_argument('state', help='on or off')

    # Serve command
    serve_cmd = subparsers.add_parser('serve', aliases=['s'], help='Start local web server')
    serve_cmd.add_argument('--port', '-p', type=int, default=8080, help='Port (default: 8080)')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    if args.command in ['list', 'ls']:
        asyncio.run(cmd_list(args))
    elif args.command in ['press', 'p']:
        asyncio.run(cmd_press(args))
    elif args.command == 'send':
        asyncio.run(cmd_send(args))
    elif args.command == 'pair':
        asyncio.run(cmd_pair(args))
    elif args.command == 'level':
        asyncio.run(cmd_level(args))
    elif args.command in ['switch', 'sw']:
        asyncio.run(cmd_switch(args))
    elif args.command in ['serve', 's']:
        cmd_serve(args)

    return 0


if __name__ == '__main__':
    sys.exit(main())
