"""
MQTT Client for Home Assistant Integration

Connects to MQTT broker and publishes:
- Home Assistant Auto-Discovery configs for devices
- Device state updates (levels, on/off)
- Button press events

Subscribes to command topics for bidirectional control.

Uses paho-mqtt for reliable connection handling.
"""

import json
import threading
import time
from typing import Optional, Callable, Dict, List, Any

try:
    import paho.mqtt.client as mqtt
    MQTT_AVAILABLE = True
except ImportError:
    MQTT_AVAILABLE = False
    print("[MQTT] paho-mqtt not installed. Run: pip install paho-mqtt")

import database as db


class MQTTClient:
    """
    MQTT client for Home Assistant integration.

    Handles:
    - Connection management with auto-reconnect
    - Home Assistant MQTT Auto-Discovery
    - State publishing
    - Command subscription for bidirectional control
    """

    def __init__(self):
        self.client: Optional[Any] = None
        self.connected = False
        self.config: Dict = {}
        self._lock = threading.Lock()
        self._command_callbacks: List[Callable] = []
        self._published_discovery: set = set()  # Track which devices have discovery published
        self.published_count = 0
        self._reconnect_thread: Optional[threading.Thread] = None
        self._should_reconnect = True

    def connect(self) -> bool:
        """
        Connect to MQTT broker using stored config.

        Returns True if connection initiated successfully.
        """
        if not MQTT_AVAILABLE:
            print("[MQTT] paho-mqtt not available")
            return False

        # Load config from database
        self.config = db.get_mqtt_config() or {}

        if not self.config.get('enabled'):
            print("[MQTT] MQTT is disabled in config")
            return False

        broker_host = self.config.get('broker_host', 'homeassistant.local')
        broker_port = self.config.get('broker_port', 1883)
        username = self.config.get('username')
        password = self.config.get('password')
        client_id = self.config.get('client_id', 'cca_playground')

        try:
            # Create client with callback API version
            self.client = mqtt.Client(
                client_id=client_id,
                callback_api_version=mqtt.CallbackAPIVersion.VERSION2
            )

            # Set credentials if provided
            if username:
                self.client.username_pw_set(username, password)

            # Set callbacks
            self.client.on_connect = self._on_connect
            self.client.on_disconnect = self._on_disconnect
            self.client.on_message = self._on_message

            # Connect
            print(f"[MQTT] Connecting to {broker_host}:{broker_port}...")
            self.client.connect_async(broker_host, broker_port, keepalive=60)
            self.client.loop_start()

            self._should_reconnect = True
            return True

        except Exception as e:
            print(f"[MQTT] Connection error: {e}")
            return False

    def disconnect(self):
        """Disconnect from broker."""
        self._should_reconnect = False
        if self.client:
            try:
                self.client.loop_stop()
                self.client.disconnect()
            except Exception:
                pass
            self.client = None
        self.connected = False
        self._published_discovery.clear()

    def reconnect(self):
        """Reconnect with potentially updated config."""
        self.disconnect()
        time.sleep(0.5)
        self.connect()

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        """Handle successful connection."""
        if reason_code == 0:
            self.connected = True
            print(f"[MQTT] Connected to broker")

            # Subscribe to command topics
            discovery_prefix = self.config.get('discovery_prefix', 'homeassistant')
            self.client.subscribe(f"cca/device/+/set")
            self.client.subscribe(f"cca/device/+/brightness/set")
            print(f"[MQTT] Subscribed to command topics")
        else:
            print(f"[MQTT] Connection failed: {reason_code}")

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        """Handle disconnection."""
        self.connected = False
        print(f"[MQTT] Disconnected (reason: {reason_code})")

        # Auto-reconnect is handled by paho loop

    def _on_message(self, client, userdata, msg):
        """Handle incoming messages (commands from Home Assistant)."""
        try:
            topic = msg.topic
            payload = msg.payload.decode('utf-8')

            # Parse topic: cca/device/{device_id}/set or cca/device/{device_id}/brightness/set
            parts = topic.split('/')
            if len(parts) >= 4 and parts[0] == 'cca' and parts[1] == 'device':
                device_id = parts[2]
                command_type = parts[3]

                if command_type == 'set':
                    # JSON command: {"state": "ON", "brightness": 75}
                    try:
                        data = json.loads(payload)
                        self._handle_command(device_id, data)
                    except json.JSONDecodeError:
                        # Simple ON/OFF
                        self._handle_command(device_id, {'state': payload})

                elif command_type == 'brightness' and len(parts) == 5 and parts[4] == 'set':
                    # Direct brightness value
                    try:
                        brightness = int(payload)
                        self._handle_command(device_id, {'brightness': brightness})
                    except ValueError:
                        pass

        except Exception as e:
            print(f"[MQTT] Message handling error: {e}")

    def _handle_command(self, device_id: str, command: Dict):
        """Process command from Home Assistant."""
        print(f"[MQTT] Command for {device_id}: {command}")

        # Notify registered callbacks
        with self._lock:
            callbacks = list(self._command_callbacks)

        for callback in callbacks:
            try:
                callback(device_id, command)
            except Exception as e:
                print(f"[MQTT] Command callback error: {e}")

    def subscribe_commands(self, callback: Callable[[str, Dict], None]):
        """
        Register callback for commands from Home Assistant.

        Args:
            callback: Function called with (device_id, command_dict)
                     command_dict may have: state, brightness
        """
        with self._lock:
            self._command_callbacks.append(callback)

    def unsubscribe_commands(self, callback: Callable):
        """Unregister a command callback."""
        with self._lock:
            if callback in self._command_callbacks:
                self._command_callbacks.remove(callback)

    def publish_discovery(self, device_id: str, device_info: Dict):
        """
        Publish Home Assistant MQTT Auto-Discovery config for a device.

        Args:
            device_id: 8-char hex device ID
            device_info: Device metadata with keys:
                - type/category: 'pico', 'dimmer', etc.
                - label: User-friendly name
                - device_type: 'pico-5btn', 'dimmer', etc.
        """
        if not self.connected or not self.client:
            return

        discovery_prefix = self.config.get('discovery_prefix', 'homeassistant')
        label = device_info.get('label') or f"Lutron {device_id}"
        device_type = device_info.get('type') or device_info.get('category', 'unknown')

        # Determine if this is a light (dimmer) or sensor (pico)
        if device_type in ('dimmer', 'dimmer_passive', 'bridge_controlled'):
            self._publish_light_discovery(device_id, label, discovery_prefix)
        elif device_type in ('pico', 'scene_pico'):
            self._publish_pico_discovery(device_id, label, device_info, discovery_prefix)

        self._published_discovery.add(device_id)

    def _publish_light_discovery(self, device_id: str, label: str, prefix: str):
        """Publish discovery config for a dimmer as a light entity."""
        config_topic = f"{prefix}/light/cca_{device_id}/config"
        retain = self.config.get('retain_state', True)

        config = {
            "name": label,
            "unique_id": f"cca_dimmer_{device_id}",
            "object_id": f"cca_{device_id}",
            "state_topic": f"cca/device/{device_id}/state",
            "command_topic": f"cca/device/{device_id}/set",
            "brightness_state_topic": f"cca/device/{device_id}/brightness",
            "brightness_command_topic": f"cca/device/{device_id}/brightness/set",
            "brightness_scale": 100,
            "on_command_type": "brightness",
            "schema": "json",
            "device": {
                "identifiers": [f"cca_{device_id}"],
                "name": label,
                "manufacturer": "Lutron",
                "model": "Clear Connect Type A",
                "via_device": "cca_playground"
            }
        }

        self.client.publish(config_topic, json.dumps(config), retain=retain)
        self.published_count += 1
        print(f"[MQTT] Published light discovery for {device_id}")

    def _publish_pico_discovery(self, device_id: str, label: str, device_info: Dict, prefix: str):
        """Publish discovery config for a Pico as device triggers."""
        retain = self.config.get('retain_state', True)

        # Determine buttons based on device type
        device_type = device_info.get('device_type', 'pico-5btn')
        if 'scene' in device_type.lower() or device_info.get('type') == 'scene_pico':
            buttons = ['SCENE1', 'SCENE2', 'SCENE3', 'SCENE4']
        elif '2btn' in device_type.lower():
            buttons = ['ON', 'OFF']
        else:
            buttons = ['ON', 'FAV', 'OFF', 'RAISE', 'LOWER']

        # Publish device trigger for each button
        for button in buttons:
            trigger_id = f"cca_{device_id}_{button.lower()}"
            config_topic = f"{prefix}/device_automation/{trigger_id}/config"

            config = {
                "automation_type": "trigger",
                "type": "button_short_press",
                "subtype": button.lower(),
                "payload": button,
                "topic": f"cca/device/{device_id}/button",
                "device": {
                    "identifiers": [f"cca_{device_id}"],
                    "name": label,
                    "manufacturer": "Lutron",
                    "model": device_type or "Pico Remote",
                    "via_device": "cca_playground"
                }
            }

            self.client.publish(config_topic, json.dumps(config), retain=retain)
            self.published_count += 1

        print(f"[MQTT] Published Pico discovery for {device_id} ({len(buttons)} buttons)")

    def publish_state(self, device_id: str, state: Dict):
        """
        Publish device state update.

        Args:
            device_id: Device ID
            state: Dict with 'level' (0-100) and/or 'state' ('ON'/'OFF')
        """
        if not self.connected or not self.client:
            return

        retain = self.config.get('retain_state', True)

        level = state.get('level')
        on_off = state.get('state')

        if level is not None:
            # Publish brightness
            self.client.publish(
                f"cca/device/{device_id}/brightness",
                str(level),
                retain=retain
            )
            # Also publish ON/OFF state based on level
            on_off = 'ON' if level > 0 else 'OFF'

        if on_off:
            self.client.publish(
                f"cca/device/{device_id}/state",
                on_off,
                retain=retain
            )

        self.published_count += 1

    def publish_event(self, event_type: str, device_id: str, payload: Dict):
        """
        Publish a semantic event to MQTT.

        Args:
            event_type: 'button_press', 'level_change', etc.
            device_id: Device that generated the event
            payload: Event details
        """
        if not self.connected or not self.client:
            return

        if event_type == 'button_press':
            # Publish to button topic for device triggers
            button = payload.get('button', 'UNKNOWN')
            self.client.publish(
                f"cca/device/{device_id}/button",
                button,
                retain=False
            )

        elif event_type == 'level_change':
            # Publish state update
            level = payload.get('level')
            if level is not None:
                self.publish_state(device_id, {'level': level})

        elif event_type == 'level_set':
            # A command was sent to a device - update its state
            level = payload.get('level')
            target_id = payload.get('target_id')
            if level is not None and target_id:
                self.publish_state(target_id, {'level': level})

        # Also publish raw event if enabled
        if self.config.get('publish_raw'):
            event_data = {
                'event_type': event_type,
                'device_id': device_id,
                **payload
            }
            self.client.publish(
                f"cca/events/{event_type}",
                json.dumps(event_data),
                retain=False
            )

        self.published_count += 1

    def publish_all_discovery(self, devices: Dict[str, Dict]) -> int:
        """
        Publish discovery configs for all devices.

        Args:
            devices: Dict of device_id -> device_info

        Returns:
            Number of devices published
        """
        count = 0
        for device_id, device_info in devices.items():
            self.publish_discovery(device_id, device_info)
            count += 1
        return count

    @staticmethod
    def test_connection(host: str, port: int = 1883,
                       username: Optional[str] = None,
                       password: Optional[str] = None) -> bool:
        """
        Test MQTT connection with provided settings.

        Returns True if connection successful.
        """
        if not MQTT_AVAILABLE:
            return False

        result = {'connected': False}
        event = threading.Event()

        def on_connect(client, userdata, flags, reason_code, properties=None):
            result['connected'] = (reason_code == 0)
            event.set()

        try:
            client = mqtt.Client(
                client_id="cca_test",
                callback_api_version=mqtt.CallbackAPIVersion.VERSION2
            )
            if username:
                client.username_pw_set(username, password)
            client.on_connect = on_connect

            client.connect(host, port, keepalive=10)
            client.loop_start()

            # Wait for connection result
            event.wait(timeout=5)

            client.loop_stop()
            client.disconnect()

            return result['connected']

        except Exception as e:
            print(f"[MQTT] Test connection error: {e}")
            return False


# Singleton instance
_instance: Optional[MQTTClient] = None


def get_mqtt_client() -> MQTTClient:
    """Get or create the global MQTTClient instance."""
    global _instance
    if _instance is None:
        _instance = MQTTClient()
    return _instance


def reset_mqtt_client():
    """Reset the global instance (for testing)."""
    global _instance
    if _instance:
        _instance.disconnect()
    _instance = None
