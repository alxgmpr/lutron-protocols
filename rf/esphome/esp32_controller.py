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

    async def pair_pico(self, device_id: int, ba_count: int = 12, bb_count: int = 6):
        """Send 5-button Pico pairing (the only type that works for direct pairing)."""
        await self.call_service('pair_experiment',
                               device_id=f"0x{device_id:08X}",
                               ba_count=ba_count,
                               bb_count=bb_count,
                               protocol_variant=0,  # New protocol (0x25)
                               pico_type=1)  # 5-button (MUST use this for direct pairing)

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
            display: flex; flex-direction: column; height: 100vh;
        }

        /* Header */
        header {
            padding: 12px 20px; background: #161b22;
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid #30363d; flex-shrink: 0;
        }
        header h1 { font-size: 18px; color: #58a6ff; font-weight: 600; }
        header h1 small { color: #8b949e; font-weight: 400; font-size: 12px; margin-left: 8px; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #238636; display: inline-block; margin-right: 6px; }
        .status-dot.offline { background: #f85149; }
        #esp-status { font-size: 12px; color: #8b949e; }

        /* Main layout */
        .container { display: flex; flex: 1; overflow: hidden; }

        /* Controls panel */
        .controls { width: 500px; padding: 16px; overflow-y: auto; border-right: 1px solid #30363d; flex-shrink: 0; }

        /* Logs panel */
        .logs-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

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
        .card.rx .card-header { border-left: 3px solid #f85149; }

        /* Form elements */
        .form-row { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
        .form-group { display: flex; flex-direction: column; gap: 4px; }
        .form-group label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
        input, select {
            padding: 8px 10px; border: 1px solid #30363d; border-radius: 4px;
            background: #0d1117; color: #c9d1d9; font-size: 13px;
            font-family: 'SF Mono', Monaco, monospace;
        }
        input:focus, select:focus { outline: none; border-color: #58a6ff; }
        input[type="text"] { width: 120px; }
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
        .btn-group { display: flex; gap: 4px; flex-wrap: wrap; }

        /* RX Monitor */
        .rx-card { margin: 16px; margin-bottom: 0; flex-shrink: 0; }
        .rx-card .card-body { padding: 0; }
        #rx-packets {
            max-height: 150px; overflow-y: auto; font-family: 'SF Mono', Monaco, monospace;
            font-size: 11px; background: #010409;
        }
        .rx-entry { padding: 6px 10px; border-bottom: 1px solid #21262d; white-space: nowrap; }
        .rx-entry:hover { background: #161b22; }
        .rx-time { color: #484f58; margin-right: 8px; }
        .rx-tag { display: inline-block; padding: 1px 5px; border-radius: 3px; margin-right: 6px; font-size: 10px; }
        .rx-tag.tx { background: #238636; color: #fff; }
        .rx-tag.rx { background: #1f6feb; color: #fff; }
        .rx-msg { color: #c9d1d9; }
        .rx-empty { color: #484f58; text-align: center; padding: 20px; }

        /* Logs */
        .logs-card { margin: 16px; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        .logs-card .card-body { flex: 1; padding: 0; overflow: hidden; }
        #logs {
            height: 100%; overflow-y: auto; font-family: 'SF Mono', Monaco, monospace;
            font-size: 11px; line-height: 1.4; padding: 10px; background: #010409;
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
            padding: 8px 16px; background: #161b22; border-top: 1px solid #30363d;
            font-size: 12px; color: #8b949e; flex-shrink: 0;
        }
        #status-bar.success { color: #3fb950; }
        #status-bar.error { color: #f85149; }

        /* Hint text */
        .hint { font-size: 11px; color: #484f58; margin-top: 8px; }

        /* Quick presets */
        .presets { margin-top: 8px; padding-top: 8px; border-top: 1px solid #30363d; }
        .presets-label { font-size: 10px; color: #484f58; margin-bottom: 6px; text-transform: uppercase; }
    </style>
</head>
<body>
    <header>
        <h1>CCA Playground <small>Lutron Clear Connect Type A</small></h1>
        <div id="esp-status"><span class="status-dot"></span>ESP32 @ 10.1.4.59</div>
    </header>

    <div class="container">
        <div class="controls">
            <!-- PICO PAIRING -->
            <div class="card pairing">
                <div class="card-header">
                    <h2>Pico Pairing</h2>
                    <span class="badge">5-BUTTON ONLY</span>
                </div>
                <div class="card-body">
                    <div class="form-row">
                        <div class="form-group">
                            <label>Device ID</label>
                            <input type="text" id="pair-device" value="0xCC110001">
                        </div>
                        <button class="btn-purple" onclick="pairPico()">PAIR PICO</button>
                    </div>
                    <div class="presets">
                        <div class="presets-label">Quick IDs</div>
                        <div class="btn-group">
                            <button class="btn-sm btn-purple" onclick="setPairDevice('0xCC110001')">CC110001</button>
                            <button class="btn-sm btn-purple" onclick="setPairDevice('0xCC110002')">CC110002</button>
                            <button class="btn-sm btn-purple" onclick="setPairDevice('0xCC110003')">CC110003</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- PICO COMMANDS -->
            <div class="card pico">
                <div class="card-header">
                    <h2>Pico Button Press</h2>
                    <span class="badge">PICO → DEVICE</span>
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
                                <option value="0x02">ON (0x02)</option>
                                <option value="0x03">FAVORITE (0x03)</option>
                                <option value="0x04">OFF (0x04)</option>
                                <option value="0x05">RAISE (0x05)</option>
                                <option value="0x06">LOWER (0x06)</option>
                            </select>
                        </div>
                        <button class="btn-primary" onclick="sendPico()">SEND</button>
                    </div>
                    <div class="btn-group">
                        <button class="btn-sm btn-primary" onclick="quickPico(0x02)">ON</button>
                        <button class="btn-sm btn-primary" onclick="quickPico(0x03)">FAV</button>
                        <button class="btn-sm btn-red" onclick="quickPico(0x04)">OFF</button>
                        <button class="btn-sm btn-blue" onclick="quickPico(0x05)">▲</button>
                        <button class="btn-sm btn-blue" onclick="quickPico(0x06)">▼</button>
                    </div>
                </div>
            </div>

            <!-- BRIDGE CONTROLS -->
            <div class="card bridge">
                <div class="card-header">
                    <h2>Bridge Level Control</h2>
                    <span class="badge">BRIDGE → DEVICE</span>
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
                    <span class="badge">PAIRING</span>
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
                    <span class="badge">DEVICE → BRIDGE</span>
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
        </div>

        <div class="logs-container">
            <!-- RX MONITOR -->
            <div class="card rx rx-card">
                <div class="card-header">
                    <h2>RF Activity</h2>
                    <button class="btn-sm" onclick="clearRx()">Clear</button>
                </div>
                <div class="card-body">
                    <div id="rx-packets">
                        <div class="rx-empty">Waiting for RF activity...</div>
                    </div>
                </div>
            </div>

            <!-- LOGS -->
            <div class="card logs-card">
                <div class="card-header">
                    <h2>ESP32 Logs</h2>
                    <button class="btn-sm" onclick="clearLogs()">Clear</button>
                </div>
                <div class="card-body">
                    <div id="logs"></div>
                </div>
            </div>
        </div>
    </div>

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
        function setPairDevice(id) {
            document.getElementById('pair-device').value = id;
        }

        async function pairPico() {
            const device = document.getElementById('pair-device').value.trim();
            setStatus(`Pairing ${device} as 5-button Pico...`);
            try {
                const data = await apiPost('/api/pair-pico', {device});
                setStatus(data.status === 'ok' ? `Paired ${data.device}` : `Error: ${data.error}`,
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

        // Logs streaming (always on)
        function startLogStream() {
            if (logsEventSource) return;

            logsEventSource = new EventSource('/api/logs/stream');

            logsEventSource.onmessage = function(event) {
                const data = JSON.parse(event.data);
                if (data.type === 'heartbeat') return;
                processLogEntry(data);
            };

            logsEventSource.onerror = function() {
                addLogEntry({time: new Date().toISOString(), level: 'E', msg: 'Log stream disconnected, reconnecting...'});
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
            // Remove ANSI escape codes (colors, formatting)
            return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[0?;?[0-9]*m/g, '');
        }

        function processLogEntry(data) {
            // Strip ANSI codes from message
            data.msg = stripAnsi(data.msg || '');

            // Check if this is an RF-related log (lutron_cc1101)
            if (data.msg.includes('lutron_cc1101') || data.msg.includes('TX:') || data.msg.includes('RX:')) {
                addRxEntry(data);
            }

            // Always add to main logs
            addLogEntry(data);
        }

        function addRxEntry(data) {
            const rxDiv = document.getElementById('rx-packets');

            // Remove empty message if present
            const empty = rxDiv.querySelector('.rx-empty');
            if (empty) empty.remove();

            const entry = document.createElement('div');
            entry.className = 'rx-entry';

            const time = data.time ? data.time.split('T')[1].split('.')[0] : '';
            const msg = data.msg || '';

            // Determine if TX or RX
            const isTx = msg.includes('TX:');
            const tagClass = isTx ? 'tx' : 'rx';
            const tagText = isTx ? 'TX' : 'RX';

            // Extract the useful part of the message
            let displayMsg = msg;
            const colonIdx = msg.indexOf(']: ');
            if (colonIdx > 0) {
                displayMsg = msg.substring(colonIdx + 3);
            }

            entry.innerHTML = `<span class="rx-time">${escapeHtml(time)}</span><span class="rx-tag ${tagClass}">${tagText}</span><span class="rx-msg">${escapeHtml(displayMsg)}</span>`;
            rxDiv.appendChild(entry);

            // Limit entries and auto-scroll
            while (rxDiv.children.length > 50) {
                rxDiv.removeChild(rxDiv.firstChild);
            }
            rxDiv.scrollTop = rxDiv.scrollHeight;
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

            // Limit entries and auto-scroll
            while (logsDiv.children.length > 500) {
                logsDiv.removeChild(logsDiv.firstChild);
            }
            logsDiv.scrollTop = logsDiv.scrollHeight;
        }

        function clearLogs() {
            document.getElementById('logs').innerHTML = '';
        }

        function clearRx() {
            document.getElementById('rx-packets').innerHTML = '<div class="rx-empty">Waiting for RF activity...</div>';
        }

        // Check ESP32 connection on load
        async function checkConnection() {
            try {
                const resp = await fetch('/api/status');
                const data = await resp.json();
                const dot = document.querySelector('.status-dot');
                if (data.connected) {
                    dot.classList.remove('offline');
                } else {
                    dot.classList.add('offline');
                }
            } catch (e) {
                document.querySelector('.status-dot').classList.add('offline');
            }
        }

        // Initialize
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

    async def pair_pico_async(device_id: int):
        controller = ESP32Controller()
        try:
            await controller.connect()
            await controller.pair_pico(device_id)
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
        """Pair as 5-button Pico (the only type that works for direct pairing)."""
        try:
            device = request.args.get('device', '')
            if not device:
                return jsonify({'status': 'error', 'error': 'Missing device'}), 400

            device_id = parse_hex_int(device)
            asyncio.run(pair_pico_async(device_id))

            return jsonify({
                'status': 'ok',
                'device': f'0x{device_id:08X}',
                'type': '5-button'
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
