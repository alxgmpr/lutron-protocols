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
from typing import Optional, List, Dict
from datetime import datetime

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
ESP32_PASSWORD = ""
ESP32_ENCRYPTION_KEY = "EixuPCx/wLtc5a55a/16gNEubH7qiZWFhn7LR98qQU8="

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

    async def pair_pico(self, device_id: int, pico_type: int = 1, ba_count: int = 12, bb_count: int = 6):
        """Send Pico pairing. pico_type: 0=Scene (bridge only), 1=5-button (direct to dimmer)."""
        await self.call_service('pair_experiment',
                               device_id=f"0x{device_id:08X}",
                               ba_count=ba_count,
                               bb_count=bb_count,
                               protocol_variant=0,  # New protocol (0x25)
                               pico_type=pico_type)  # 0=Scene, 1=5-button

    async def send_reset(self, source_id: int, paired_id: int):
        """Send Reset/Unpair packet to remove a Pico from a device."""
        await self.call_service('send_reset',
                               source_id=f"0x{source_id:08X}",
                               paired_id=f"0x{paired_id:08X}")

    async def start_rx(self):
        """Start RX mode."""
        await self.call_service('start_rx')

    async def stop_rx(self):
        """Stop RX mode."""
        await self.call_service('stop_rx')

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
    """Start local web server with CCA Playground dashboard."""
    try:
        from flask import Flask, jsonify, request, Response
    except ImportError:
        print("Error: Flask not installed. Run: pip install flask")
        sys.exit(1)

    app = Flask(__name__)

    # ═══════════════════════════════════════════════════════════════════════════
    # HTML DASHBOARD
    # ═══════════════════════════════════════════════════════════════════════════

    @app.route('/')
    def index():
        return '''<!DOCTYPE html>
<html>
<head>
    <title>CCA Playground - Lutron Clear Connect</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #0d1117; color: #c9d1d9;
            min-height: 100vh;
        }

        /* Header */
        header {
            padding: 12px 20px; background: #161b22;
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid #30363d;
        }
        header h1 { font-size: 18px; color: #58a6ff; font-weight: 600; }
        header h1 small { color: #8b949e; font-weight: 400; font-size: 12px; margin-left: 8px; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #238636; display: inline-block; margin-right: 6px; }
        .status-dot.offline { background: #f85149; }
        #esp-status { font-size: 12px; color: #8b949e; }

        /* Main container - single column */
        main { max-width: 800px; margin: 0 auto; padding: 16px; }

        /* Section cards */
        .card {
            background: #161b22; border: 1px solid #30363d; border-radius: 6px;
            margin-bottom: 12px; overflow: hidden;
        }
        .card-header {
            padding: 10px 14px; background: #21262d; border-bottom: 1px solid #30363d;
            display: flex; justify-content: space-between; align-items: center;
        }
        .card-header h2 { font-size: 13px; font-weight: 600; color: #c9d1d9; }
        .card-header .badge {
            font-size: 10px; padding: 2px 6px; border-radius: 10px;
            background: #30363d; color: #8b949e;
        }
        .card-body { padding: 14px; }

        /* Color themes for cards */
        .card.pico .card-header { border-left: 3px solid #238636; }
        .card.bridge .card-header { border-left: 3px solid #58a6ff; }
        .card.pairing .card-header { border-left: 3px solid #a371f7; }
        .card.device .card-header { border-left: 3px solid #d29922; }
        .card.tx .card-header { border-left: 3px solid #238636; }
        .card.rx .card-header { border-left: 3px solid #1f6feb; }
        .card.logs .card-header { border-left: 3px solid #8b949e; }

        /* Form elements */
        .form-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
        .form-group { display: flex; flex-direction: column; gap: 4px; }
        .form-group label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
        input, select {
            padding: 8px 10px; border: 1px solid #30363d; border-radius: 4px;
            background: #0d1117; color: #c9d1d9; font-size: 13px;
            font-family: 'SF Mono', Monaco, monospace;
        }
        input:focus, select:focus { outline: none; border-color: #58a6ff; }
        input[type="text"] { width: 130px; }
        input[type="number"] { width: 70px; }

        /* Buttons */
        button {
            padding: 8px 14px; border: none; border-radius: 4px; cursor: pointer;
            font-size: 12px; font-weight: 500; transition: all 0.15s;
        }
        button:hover { filter: brightness(1.1); }
        button:active { transform: scale(0.98); }
        .btn-primary { background: #238636; color: #fff; }
        .btn-blue { background: #1f6feb; color: #fff; }
        .btn-purple { background: #8957e5; color: #fff; }
        .btn-orange { background: #d29922; color: #000; }
        .btn-red { background: #da3633; color: #fff; }
        .btn-sm { padding: 5px 10px; font-size: 11px; }
        .btn-group { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }

        /* Hex display boxes */
        .hex-box {
            height: 120px; overflow-y: auto; font-family: 'SF Mono', Monaco, monospace;
            font-size: 11px; background: #010409; padding: 10px; border-radius: 4px;
        }
        .hex-entry { padding: 4px 0; border-bottom: 1px solid #21262d; word-break: break-all; }
        .hex-entry:last-child { border-bottom: none; }
        .hex-time { color: #484f58; margin-right: 8px; }
        .hex-data { color: #58a6ff; font-weight: 500; }
        .hex-empty { color: #484f58; text-align: center; padding: 40px 0; }

        /* Logs */
        #logs {
            height: 200px; overflow-y: auto; font-family: 'SF Mono', Monaco, monospace;
            font-size: 11px; line-height: 1.4; padding: 10px; background: #010409; border-radius: 4px;
        }
        .log-entry { padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
        .log-time { color: #484f58; }
        .log-level-I { color: #58a6ff; }
        .log-level-W { color: #d29922; }
        .log-level-E { color: #f85149; }
        .log-level-D { color: #8b949e; }
        .log-level-V { color: #6e7681; }
        .log-msg { color: #c9d1d9; }

        /* Status bar */
        #status-bar {
            position: fixed; bottom: 0; left: 0; right: 0;
            padding: 8px 16px; background: #161b22; border-top: 1px solid #30363d;
            font-size: 12px; color: #8b949e;
        }
        #status-bar.success { color: #3fb950; }
        #status-bar.error { color: #f85149; }

        /* Bottom padding for status bar */
        main { padding-bottom: 50px; }
    </style>
</head>
<body>
    <header>
        <h1>CCA Playground <small>Lutron Clear Connect Type A</small></h1>
        <div id="esp-status"><span class="status-dot"></span>ESP32 @ 10.1.4.59</div>
    </header>

    <main>
        <!-- PICO PAIRING -->
        <div class="card pairing">
            <div class="card-header">
                <h2>Pico Pairing</h2>
                <span class="badge">PICO -> DEVICE/BRIDGE</span>
            </div>
            <div class="card-body">
                <div class="form-row">
                    <div class="form-group">
                        <label>Device ID</label>
                        <input type="text" id="pair-device" value="0xCC110001">
                    </div>
                    <button class="btn-purple" onclick="pairPico('5button')">PAIR 5-BUTTON</button>
                    <button class="btn-blue" onclick="pairPico('scene')">PAIR SCENE</button>
                </div>
                <div style="font-size:11px;color:#8b949e;margin-top:8px;">
                    5-Button: pairs directly to dimmers | Scene: pairs to bridge only
                </div>
            </div>
        </div>

        <!-- PICO COMMANDS -->
        <div class="card pico">
            <div class="card-header">
                <h2>Pico Button Press</h2>
                <span class="badge">PICO -> DEVICE/BRIDGE</span>
            </div>
            <div class="card-body">
                <div class="form-row">
                    <div class="form-group">
                        <label>Pico ID</label>
                        <input type="text" id="pico-id" value="0x05851117">
                    </div>
                    <div class="form-group">
                        <label>Button</label>
                        <select id="pico-button">
                            <optgroup label="5-Button Pico">
                                <option value="0x02">ON (0x02)</option>
                                <option value="0x03">FAVORITE (0x03)</option>
                                <option value="0x04">OFF (0x04)</option>
                                <option value="0x05">RAISE (0x05)</option>
                                <option value="0x06">LOWER (0x06)</option>
                            </optgroup>
                            <optgroup label="Scene Pico">
                                <option value="0x08">BRIGHT (0x08)</option>
                                <option value="0x09">ENTERTAIN (0x09)</option>
                                <option value="0x0A">RELAX (0x0A)</option>
                                <option value="0x0B">SCENE OFF (0x0B)</option>
                            </optgroup>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Custom</label>
                        <input type="text" id="pico-custom" placeholder="0x00">
                    </div>
                    <button class="btn-primary" onclick="sendPico()">SEND</button>
                    <button class="btn-orange" onclick="sendPicoCustom()">SEND CUSTOM</button>
                </div>
                <div class="btn-group">
                    <button class="btn-sm btn-primary" onclick="quickPico(0x02)">ON</button>
                    <button class="btn-sm btn-primary" onclick="quickPico(0x03)">FAV</button>
                    <button class="btn-sm btn-red" onclick="quickPico(0x04)">OFF</button>
                    <button class="btn-sm btn-blue" onclick="quickPico(0x05)">RAISE</button>
                    <button class="btn-sm btn-blue" onclick="quickPico(0x06)">LOWER</button>
                </div>
                <div class="btn-group">
                    <button class="btn-sm btn-orange" onclick="quickPico(0x08)">BRIGHT</button>
                    <button class="btn-sm btn-orange" onclick="quickPico(0x09)">ENTERTAIN</button>
                    <button class="btn-sm btn-orange" onclick="quickPico(0x0A)">RELAX</button>
                    <button class="btn-sm btn-red" onclick="quickPico(0x0B)">SCENE OFF</button>
                </div>
            </div>
        </div>

        <!-- BRIDGE CONTROLS -->
        <div class="card bridge">
            <div class="card-header">
                <h2>Bridge Level Control</h2>
                <span class="badge">BRIDGE -> DEVICE</span>
            </div>
            <div class="card-body">
                <div class="form-row">
                    <div class="form-group">
                        <label>Bridge ID</label>
                        <input type="text" id="bridge-id" value="0xAF902C00">
                    </div>
                    <div class="form-group">
                        <label>Target ID</label>
                        <input type="text" id="bridge-target" value="0x06FDEFF4">
                    </div>
                    <div class="form-group">
                        <label>Level</label>
                        <input type="number" id="bridge-level" value="50" min="0" max="100">
                    </div>
                    <button class="btn-blue" onclick="sendLevel()">SET</button>
                </div>
                <div class="btn-group">
                    <button class="btn-sm btn-red" onclick="quickLevel(0)">0%</button>
                    <button class="btn-sm btn-blue" onclick="quickLevel(25)">25%</button>
                    <button class="btn-sm btn-blue" onclick="quickLevel(50)">50%</button>
                    <button class="btn-sm btn-blue" onclick="quickLevel(75)">75%</button>
                    <button class="btn-sm btn-primary" onclick="quickLevel(100)">100%</button>
                </div>
            </div>
        </div>

        <!-- BRIDGE BEACON -->
        <div class="card bridge">
            <div class="card-header">
                <h2>Bridge Beacon Mode</h2>
                <span class="badge">BRIDGE PAIRING</span>
            </div>
            <div class="card-body">
                <div class="form-row">
                    <div class="form-group">
                        <label>Bridge ID</label>
                        <input type="text" id="beacon-bridge" value="0xAF902C01">
                    </div>
                    <div class="form-group">
                        <label>Duration</label>
                        <input type="number" id="beacon-duration" value="30" min="5" max="120">
                    </div>
                    <button class="btn-blue" onclick="sendBeacon()">START BEACON</button>
                </div>
            </div>
        </div>

        <!-- DEVICE STATE REPORT -->
        <div class="card device">
            <div class="card-header">
                <h2>Device State Report</h2>
                <span class="badge">DEVICE -> BRIDGE</span>
            </div>
            <div class="card-body">
                <div class="form-row">
                    <div class="form-group">
                        <label>Device ID</label>
                        <input type="text" id="state-device" value="0x8F902C08">
                    </div>
                    <div class="form-group">
                        <label>Level</label>
                        <input type="number" id="state-level" value="50" min="0" max="100">
                    </div>
                    <button class="btn-orange" onclick="sendState()">REPORT</button>
                </div>
            </div>
        </div>

        <!-- RESET/UNPAIR -->
        <div class="card device">
            <div class="card-header">
                <h2>Reset Pico</h2>
                <span class="badge">FORGET ME</span>
            </div>
            <div class="card-body">
                <div class="form-row">
                    <div class="form-group" style="flex:2">
                        <label>Pico ID</label>
                        <input type="text" id="reset-pico" value="0x05851117" placeholder="Pico ID to reset">
                    </div>
                    <button class="btn-red" onclick="sendReset()">RESET</button>
                </div>
                <small style="color:#888">Broadcasts "forget about me" to all paired devices</small>
            </div>
        </div>

        <!-- TX PACKETS -->
        <div class="card tx">
            <div class="card-header">
                <h2>TX Packets</h2>
                <span><button class="btn-sm" onclick="copyTx()">Copy</button> <button class="btn-sm" onclick="clearTx()">Clear</button></span>
            </div>
            <div class="card-body" style="padding:0;">
                <div id="tx-packets" class="hex-box">
                    <div class="hex-empty">No TX packets yet</div>
                </div>
            </div>
        </div>

        <!-- RX PACKETS -->
        <div class="card rx">
            <div class="card-header">
                <h2>RX Packets</h2>
                <span><button class="btn-sm" onclick="copyRx()">Copy</button> <button class="btn-sm" onclick="clearRx()">Clear</button></span>
            </div>
            <div class="card-body" style="padding:0;">
                <div id="rx-packets" class="hex-box">
                    <div class="hex-empty">No RX packets yet</div>
                </div>
            </div>
        </div>

        <!-- ESP32 LOGS -->
        <div class="card logs">
            <div class="card-header">
                <h2>ESP32 Logs</h2>
                <span><button class="btn-sm" onclick="copyLogs()">Copy</button> <button class="btn-sm" onclick="clearLogs()">Clear</button></span>
            </div>
            <div class="card-body" style="padding:0;">
                <div id="logs"></div>
            </div>
        </div>
    </main>

    <div id="status-bar">Ready</div>

    <script>
        let logsEventSource = null;

        function setStatus(msg, type = '') {
            const el = document.getElementById('status-bar');
            el.textContent = msg;
            el.className = type;
        }

        async function apiPost(endpoint, params) {
            const url = endpoint + '?' + new URLSearchParams(params).toString();
            const resp = await fetch(url, {method: 'POST'});
            return await resp.json();
        }

        // Pico Pairing
        async function pairPico(type) {
            const device = document.getElementById('pair-device').value.trim();
            const typeName = type === 'scene' ? 'Scene Pico' : '5-Button Pico';
            setStatus(`Pairing ${device} as ${typeName}...`);
            try {
                const data = await apiPost('/api/pair-pico', {device, type});
                setStatus(data.status === 'ok' ? `Paired ${data.device} as ${data.type}` : `Error: ${data.error}`,
                         data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        // Pico Commands
        async function sendPico() {
            const device = document.getElementById('pico-id').value.trim();
            const button = document.getElementById('pico-button').value;
            setStatus(`Sending ${button} from ${device}...`);
            try {
                const data = await apiPost('/api/send', {device, button});
                setStatus(data.status === 'ok' ? `Sent ${data.button} from ${data.device}` : `Error: ${data.error}`,
                         data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        function quickPico(btn) {
            document.getElementById('pico-button').value = '0x' + btn.toString(16).padStart(2, '0');
            sendPico();
        }

        async function sendPicoCustom() {
            const device = document.getElementById('pico-id').value.trim();
            const customValue = document.getElementById('pico-custom').value.trim();
            if (!customValue) {
                setStatus('Enter a custom button code', 'error');
                return;
            }

            const displayValue = customValue.toUpperCase();
            setStatus(`Sending ${displayValue} from ${device}...`);
            try {
                const data = await apiPost('/api/send', {device, button: customValue});
                setStatus(data.status === 'ok' ? `Sent ${data.button} from ${data.device}` : `Error: ${data.error}`,
                         data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        // Bridge Level
        async function sendLevel() {
            const source = document.getElementById('bridge-id').value.trim();
            const target = document.getElementById('bridge-target').value.trim();
            const level = document.getElementById('bridge-level').value;
            setStatus(`Setting ${target} to ${level}%...`);
            try {
                const data = await apiPost('/api/level', {source, target, level});
                setStatus(data.status === 'ok' ? `Set ${data.target} to ${data.level}%` : `Error: ${data.error}`,
                         data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        function quickLevel(level) {
            document.getElementById('bridge-level').value = level;
            sendLevel();
        }

        // Beacon
        async function sendBeacon() {
            const device = document.getElementById('beacon-bridge').value.trim();
            const duration = document.getElementById('beacon-duration').value;
            setStatus(`Starting beacon from ${device} for ${duration}s...`);
            try {
                const data = await apiPost('/api/beacon', {device, duration, type: '0x92'});
                setStatus(data.status === 'ok' ? `Beacon started: ${data.device}` : `Error: ${data.error}`,
                         data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        // State Report
        async function sendState() {
            const device = document.getElementById('state-device').value.trim();
            const level = document.getElementById('state-level').value;
            setStatus(`Reporting ${device} at ${level}%...`);
            try {
                const data = await apiPost('/api/state', {device, level});
                setStatus(data.status === 'ok' ? `Reported ${data.device} at ${data.level}%` : `Error: ${data.error}`,
                         data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        // Reset Pico
        async function sendReset() {
            const pico = document.getElementById('reset-pico').value.trim();
            setStatus(`Sending reset for ${pico}...`);
            try {
                const data = await apiPost('/api/reset', {pico});
                setStatus(data.status === 'ok' ? `Reset broadcast: ${data.pico} "forget me"` : `Error: ${data.error}`,
                         data.status === 'ok' ? 'success' : 'error');
            } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
        }

        // Logs streaming
        function startLogStream() {
            if (logsEventSource) return;
            logsEventSource = new EventSource('/api/logs/stream');

            logsEventSource.onmessage = function(event) {
                const data = JSON.parse(event.data);
                if (data.type === 'heartbeat') return;
                processLogEntry(data);
            };

            logsEventSource.onerror = function() {
                addLogEntry({time: new Date().toISOString(), level: 'E', msg: 'Reconnecting...'});
                logsEventSource.close();
                logsEventSource = null;
                setTimeout(startLogStream, 2000);
            };
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function stripAnsi(text) {
            return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[0?;?[0-9]*m/g, '');
        }

        function processLogEntry(data) {
            data.msg = stripAnsi(data.msg || '');
            const msg = data.msg;

            // Extract hex bytes from TX/RX messages
            // Pattern: "TX 40 bytes: AA AA AA AA..." or "RX 32 bytes: AA AA AA..."
            // The hex data comes after "bytes:" followed by space
            const txMatch = msg.match(/TX\s+\d+\s+bytes:\s*([A-F0-9]{2}(?:\s+[A-F0-9]{2})+)/i);
            const rxMatch = msg.match(/RX\s+\d+\s+bytes:\s*([A-F0-9]{2}(?:\s+[A-F0-9]{2})+)/i);

            const time = data.time ? data.time.split('T')[1].split('.')[0] : '';

            if (txMatch) {
                addHexEntry('tx-packets', time, txMatch[1]);
            } else if (rxMatch) {
                addHexEntry('rx-packets', time, rxMatch[1]);
            }

            // Always add to logs
            addLogEntry(data);
        }

        function addHexEntry(containerId, time, hexData) {
            const container = document.getElementById(containerId);
            const empty = container.querySelector('.hex-empty');
            if (empty) empty.remove();

            const entry = document.createElement('div');
            entry.className = 'hex-entry';
            entry.innerHTML = `<span class="hex-time">${escapeHtml(time)}</span><span class="hex-data">${escapeHtml(hexData)}</span>`;
            container.appendChild(entry);

            while (container.children.length > 30) {
                container.removeChild(container.firstChild);
            }
            container.scrollTop = container.scrollHeight;
        }

        function addLogEntry(data) {
            const logsDiv = document.getElementById('logs');
            const entry = document.createElement('div');
            entry.className = 'log-entry';

            const time = data.time ? data.time.split('T')[1].split('.')[0] : '';
            const level = data.level || 'I';
            const msg = data.msg || '';

            entry.innerHTML = `<span class="log-time">${escapeHtml(time)}</span> <span class="log-level-${level}">[${level}]</span> <span class="log-msg">${escapeHtml(msg)}</span>`;
            logsDiv.appendChild(entry);

            while (logsDiv.children.length > 200) {
                logsDiv.removeChild(logsDiv.firstChild);
            }
            logsDiv.scrollTop = logsDiv.scrollHeight;
        }

        function clearLogs() { document.getElementById('logs').innerHTML = ''; }
        function clearTx() { document.getElementById('tx-packets').innerHTML = '<div class="hex-empty">No TX packets yet</div>'; }
        function clearRx() { document.getElementById('rx-packets').innerHTML = '<div class="hex-empty">No RX packets yet</div>'; }

        function copyLogs() {
            var text = [];
            document.querySelectorAll('#logs .log-entry').forEach(function(el) { text.push(el.textContent); });
            navigator.clipboard.writeText(text.join('\\n')).then(function() { setStatus('Copied logs', 'success'); });
        }
        function copyTx() {
            var text = [];
            document.querySelectorAll('#tx-packets .hex-entry').forEach(function(el) { text.push(el.textContent); });
            navigator.clipboard.writeText(text.join('\\n')).then(function() { setStatus('Copied TX', 'success'); });
        }
        function copyRx() {
            var text = [];
            document.querySelectorAll('#rx-packets .hex-entry').forEach(function(el) { text.push(el.textContent); });
            navigator.clipboard.writeText(text.join('\\n')).then(function() { setStatus('Copied RX', 'success'); });
        }

        // Check connection
        async function checkConnection() {
            try {
                const resp = await fetch('/api/status');
                const data = await resp.json();
                document.querySelector('.status-dot').classList.toggle('offline', !data.connected);
            } catch (e) {
                document.querySelector('.status-dot').classList.add('offline');
            }
        }

        checkConnection();
        setInterval(checkConnection, 30000);
        startLogStream();
    </script>
</body>
</html>'''

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
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_beacon(device_id, beacon_type, duration)
        finally:
            await controller.disconnect()

    async def pair_pico_async(device_id: int, pico_type: int = 1):
        """pico_type: 0 = Scene, 1 = 5-button"""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.pair_pico(device_id, pico_type)
        finally:
            await controller.disconnect()

    async def send_reset_async(source_id: int, paired_id: int):
        """Send reset/unpair packet."""
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.send_reset(source_id, paired_id)
        finally:
            await controller.disconnect()

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

    @app.route('/api/status')
    def api_status():
        """Check ESP32 connection status."""
        try:
            connected = asyncio.run(check_connection_async())
            return jsonify({'connected': connected, 'ip': ESP32_IP})
        except:
            return jsonify({'connected': False, 'ip': ESP32_IP})

    @app.route('/api/send', methods=['POST'])
    def api_send():
        """Send button command."""
        try:
            device = request.args.get('device', '')
            button = request.args.get('button', '')
            if not device or not button:
                return jsonify({'status': 'error', 'error': 'Missing device or button'}), 400

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

    @app.route('/api/level', methods=['POST'])
    def api_level():
        """Send level command."""
        try:
            source = request.args.get('source', '')
            target = request.args.get('target', '')
            level = int(request.args.get('level', '0'))
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
        """Send state report."""
        try:
            device = request.args.get('device', '')
            level = int(request.args.get('level', '0'))
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
        """Pair as Pico (5-button or Scene)."""
        try:
            device = request.args.get('device', '')
            pico_type = request.args.get('type', '5button')  # '5button' or 'scene'
            if not device:
                return jsonify({'status': 'error', 'error': 'Missing device'}), 400

            device_id = parse_hex_int(device)
            # pico_type: 0 = Scene (4-button), 1 = 5-button
            type_code = 0 if pico_type == 'scene' else 1
            asyncio.run(pair_pico_async(device_id, type_code))

            type_name = 'Scene Pico' if pico_type == 'scene' else '5-Button Pico'
            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'type': type_name
            })
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)}), 500

    @app.route('/api/logs/stream')
    def api_logs_stream():
        """Stream ESP32 logs via Server-Sent Events."""
        def generate():
            # Send initial connection message
            yield f"data: {json.dumps({'time': datetime.now().isoformat(), 'level': 'I', 'msg': 'Connected to log stream'})}\n\n"

            # Start log subscription in background
            log_thread = threading.Thread(target=subscribe_to_logs, daemon=True)
            log_thread.start()

            # Stream logs from queue
            while True:
                try:
                    log_entry = log_queue.get(timeout=30)
                    yield f"data: {json.dumps(log_entry)}\n\n"
                except queue.Empty:
                    # Send heartbeat
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"

        return Response(generate(), mimetype='text/event-stream',
                       headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

    def subscribe_to_logs():
        """Subscribe to ESP32 logs and push to queue."""
        async def _subscribe():
            client = APIClient(
                address=ESP32_IP,
                port=ESP32_PORT,
                password=ESP32_PASSWORD,
                noise_psk=ESP32_ENCRYPTION_KEY,
            )
            try:
                await client.connect(login=True)

                def on_log(msg):
                    try:
                        # msg.level is an int: 0=NONE, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG, 5=VERBOSE
                        level_map = {0: 'N', 1: 'E', 2: 'W', 3: 'I', 4: 'D', 5: 'V'}
                        level_int = msg.level if isinstance(msg.level, int) else 3
                        # msg.message may be bytes
                        message = msg.message if hasattr(msg, 'message') else str(msg)
                        if isinstance(message, bytes):
                            message = message.decode('utf-8', errors='replace')
                        log_queue.put_nowait({
                            'time': datetime.now().isoformat(),
                            'level': level_map.get(level_int, 'I'),
                            'msg': message
                        })
                    except queue.Full:
                        pass

                # subscribe_logs returns an unsubscribe callback, not a coroutine
                unsub = client.subscribe_logs(on_log, log_level=aioesphomeapi.LogLevel.LOG_LEVEL_DEBUG)

                # Keep connection alive
                try:
                    while True:
                        await asyncio.sleep(1)
                finally:
                    unsub()

            except Exception as e:
                log_queue.put_nowait({
                    'time': datetime.now().isoformat(),
                    'level': 'E',
                    'msg': f'Log subscription error: {e}'
                })
            finally:
                await client.disconnect()

        asyncio.run(_subscribe())

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
