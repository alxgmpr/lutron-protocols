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

    async def send_state_report(self, device_id: int, level: int):
        """Send fake state report (device reporting its level)."""
        await self.call_service('send_state_report', device_id=f"0x{device_id:08X}", level_percent=level)
        print(f"State report: device 0x{device_id:08X} at {level}%")

    async def send_beacon(self, device_id: int, beacon_type: int, duration: int):
        """Send pairing beacon."""
        await self.call_service('send_beacon', device_id=f"0x{device_id:08X}", beacon_type=beacon_type, duration_seconds=duration)
        print(f"Beacon 0x{beacon_type:02X} from 0x{device_id:08X} for {duration}s")

    async def pair_experiment(self, device_id: int, ba_count: int, bb_count: int,
                               protocol_variant: int, pico_type: int):
        """Send experimental pairing with configurable parameters."""
        await self.call_service('pair_experiment',
                                device_id=f"0x{device_id:08X}",
                                ba_count=ba_count,
                                bb_count=bb_count,
                                protocol_variant=protocol_variant,
                                pico_type=pico_type)
        proto_name = "new(0x25)" if protocol_variant == 0 else "old(0x21/0x17)"
        type_name = "scene(4-btn)" if pico_type == 0 else "5-button"
        print(f"Experiment: device=0x{device_id:08X} BA={ba_count} BB={bb_count} proto={proto_name} type={type_name}")

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
        """CCA Playground - Dynamic RF command interface."""
        html = """
<!DOCTYPE html>
<html>
<head>
    <title>CCA Playground - Lutron Clear Connect</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: #eee; }
        h1 { color: #00d4ff; margin-bottom: 5px; }
        h1 small { color: #888; font-weight: normal; font-size: 14px; }
        .section { margin: 15px 0; padding: 15px; border-radius: 8px; border: 1px solid #333; }
        .section h2 { margin: 0 0 10px 0; font-size: 14px; color: #00d4ff; display: flex; align-items: center; gap: 8px; }
        .section h2 .badge { font-size: 10px; padding: 2px 6px; border-radius: 3px; background: #333; color: #888; }
        .pico { background: #1e3a1e; border-color: #2d5a2d; }
        .bridge { background: #1e2a3a; border-color: #2d4a6d; }
        .device { background: #3a2a1e; border-color: #5a4a2d; }
        .pairing { background: #2a1e3a; border-color: #4a2d6d; }
        .row { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
        label { color: #aaa; font-size: 12px; min-width: 80px; }
        input, select { padding: 8px 10px; border: 1px solid #444; border-radius: 4px; background: #2a2a3e; color: #fff; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; }
        input:focus, select:focus { outline: none; border-color: #00d4ff; }
        input[type="text"] { width: 130px; }
        input[type="number"] { width: 70px; }
        select { min-width: 180px; }
        button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.2s; }
        button:hover { transform: translateY(-1px); }
        .btn-send { background: #00d4ff; color: #000; }
        .btn-send:hover { background: #00e5ff; }
        .btn-level { background: #4a90d9; color: #fff; }
        .btn-level:hover { background: #5aa0e9; }
        .btn-off { background: #d94a4a; color: #fff; }
        .btn-off:hover { background: #e95a5a; }
        .btn-pair { background: #9b59b6; color: #fff; }
        .btn-pair:hover { background: #ab69c6; }
        .quick-btns { display: flex; gap: 5px; flex-wrap: wrap; }
        .quick-btns button { padding: 6px 12px; font-size: 12px; }
        #status { margin-top: 15px; padding: 12px; background: #2a2a3e; border-radius: 4px; font-family: monospace; font-size: 13px; border-left: 3px solid #00d4ff; }
        #status.error { border-color: #d94a4a; color: #ff6b6b; }
        #status.success { border-color: #2ecc71; color: #2ecc71; }
        .hint { font-size: 11px; color: #666; margin-top: 5px; }
        .divider { border-top: 1px solid #333; margin: 10px 0; }
    </style>
</head>
<body>
    <h1>CCA Playground <small>Lutron Clear Connect Type A</small></h1>

    <!-- PICO COMMANDS -->
    <div class="section pico">
        <h2>Pico Button Press <span class="badge">PICO &rarr; DEVICE</span></h2>
        <div class="row">
            <label>Pico ID:</label>
            <input type="text" id="pico-id" value="0x05851117" placeholder="0x05851117">
            <label>Button:</label>
            <select id="pico-button">
                <option value="0x02">ON (0x02)</option>
                <option value="0x03">FAVORITE (0x03)</option>
                <option value="0x04">OFF (0x04)</option>
                <option value="0x05">RAISE (0x05)</option>
                <option value="0x06">LOWER (0x06)</option>
                <option value="0x08">BTN1/BRIGHT (0x08)</option>
                <option value="0x09">BTN2/ENTERTAIN (0x09)</option>
                <option value="0x0A">BTN3/RELAX (0x0A)</option>
                <option value="0x0B">BTN4/OFF (0x0B)</option>
            </select>
            <input type="text" id="pico-button-raw" placeholder="or: 0x02" style="width: 80px;">
            <button class="btn-send" onclick="sendPico()">SEND</button>
        </div>
        <div class="hint">Emulates a Pico remote sending a button press. 5-btn Picos use 0x02-0x06, Scene/4-btn use 0x08-0x0B.</div>
    </div>

    <!-- BRIDGE COMMANDS -->
    <div class="section bridge">
        <h2>Bridge Level Command <span class="badge">BRIDGE &rarr; DEVICE</span></h2>
        <div class="row">
            <label>Bridge ID:</label>
            <input type="text" id="bridge-id" value="0xAF902C00" placeholder="0xAF902C00">
            <label>Target ID:</label>
            <input type="text" id="bridge-target" value="0x06FDEFF4" placeholder="0x06FDEFF4">
            <label>Level:</label>
            <input type="number" id="bridge-level" value="50" min="0" max="100">%
            <button class="btn-send" onclick="sendBridgeLevel()">SET LEVEL</button>
        </div>
        <div class="quick-btns">
            <button class="btn-off" onclick="setBridgeLevel(0)">0%</button>
            <button class="btn-level" onclick="setBridgeLevel(25)">25%</button>
            <button class="btn-level" onclick="setBridgeLevel(50)">50%</button>
            <button class="btn-level" onclick="setBridgeLevel(75)">75%</button>
            <button class="btn-level" onclick="setBridgeLevel(100)">100%</button>
        </div>
        <div class="hint">Emulates a bridge sending a level command directly to a dimmer.</div>
    </div>

    <!-- DEVICE STATE REPORTS -->
    <div class="section device">
        <h2>Device State Report <span class="badge">DEVICE &rarr; BRIDGE</span></h2>
        <div class="row">
            <label>Device ID:</label>
            <input type="text" id="state-device" value="0x8F902C08" placeholder="0x8F902C08">
            <label>Level:</label>
            <input type="number" id="state-level" value="50" min="0" max="100">%
            <button class="btn-send" onclick="sendStateReport()">REPORT</button>
        </div>
        <div class="quick-btns">
            <button class="btn-off" onclick="setStateLevel(0)">0%</button>
            <button class="btn-level" onclick="setStateLevel(25)">25%</button>
            <button class="btn-level" onclick="setStateLevel(50)">50%</button>
            <button class="btn-level" onclick="setStateLevel(75)">75%</button>
            <button class="btn-level" onclick="setStateLevel(100)">100%</button>
        </div>
        <div class="hint">Emulates a device (dimmer/switch) reporting its current level to the bridge.</div>
    </div>

    <!-- PAIRING -->
    <div class="section pairing">
        <h2>Pico Pairing <span class="badge">STANDARD</span></h2>
        <div class="row">
            <label>Device ID:</label>
            <input type="text" id="pair-device" value="0xCC110001" placeholder="0xCC110001">
            <label>Duration:</label>
            <input type="number" id="pair-duration" value="6" min="1" max="30">s
            <button class="btn-pair" onclick="sendPairing()">PAIR</button>
        </div>
        <div class="hint">Standard pairing (60 BA + 12 BB, new protocol, scene type).</div>
    </div>

    <!-- PAIRING EXPERIMENTS -->
    <div class="section" style="background: #1e1e2e; border-color: #4a4a6a;">
        <h2>Pairing Experiments <span class="badge">RESEARCH</span></h2>
        <div class="row">
            <label>Device ID:</label>
            <input type="text" id="exp-device" value="0xCC110002" placeholder="0xCC110002">
            <label>BA pkts:</label>
            <input type="number" id="exp-ba" value="12" min="1" max="60" style="width:50px;">
            <label>BB pkts:</label>
            <input type="number" id="exp-bb" value="6" min="1" max="20" style="width:50px;">
        </div>
        <div class="row">
            <label>Protocol:</label>
            <select id="exp-protocol">
                <option value="0">New (0x25) - Scene Pico capture</option>
                <option value="1">Old (0x21/0x17) - Original capture</option>
            </select>
            <label>Pico Type:</label>
            <select id="exp-type">
                <option value="0">Scene (4-btn, codes 0x08-0x0B)</option>
                <option value="1">5-Button (codes 0x02-0x06)</option>
            </select>
        </div>
        <div class="row">
            <button class="btn-pair" onclick="runExperiment()">RUN EXPERIMENT</button>
        </div>
        <div class="quick-btns" style="margin-top:10px;">
            <button onclick="preset(12,6,0,0)">Minimal Scene</button>
            <button onclick="preset(12,6,0,1)">Minimal 5-btn</button>
            <button onclick="preset(12,6,1,1)">Old Proto 5-btn</button>
            <button onclick="preset(60,12,0,0)">Full Scene</button>
            <button onclick="preset(60,12,0,1)">Full 5-btn</button>
        </div>
        <div class="hint">Test different protocol variants and packet counts. Use new device IDs to avoid conflicts.</div>
    </div>

    <div id="status">Ready - Enter parameters and click to send CCA commands</div>

    <script>
        function setStatus(msg, type = '') {
            const el = document.getElementById('status');
            el.textContent = msg;
            el.className = type;
        }

        async function apiCall(endpoint, params) {
            const url = endpoint + '?' + new URLSearchParams(params).toString();
            const resp = await fetch(url, {method: 'POST'});
            return await resp.json();
        }

        async function sendPico() {
            const device = document.getElementById('pico-id').value.trim();
            const rawBtn = document.getElementById('pico-button-raw').value.trim();
            const button = rawBtn || document.getElementById('pico-button').value;
            setStatus(`Sending button ${button} from Pico ${device}...`);
            try {
                const data = await apiCall('/api/send', {device, button});
                setStatus(data.status === 'ok' ? `Sent: ${data.button} from ${data.device}` : `Error: ${data.error}`, data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        async function sendBridgeLevel() {
            const source = document.getElementById('bridge-id').value.trim();
            const target = document.getElementById('bridge-target').value.trim();
            const level = document.getElementById('bridge-level').value;
            setStatus(`Bridge ${source} setting ${target} to ${level}%...`);
            try {
                const data = await apiCall('/api/level', {source, target, level});
                setStatus(data.status === 'ok' ? `Set ${data.target} to ${data.level}%` : `Error: ${data.error}`, data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        function setBridgeLevel(level) {
            document.getElementById('bridge-level').value = level;
            sendBridgeLevel();
        }

        async function sendStateReport() {
            const device = document.getElementById('state-device').value.trim();
            const level = document.getElementById('state-level').value;
            setStatus(`Device ${device} reporting level ${level}%...`);
            try {
                const data = await apiCall('/api/state', {device, level});
                setStatus(data.status === 'ok' ? `Reported: ${data.device} at ${data.level}%` : `Error: ${data.error}`, data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        function setStateLevel(level) {
            document.getElementById('state-level').value = level;
            sendStateReport();
        }

        async function sendPairing() {
            const device = document.getElementById('pair-device').value.trim();
            const duration = document.getElementById('pair-duration').value;
            setStatus(`Pairing ${device} for ${duration}s...`);
            try {
                const data = await apiCall('/api/pair', {device, duration});
                setStatus(data.status === 'ok' ? `Pairing ${data.device} (${data.duration}s)` : `Error: ${data.error}`, data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        async function runExperiment() {
            const device = document.getElementById('exp-device').value.trim();
            const ba = document.getElementById('exp-ba').value;
            const bb = document.getElementById('exp-bb').value;
            const protocol = document.getElementById('exp-protocol').value;
            const type = document.getElementById('exp-type').value;
            const protoName = protocol === '0' ? 'new(0x25)' : 'old(0x21/0x17)';
            const typeName = type === '0' ? 'scene' : '5-btn';
            setStatus(`Experiment: ${device} BA=${ba} BB=${bb} ${protoName} ${typeName}...`);
            try {
                const data = await apiCall('/api/experiment', {device, ba, bb, protocol, type});
                setStatus(data.status === 'ok' ? `Sent: ${data.ba_count}xBA + ${data.bb_count}xBB ${data.protocol} ${data.pico_type}` : `Error: ${data.error}`, data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        function preset(ba, bb, proto, type) {
            document.getElementById('exp-ba').value = ba;
            document.getElementById('exp-bb').value = bb;
            document.getElementById('exp-protocol').value = proto;
            document.getElementById('exp-type').value = type;
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

    async def send_state_async(device_id: int, level: int):
        """Send state report via ESPHome service."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_state_report(device_id, level)
        finally:
            await controller.disconnect()

    async def pair_experiment_async(device_id: int, ba_count: int, bb_count: int,
                                     protocol_variant: int, pico_type: int):
        """Send experimental pairing via ESPHome service."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.pair_experiment(device_id, ba_count, bb_count,
                                              protocol_variant, pico_type)
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

    @app.route('/api/state', methods=['POST'])
    def api_state():
        """Send state report (device reporting its level to bridge)."""
        try:
            device = request.args.get('device', '')
            level = int(request.args.get('level', '0'))

            if not device:
                return jsonify({'status': 'error', 'error': 'Missing device parameter'}), 400

            device_id = parse_hex_int(device)

            asyncio.run(send_state_async(device_id, level))
            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'level': level
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/experiment', methods=['POST'])
    def api_experiment():
        """Send experimental pairing with configurable parameters."""
        try:
            device = request.args.get('device', '')
            ba_count = int(request.args.get('ba', '12'))
            bb_count = int(request.args.get('bb', '6'))
            protocol = int(request.args.get('protocol', '0'))
            pico_type = int(request.args.get('type', '1'))

            if not device:
                return jsonify({'status': 'error', 'error': 'Missing device parameter'}), 400

            device_id = parse_hex_int(device)

            asyncio.run(pair_experiment_async(device_id, ba_count, bb_count, protocol, pico_type))
            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'ba_count': ba_count,
                'bb_count': bb_count,
                'protocol': 'new(0x25)' if protocol == 0 else 'old(0x21/0x17)',
                'pico_type': 'scene' if pico_type == 0 else '5-button'
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
