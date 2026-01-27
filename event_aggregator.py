"""
Event Aggregator - Groups raw packets into semantic events

This module processes raw CCA packets and groups them into meaningful events:
- Button presses (debounced PRESS + RELEASE)
- Level changes (from STATE_RPT packets)
- Level commands (from SET_LEVEL packets)

Events are emitted to registered listeners (proxy engine, UI, etc.)
and stored in the database for history/debugging.
"""

import threading
import time
from typing import Dict, List, Callable, Optional, Any
from datetime import datetime
from collections import defaultdict

import database as db


class DeviceState:
    """Tracks current state for a single device."""

    def __init__(self, device_id: str):
        self.device_id = device_id
        self.level: Optional[int] = None
        self.last_button: Optional[str] = None
        self.last_action: Optional[str] = None
        self.last_seen: float = time.time()
        # For debouncing button press + release
        self.pending_press: Optional[Dict] = None
        self.pending_press_time: float = 0


class EventAggregator:
    """
    Aggregates raw packets into semantic events.

    Usage:
        aggregator = EventAggregator()
        aggregator.add_listener(lambda event_type, device_id, details: ...)
        aggregator.on_packet(parsed_packet_dict)
    """

    def __init__(self, debounce_ms: int = 150):
        self.states: Dict[str, DeviceState] = {}
        self.listeners: List[Callable[[str, str, Dict], None]] = []
        self._lock = threading.Lock()
        self.debounce_ms = debounce_ms
        self._debounce_timers: Dict[str, threading.Timer] = {}

    def add_listener(self, callback: Callable[[str, str, Dict], None]):
        """
        Add an event listener.

        Args:
            callback: Function called with (event_type, device_id, details)
        """
        with self._lock:
            self.listeners.append(callback)

    def remove_listener(self, callback: Callable[[str, str, Dict], None]):
        """Remove an event listener."""
        with self._lock:
            if callback in self.listeners:
                self.listeners.remove(callback)

    def get_device_state(self, device_id: str) -> Optional[DeviceState]:
        """Get current state for a device."""
        return self.states.get(device_id)

    def on_packet(self, packet: Dict[str, Any]):
        """
        Process an incoming packet and potentially emit events.

        Args:
            packet: Parsed packet dict with keys like:
                - packet_type: 'BTN_SHORT_A', 'STATE_RPT', 'SET_LEVEL', etc.
                - device_id: Source device ID
                - button: Button name (for BTN_* packets)
                - level: Level 0-100 (for STATE_RPT, SET_LEVEL)
                - source_id, target_id: For directed packets
                - direction: 'rx' or 'tx'
        """
        if not packet:
            return

        packet_type = packet.get('packet_type', packet.get('type', ''))
        device_id = packet.get('device_id')

        if not device_id:
            return

        # Get or create device state
        with self._lock:
            if device_id not in self.states:
                self.states[device_id] = DeviceState(device_id)
            state = self.states[device_id]
            state.last_seen = time.time()

        # Route to appropriate handler
        if packet_type.startswith('BTN_'):
            self._handle_button_packet(packet, state)
        elif packet_type == 'STATE_RPT':
            self._handle_state_rpt(packet, state)
        elif packet_type == 'SET_LEVEL' or packet_type == 'LEVEL':
            self._handle_level_command(packet, state)
        elif packet_type.startswith('PAIR'):
            self._handle_pairing_packet(packet, state)

    def _handle_button_packet(self, packet: Dict, state: DeviceState):
        """
        Handle BTN_* packets with debouncing.

        Button packets come in pairs: PRESS then RELEASE.
        We debounce these into a single 'button_press' event.
        """
        button = packet.get('button')
        action = packet.get('action', 'PRESS')
        device_id = state.device_id

        if not button:
            return

        # Normalize action
        if isinstance(action, str):
            action = action.upper()
        elif action == 0:
            action = 'PRESS'
        elif action == 1:
            action = 'RELEASE'

        state.last_button = button
        state.last_action = action

        debounce_key = f"{device_id}:{button}"

        if action == 'PRESS':
            # Store pending press, wait for release or timeout
            state.pending_press = {
                'button': button,
                'timestamp': datetime.now().isoformat(),
                'packet': packet
            }
            state.pending_press_time = time.time()

            # Set timeout to emit event even if release doesn't come
            self._schedule_debounce(debounce_key, device_id, button)

        elif action == 'RELEASE':
            # Cancel pending timer and emit event
            self._cancel_debounce(debounce_key)

            # Check if we have a pending press
            if state.pending_press and state.pending_press.get('button') == button:
                # Calculate hold duration
                hold_ms = int((time.time() - state.pending_press_time) * 1000)
                self._emit_button_event(device_id, button, hold_ms, packet)
                state.pending_press = None
            else:
                # Release without press (maybe we missed it)
                self._emit_button_event(device_id, button, 0, packet)

    def _schedule_debounce(self, key: str, device_id: str, button: str):
        """Schedule debounce timeout for button press."""
        self._cancel_debounce(key)

        def on_timeout():
            state = self.states.get(device_id)
            if state and state.pending_press and state.pending_press.get('button') == button:
                # Emit event on timeout (no release received)
                hold_ms = int((time.time() - state.pending_press_time) * 1000)
                self._emit_button_event(device_id, button, hold_ms, state.pending_press.get('packet', {}))
                state.pending_press = None

        timer = threading.Timer(self.debounce_ms / 1000.0, on_timeout)
        timer.daemon = True
        self._debounce_timers[key] = timer
        timer.start()

    def _cancel_debounce(self, key: str):
        """Cancel a pending debounce timer."""
        timer = self._debounce_timers.pop(key, None)
        if timer:
            timer.cancel()

    def _emit_button_event(self, device_id: str, button: str, hold_ms: int, packet: Dict):
        """Emit a button_press event."""
        details = {
            'button': button,
            'hold_ms': hold_ms,
            'timestamp': datetime.now().isoformat()
        }

        # Add RSSI if available
        if packet.get('rssi'):
            details['rssi'] = packet['rssi']

        self._emit_event('button_press', device_id, details)

    def _handle_state_rpt(self, packet: Dict, state: DeviceState):
        """
        Handle STATE_RPT packets (dimmer level broadcasts).

        Only emit event if level actually changed.
        """
        level = packet.get('level')
        device_id = state.device_id

        if level is None:
            return

        # Check if level changed
        if state.level != level:
            old_level = state.level
            state.level = level

            details = {
                'level': level,
                'old_level': old_level,
                'timestamp': datetime.now().isoformat()
            }

            if packet.get('rssi'):
                details['rssi'] = packet['rssi']

            self._emit_event('level_change', device_id, details)

    def _handle_level_command(self, packet: Dict, state: DeviceState):
        """
        Handle SET_LEVEL / LEVEL packets (bridge commands to dimmers).

        These are commands being sent, not state reports.
        """
        level = packet.get('level')
        source_id = packet.get('source_id')
        target_id = packet.get('target_id') or packet.get('device_id')

        if level is None:
            return

        # Update state for target device
        if target_id and target_id in self.states:
            target_state = self.states[target_id]
            target_state.level = level

        details = {
            'level': level,
            'source_id': source_id,
            'target_id': target_id,
            'timestamp': datetime.now().isoformat()
        }

        # Emit from target device perspective
        if target_id:
            self._emit_event('level_set', target_id, details)

    def _handle_pairing_packet(self, packet: Dict, state: DeviceState):
        """Handle pairing-related packets."""
        packet_type = packet.get('packet_type', '')
        device_id = state.device_id

        details = {
            'packet_type': packet_type,
            'timestamp': datetime.now().isoformat()
        }

        if 'RESP' in packet_type:
            self._emit_event('pairing_response', device_id, details)
        elif packet_type in ('PAIR_B0', 'PAIR_B8', 'PAIR_B9', 'PAIR_BA', 'PAIR_BB'):
            self._emit_event('pairing_announcement', device_id, details)

    def _emit_event(self, event_type: str, device_id: str, details: Dict):
        """
        Emit event to all listeners and store in database.

        Args:
            event_type: 'button_press', 'level_change', 'level_set', etc.
            device_id: Device that generated the event
            details: Event-specific details
        """
        # Store in database
        try:
            db.insert_event(
                event_type=event_type,
                device_id=device_id,
                details=details,
                timestamp=details.get('timestamp', datetime.now().isoformat())
            )
        except Exception as e:
            print(f"[EVENT_AGGREGATOR] Failed to store event: {e}")

        # Notify listeners
        with self._lock:
            listeners = list(self.listeners)

        for listener in listeners:
            try:
                listener(event_type, device_id, details)
            except Exception as e:
                print(f"[EVENT_AGGREGATOR] Listener error: {e}")

    def get_all_states(self) -> Dict[str, Dict]:
        """Get current state for all tracked devices."""
        result = {}
        for device_id, state in self.states.items():
            result[device_id] = {
                'device_id': device_id,
                'level': state.level,
                'last_button': state.last_button,
                'last_seen': state.last_seen
            }
        return result


# Singleton instance for global access
_instance: Optional[EventAggregator] = None


def get_aggregator() -> EventAggregator:
    """Get or create the global EventAggregator instance."""
    global _instance
    if _instance is None:
        _instance = EventAggregator()
    return _instance


def reset_aggregator():
    """Reset the global instance (for testing)."""
    global _instance
    _instance = None
