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

    # Bridge-style level commands for device AF902C00
    "level-0": "level_0___af902c00_",
    "level-25": "level_25___af902c00_",
    "level-50": "level_50___af902c00_",
    "level-75": "level_75___af902c00_",
    "level-100": "level_100___af902c00_",

    # Pairing
    "pair-b9": "pair__0xb9_",
    "pair-esp32": "pair_esp32",
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
        """List all button and switch entities."""
        entities, _ = await self.client.list_entities_services()

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

        return buttons, switches

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
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
        h1 { color: #333; }
        .section { margin: 20px 0; padding: 15px; background: #f5f5f5; border-radius: 8px; }
        .section h2 { margin-top: 0; font-size: 16px; color: #666; }
        button { padding: 10px 20px; margin: 5px; font-size: 14px; cursor: pointer; border: none; border-radius: 4px; background: #007bff; color: white; }
        button:hover { background: #0056b3; }
        button.off { background: #dc3545; }
        button.off:hover { background: #c82333; }
        button.dim { background: #6c757d; }
        button.dim:hover { background: #545b62; }
        #status { margin-top: 20px; padding: 10px; background: #e9ecef; border-radius: 4px; }
    </style>
</head>
<body>
    <h1>Lutron RF Controller</h1>

    <div class="section">
        <h2>Pico Buttons (05851117)</h2>
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

    <div class="section">
        <h2>Fake State Reports (8f902c08)</h2>
        <button onclick="press('fake-0')" class="off">Report 0%</button>
        <button onclick="press('fake-50')" class="dim">Report 50%</button>
        <button onclick="press('fake-100')">Report 100%</button>
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

    print(f"Starting web server on http://localhost:{args.port}")
    print(f"Proxying to ESP32 at {ESP32_IP}")
    print("Press Ctrl+C to stop\n")

    app.run(host='0.0.0.0', port=args.port, debug=False)


def main():
    parser = argparse.ArgumentParser(
        description='Control ESP32 Lutron RF transmitter via native API',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    %(prog)s list                     # List available buttons/switches
    %(prog)s press rf-on              # Press RF On button
    %(prog)s press level-100          # Set level to 100%%
    %(prog)s switch beacon on         # Turn beacon mode ON
    %(prog)s switch beacon off        # Turn beacon mode OFF
    %(prog)s serve --port 8080        # Start web server on port 8080
"""
    )

    subparsers = parser.add_subparsers(dest='command', help='Commands')

    # List command
    list_cmd = subparsers.add_parser('list', aliases=['ls'], help='List available buttons/switches')

    # Press command
    press_cmd = subparsers.add_parser('press', aliases=['p'], help='Press a button')
    press_cmd.add_argument('button', help='Button ID or alias')

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
    elif args.command in ['switch', 'sw']:
        asyncio.run(cmd_switch(args))
    elif args.command in ['serve', 's']:
        cmd_serve(args)

    return 0


if __name__ == '__main__':
    sys.exit(main())
