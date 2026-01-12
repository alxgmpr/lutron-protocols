"""
Proxy Engine - Forwards commands between devices

This module evaluates proxy rules and forwards commands:
- One-to-one forwarding (Pico A -> Dimmer B)
- Fan-out (Pico A -> [Dimmer B, Dimmer C, Dimmer D])
- Bidirectional sync (Virtual Dimmer <-> Real Caseta Dimmer)
- Button remapping (source button X -> target button Y)

Loop detection prevents infinite forwarding chains.
"""

import threading
import time
import asyncio
from typing import Dict, List, Optional, Set, Callable, Any
from dataclasses import dataclass
from datetime import datetime

import database as db


# Button code mappings for transmission
BUTTON_CODES = {
    'ON': 0x02,
    'FAV': 0x03,
    'FAVORITE': 0x03,
    'OFF': 0x04,
    'RAISE': 0x05,
    'LOWER': 0x06,
    'SCENE1': 0x08,
    'SCENE2': 0x09,
    'SCENE3': 0x0A,
    'SCENE4': 0x0B,
}


@dataclass
class ProxyRule:
    """Runtime representation of a proxy rule."""
    id: int
    name: str
    enabled: bool
    source_device_id: str
    source_type: str
    target_device_id: str
    target_type: str
    target_bridge_id: Optional[str]  # Bridge to use for sending to target (if different from learned)
    mode: str  # 'forward', 'bidirectional'
    button_map: Dict[str, str]  # source_button -> target_button
    level_transform: Dict[str, Any]  # {'min': 0, 'max': 100, 'invert': False}
    debounce_ms: int

    @classmethod
    def from_dict(cls, row: Dict) -> 'ProxyRule':
        return cls(
            id=row['id'],
            name=row['name'],
            enabled=bool(row['enabled']),
            source_device_id=row['source_device_id'],
            source_type=row['source_type'],
            target_device_id=row['target_device_id'],
            target_type=row['target_type'],
            target_bridge_id=row.get('target_bridge_id'),
            mode=row.get('mode', 'forward'),
            button_map=row.get('button_map') or {},
            level_transform=row.get('level_transform') or {},
            debounce_ms=row.get('debounce_ms', 100)
        )


class ProxyEngine:
    """
    Engine for evaluating and executing proxy rules.

    Usage:
        engine = ProxyEngine(send_command_callback)
        engine.reload_rules()
        engine.on_event('button_press', 'DEVICE123', {'button': 'ON'})
    """

    def __init__(self, controller_callback: Optional[Callable] = None):
        """
        Initialize proxy engine.

        Args:
            controller_callback: Async function to send commands to ESP32.
                Signature: async def send(action, **params)
                Actions: 'send_button', 'send_level', 'send_state_report'
        """
        self.rules_by_source: Dict[str, List[ProxyRule]] = {}
        self.rules_by_target: Dict[str, List[ProxyRule]] = {}  # For bidirectional
        self._controller = controller_callback
        self._lock = threading.Lock()
        self._active_forwards: Set[str] = set()  # For loop detection
        self._forward_timestamps: Dict[str, float] = {}  # Track when forwards started
        self._loop = None  # Event loop for async operations
        self._loop_thread: Optional[threading.Thread] = None

    def set_controller(self, callback: Callable):
        """Set the controller callback for sending commands."""
        self._controller = callback

    def reload_rules(self):
        """Load proxy rules from database."""
        with self._lock:
            self.rules_by_source.clear()
            self.rules_by_target.clear()

            rules = db.get_proxy_rules(enabled_only=True)
            for row in rules:
                rule = ProxyRule.from_dict(row)

                # Index by source
                if rule.source_device_id not in self.rules_by_source:
                    self.rules_by_source[rule.source_device_id] = []
                self.rules_by_source[rule.source_device_id].append(rule)

                # Index by target for bidirectional rules
                if rule.mode == 'bidirectional':
                    if rule.target_device_id not in self.rules_by_target:
                        self.rules_by_target[rule.target_device_id] = []
                    self.rules_by_target[rule.target_device_id].append(rule)

            print(f"[PROXY] Loaded {len(rules)} rules for {len(self.rules_by_source)} source devices")

    def on_event(self, event_type: str, device_id: str, details: Dict):
        """
        Handle incoming event, apply matching proxy rules.

        Args:
            event_type: 'button_press', 'level_change', 'level_set'
            device_id: Device that generated the event
            details: Event-specific details
        """
        # Check for forward direction (source -> target)
        rules = self.rules_by_source.get(device_id, [])
        for rule in rules:
            self._process_rule(rule, event_type, device_id, details, direction='forward')

        # Check for reverse direction (target -> source) for bidirectional rules
        reverse_rules = self.rules_by_target.get(device_id, [])
        for rule in reverse_rules:
            if rule.mode == 'bidirectional':
                self._process_rule(rule, event_type, device_id, details, direction='reverse')

    def _process_rule(self, rule: ProxyRule, event_type: str, device_id: str,
                     details: Dict, direction: str):
        """Process a single proxy rule."""
        if not rule.enabled:
            return

        # Check for loops
        chain_key = f"{rule.source_device_id}:{rule.target_device_id}:{event_type}"
        if direction == 'reverse':
            chain_key = f"{rule.target_device_id}:{rule.source_device_id}:{event_type}"

        if self._check_loop(chain_key):
            print(f"[PROXY] Loop detected, skipping: {chain_key}")
            return

        try:
            if event_type == 'button_press':
                self._forward_button(rule, details, direction)
            elif event_type in ('level_change', 'level_set'):
                self._forward_level(rule, details, direction)
        finally:
            self._clear_loop_marker(chain_key)

    def _check_loop(self, chain_key: str) -> bool:
        """
        Check if we're in a forwarding loop.

        Returns True if loop detected (should skip processing).
        """
        with self._lock:
            # Clean up old entries (older than 2 seconds)
            now = time.time()
            expired = [k for k, t in self._forward_timestamps.items() if now - t > 2.0]
            for k in expired:
                self._active_forwards.discard(k)
                del self._forward_timestamps[k]

            if chain_key in self._active_forwards:
                return True

            self._active_forwards.add(chain_key)
            self._forward_timestamps[chain_key] = now
            return False

    def _clear_loop_marker(self, chain_key: str):
        """Clear a loop detection marker."""
        with self._lock:
            self._active_forwards.discard(chain_key)
            self._forward_timestamps.pop(chain_key, None)

    def _forward_button(self, rule: ProxyRule, details: Dict, direction: str):
        """Forward button press to target device."""
        source_button = details.get('button', 'ON')

        # Apply button mapping
        if direction == 'forward':
            target_button = rule.button_map.get(source_button, source_button)
            target_device = rule.target_device_id
        else:
            # Reverse mapping for bidirectional
            reverse_map = {v: k for k, v in rule.button_map.items()}
            target_button = reverse_map.get(source_button, source_button)
            target_device = rule.source_device_id

        # Check if button should be ignored (mapped to None or empty)
        if not target_button:
            print(f"[PROXY] Button {source_button} ignored by mapping")
            return

        # Get button code
        button_code = BUTTON_CODES.get(target_button.upper())
        if button_code is None:
            print(f"[PROXY] Unknown button: {target_button}")
            return

        print(f"[PROXY] Forwarding button {source_button} -> {target_button} to {target_device}")

        # Send command
        if self._controller:
            self._run_async(self._controller(
                'send_button',
                device_id=target_device,
                button_code=button_code
            ))

    def _forward_level(self, rule: ProxyRule, details: Dict, direction: str):
        """Forward level change to target device."""
        level = details.get('level')
        if level is None:
            return

        # Apply level transform
        transform = rule.level_transform
        if transform:
            min_level = transform.get('min', 0)
            max_level = transform.get('max', 100)
            invert = transform.get('invert', False)

            # Scale level to min-max range
            level = min_level + (level / 100.0) * (max_level - min_level)
            level = int(level)

            if invert:
                level = max_level - level + min_level

            level = max(0, min(100, level))

        if direction == 'forward':
            target_device = rule.target_device_id
        else:
            target_device = rule.source_device_id

        # Determine which bridge to use for the target device
        # Priority: 1) Rule's explicit target_bridge_id
        #           2) Device's known bridge_id (from SET_LEVEL packets)
        #           3) CCA subnet's primary bridge (from subnet discovery)
        bridge_id = None

        # Check if rule has explicit target_bridge_id configured
        if hasattr(rule, 'target_bridge_id') and rule.target_bridge_id:
            bridge_id = rule.target_bridge_id
            print(f"[PROXY] Using rule's configured bridge {bridge_id}")

        # Fall back to target device's learned bridge_id
        if not bridge_id:
            devices = db.get_all_devices()
            target_info = devices.get(target_device, {})
            bridge_id = target_info.get('bridge_id')
            if bridge_id:
                print(f"[PROXY] Using target device's learned bridge {bridge_id}")

        # Fall back to CCA subnet's primary bridge (smart routing)
        if not bridge_id:
            # Check if device has a known subnet
            device_subnets = db.get_device_subnets(target_device)
            if device_subnets:
                # Use the most recent subnet membership
                subnet_id = device_subnets[0]['subnet_id']
                subnet = db.get_cca_subnet(subnet_id)
                if subnet and subnet.get('primary_bridge_id'):
                    bridge_id = subnet['primary_bridge_id']
                    print(f"[PROXY] Using subnet {subnet_id}'s primary bridge {bridge_id}")

        # Last resort: check device info for subnet and look up bridge
        if not bridge_id:
            devices = db.get_all_devices()
            target_info = devices.get(target_device, {})
            info = target_info.get('info', {})
            subnet_id = info.get('subnet')
            if subnet_id:
                subnet = db.get_cca_subnet(subnet_id)
                if subnet and subnet.get('primary_bridge_id'):
                    bridge_id = subnet['primary_bridge_id']
                    print(f"[PROXY] Using subnet {subnet_id}'s primary bridge {bridge_id} (from device info)")

        if not bridge_id:
            print(f"[PROXY] Cannot forward level to {target_device}: no bridge_id found")
            print(f"[PROXY]   Options:")
            print(f"[PROXY]   1. Configure target_bridge_id in rule")
            print(f"[PROXY]   2. Ensure target device has received SET_LEVEL from its bridge")
            print(f"[PROXY]   3. Wait for CCA subnet discovery to detect the bridge")
            return

        print(f"[PROXY] Forwarding level {level} to {target_device} via bridge {bridge_id}")

        # Send command
        if self._controller:
            # For dimmers, we need to send a level command
            # The source_id must be a bridge that is paired with the target dimmer
            self._run_async(self._controller(
                'send_level',
                source_id=bridge_id,
                target_id=target_device,
                level=level
            ))

    def _run_async(self, coro):
        """Run an async coroutine from sync context."""
        if coro is None:
            return

        try:
            # Try to get running loop
            loop = asyncio.get_running_loop()
            asyncio.ensure_future(coro, loop=loop)
        except RuntimeError:
            # No running loop, create one in a thread
            def run_in_thread():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    loop.run_until_complete(coro)
                finally:
                    loop.close()

            thread = threading.Thread(target=run_in_thread, daemon=True)
            thread.start()

    def test_rule(self, rule_id: int, event_type: str, details: Dict) -> Dict:
        """
        Test a proxy rule by simulating an event (without actually sending).

        Returns dict with what would be forwarded.
        """
        rule_data = db.get_proxy_rule(rule_id)
        if not rule_data:
            return {'error': 'Rule not found'}

        rule = ProxyRule.from_dict(rule_data)

        result = {
            'rule_id': rule_id,
            'rule_name': rule.name,
            'event_type': event_type,
            'would_forward': False,
            'details': {}
        }

        if event_type == 'button_press':
            source_button = details.get('button', 'ON')
            target_button = rule.button_map.get(source_button, source_button)

            if target_button:
                result['would_forward'] = True
                result['details'] = {
                    'source_button': source_button,
                    'target_button': target_button,
                    'target_device': rule.target_device_id
                }

        elif event_type in ('level_change', 'level_set'):
            level = details.get('level', 50)
            transform = rule.level_transform

            if transform:
                min_level = transform.get('min', 0)
                max_level = transform.get('max', 100)
                invert = transform.get('invert', False)

                level = min_level + (level / 100.0) * (max_level - min_level)
                level = int(level)

                if invert:
                    level = max_level - level + min_level

            result['would_forward'] = True
            result['details'] = {
                'source_level': details.get('level', 50),
                'target_level': level,
                'target_device': rule.target_device_id
            }

        return result

    def get_rules_summary(self) -> Dict:
        """Get summary of loaded rules."""
        with self._lock:
            return {
                'total_rules': sum(len(rules) for rules in self.rules_by_source.values()),
                'source_devices': list(self.rules_by_source.keys()),
                'bidirectional_targets': list(self.rules_by_target.keys())
            }


# Singleton instance
_instance: Optional[ProxyEngine] = None


def get_proxy_engine() -> ProxyEngine:
    """Get or create the global ProxyEngine instance."""
    global _instance
    if _instance is None:
        _instance = ProxyEngine()
    return _instance


def reset_proxy_engine():
    """Reset the global instance (for testing)."""
    global _instance
    _instance = None
