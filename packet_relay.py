"""
Low-Latency Packet Relay for CCA Protocol

Provides direct packet-level translation that bypasses semantic event processing
and aioesphomeapi overhead for minimal latency (~10-20ms vs ~200-400ms).

Architecture:
    ESP32 RX -> UDP -> PacketRelay (rewrite bytes) -> UDP TX cmd -> ESP32 TX

Packet Types:
    0x88-0x8B (button): Device ID at bytes 2-5 (big-endian)
    0x81-0x83 (state): Device ID at bytes 2-5 (little-endian)
    0x81 format 0x0E (SET_LEVEL): Source @ 2-5 (LE), Target @ 9-12 (BE)
"""

import asyncio
import socket
import struct
import time
import logging
from dataclasses import dataclass, field
from typing import Dict, Optional, Callable, List, Tuple
from datetime import datetime

try:
    import cca
    CCA_AVAILABLE = True
except ImportError:
    CCA_AVAILABLE = False
    print("[PacketRelay] Warning: cca module not available, CRC recalculation disabled")

logger = logging.getLogger(__name__)


# UDP command bytes
CMD_TX_RAW = 0x01


@dataclass
class RelayRule:
    """A packet relay rule."""
    id: int
    name: str
    enabled: bool
    source_device_id: str  # 8-char hex
    target_device_id: str  # 8-char hex
    target_bridge_id: Optional[str] = None  # For level commands
    bidirectional: bool = False
    relay_buttons: bool = True
    relay_level: bool = True


@dataclass
class RelayStats:
    """Statistics for packet relay."""
    packets_received: int = 0
    packets_relayed: int = 0
    packets_dropped: int = 0
    last_relay_latency_ms: float = 0.0
    avg_relay_latency_ms: float = 0.0
    total_latency_samples: int = 0


@dataclass
class PendingTx:
    """A pending TX packet awaiting ACK."""
    packet: bytes
    target_device_id: str
    timestamp: float
    retries: int = 0
    max_retries: int = 3
    timeout_ms: float = 150.0


class PacketRelay:
    """
    Low-latency packet relay engine.

    Receives CCA packets via UDP, applies relay rules to rewrite device IDs,
    recalculates CRC, and sends TX commands back to ESP32.
    """

    # Sequence number tracking per device
    SEQUENCE_INCREMENT = 6
    SEQUENCE_MAX = 0x48

    def __init__(
        self,
        esp32_host: str = "10.1.4.59",
        tx_port: int = 9434,
        rx_port: int = 9433
    ):
        """
        Initialize the packet relay.

        Args:
            esp32_host: ESP32 IP address
            tx_port: Port to send TX commands to ESP32 (ESP32's RX port)
            rx_port: Port to receive packets from ESP32 (not used here, handled by UDPTransport)
        """
        self.esp32_host = esp32_host
        self.tx_port = tx_port
        self.rx_port = rx_port

        # Relay rules: source_device_id -> list of rules
        self._rules: Dict[str, List[RelayRule]] = {}
        self._rules_by_id: Dict[int, RelayRule] = {}

        # Sequence numbers per device
        self._sequences: Dict[str, int] = {}

        # Statistics
        self.stats = RelayStats()

        # Pending TX for ACK tracking
        self._pending_tx: Dict[str, PendingTx] = {}

        # Deduplication: track recently relayed packets to avoid duplicate TX
        # Key: (device_id, pkt_type, level/button), Value: timestamp
        self._recent_relays: Dict[tuple, float] = {}
        self._dedup_window_ms: float = 500.0  # Ignore duplicates within 500ms

        # TX echo suppression: track packets we transmitted to ignore when received back
        # Key: first 16 bytes of packet (excluding seq), Value: timestamp
        self._recent_tx: Dict[bytes, float] = {}
        self._tx_echo_window_ms: float = 200.0  # Ignore TX echoes within 200ms

        # Disable retry mechanism - it causes more problems than it solves
        self._retries_enabled: bool = False

        # UDP socket for TX commands
        self._tx_socket: Optional[socket.socket] = None

        # Callback for packets that don't match relay rules
        self.on_unmatched_packet: Optional[Callable[[bytes, int, str], None]] = None

        # Callback for relay events (for logging/UI)
        self.on_relay_event: Optional[Callable[[str, dict], None]] = None

        self._running = False

    def start(self):
        """Start the relay engine."""
        if self._running:
            return

        # Create TX socket
        self._tx_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._running = True
        logger.info(f"PacketRelay started, TX to {self.esp32_host}:{self.tx_port}")

    def stop(self):
        """Stop the relay engine."""
        self._running = False
        if self._tx_socket:
            self._tx_socket.close()
            self._tx_socket = None
        logger.info(f"PacketRelay stopped (relayed {self.stats.packets_relayed} packets)")

    def load_rules(self, rules: List[dict]):
        """Load relay rules from database format."""
        self._rules.clear()
        self._rules_by_id.clear()

        for rule_dict in rules:
            rule = RelayRule(
                id=rule_dict['id'],
                name=rule_dict['name'],
                enabled=bool(rule_dict.get('enabled', 1)),
                source_device_id=rule_dict['source_device_id'].upper(),
                target_device_id=rule_dict['target_device_id'].upper(),
                target_bridge_id=rule_dict.get('target_bridge_id', '').upper() if rule_dict.get('target_bridge_id') else None,
                bidirectional=bool(rule_dict.get('bidirectional', 0)),
                relay_buttons=bool(rule_dict.get('relay_buttons', 1)),
                relay_level=bool(rule_dict.get('relay_level', 1))
            )

            if rule.enabled:
                source_id = rule.source_device_id
                if source_id not in self._rules:
                    self._rules[source_id] = []
                self._rules[source_id].append(rule)
                self._rules_by_id[rule.id] = rule

                # If bidirectional, also add reverse mapping
                if rule.bidirectional:
                    target_id = rule.target_device_id
                    if target_id not in self._rules:
                        self._rules[target_id] = []
                    # Create reverse rule
                    reverse_rule = RelayRule(
                        id=-rule.id,  # Negative ID for reverse
                        name=f"{rule.name} (reverse)",
                        enabled=True,
                        source_device_id=target_id,
                        target_device_id=source_id,
                        target_bridge_id=None,  # Reverse doesn't need bridge
                        bidirectional=False,
                        relay_buttons=rule.relay_buttons,
                        relay_level=rule.relay_level
                    )
                    self._rules[target_id].append(reverse_rule)

        logger.info(f"Loaded {len(self._rules_by_id)} relay rules")
        # Debug: show all device ID mappings
        for device_id, rules_list in self._rules.items():
            for r in rules_list:
                logger.debug(f"[RELAY] Rule mapping: {r.source_device_id} -> {r.target_device_id} (bidir={r.bidirectional}, bridge={r.target_bridge_id})")

    def handle_packet(self, data: bytes, rssi: int, direction: str = 'rx'):
        """
        Handle a received packet.

        This is called by the UDP transport when a packet arrives.

        Args:
            data: Raw CCA packet bytes
            rssi: RSSI value
            direction: 'rx' or 'tx'
        """
        if not self._running or direction != 'rx':
            return

        self.stats.packets_received += 1

        if len(data) < 6:
            return  # Too short

        start_time = time.time()
        now = time.time()

        # TX echo suppression: ignore packets we just transmitted
        # Use bytes 0, 2-15 (skip seq at byte 1) as key
        tx_key = self._get_tx_echo_key(data)
        if tx_key in self._recent_tx:
            age_ms = (now - self._recent_tx[tx_key]) * 1000
            if age_ms < self._tx_echo_window_ms:
                logger.debug(f"[RELAY] TX echo suppressed (age={age_ms:.0f}ms)")
                return

        # Extract packet type
        pkt_type = data[0]

        # Debug: log all packets with their device IDs
        device_id = self._extract_device_id(data, pkt_type)
        if device_id:
            # Check if this device has any rules (forward or reverse)
            has_rules = device_id.upper() in self._rules
            format_byte = data[7] if len(data) > 7 else 0
            logger.debug(f"[RELAY] RX 0x{pkt_type:02X} fmt=0x{format_byte:02X} from {device_id} rules={has_rules}")

        # Determine device ID location and endianness based on packet type
        device_id = self._extract_device_id(data, pkt_type)
        if not device_id:
            # Unknown packet type or too short
            if self.on_unmatched_packet:
                self.on_unmatched_packet(data, rssi, direction)
            return

        # Check for matching relay rules
        rules = self._rules.get(device_id.upper())
        if not rules:
            # No relay rules for this device
            if self.on_unmatched_packet:
                self.on_unmatched_packet(data, rssi, direction)
            return

        # Determine packet category
        is_button = 0x88 <= pkt_type <= 0x8B
        is_level = (pkt_type in (0x81, 0x82, 0x83) and len(data) > 7 and data[7] == 0x0E)
        is_state = (pkt_type in (0x81, 0x82, 0x83) and not is_level)

        # Create deduplication key from packet content (excluding sequence number)
        # For SET_LEVEL: (device_id, pkt_type, level)
        # For buttons: (device_id, pkt_type, button_code)
        # For state: (device_id, pkt_type, level)
        dedup_key = self._get_dedup_key(data, pkt_type, device_id)
        now = time.time()

        # Check for duplicate within window
        if dedup_key in self._recent_relays:
            last_relay = self._recent_relays[dedup_key]
            age_ms = (now - last_relay) * 1000
            if age_ms < self._dedup_window_ms:
                logger.debug(f"[RELAY] Dedup: skipping duplicate packet (age={age_ms:.0f}ms)")
                # Don't pass to normal handler - we already relayed this command
                # This prevents ProxyEngine from also processing it
                return

        # Process each matching rule
        for rule in rules:
            # Check if this packet type is relayed
            if is_button and not rule.relay_buttons:
                logger.debug(f"[RELAY] Skipping button relay for rule {rule.name}")
                continue
            if (is_level or is_state) and not rule.relay_level:
                logger.debug(f"[RELAY] Skipping level relay for rule {rule.name}")
                continue

            logger.info(f"[RELAY] Matched rule '{rule.name}': {rule.source_device_id} -> {rule.target_device_id}")

            # Mark as relayed for deduplication
            self._recent_relays[dedup_key] = now

            # Rewrite packet and transmit
            rewritten = self._rewrite_packet(data, pkt_type, rule)
            if rewritten:
                logger.debug(f"[RELAY] TX: {' '.join(f'{b:02X}' for b in rewritten[:16])}...")
                self._transmit_packet(rewritten)

                # Update stats
                self.stats.packets_relayed += 1
                latency_ms = (time.time() - start_time) * 1000
                self.stats.last_relay_latency_ms = latency_ms

                # Running average
                self.stats.total_latency_samples += 1
                n = self.stats.total_latency_samples
                self.stats.avg_relay_latency_ms = (
                    self.stats.avg_relay_latency_ms * (n - 1) + latency_ms
                ) / n

                # Fire relay event
                if self.on_relay_event:
                    self.on_relay_event('relayed', {
                        'rule_id': rule.id,
                        'rule_name': rule.name,
                        'source_device': rule.source_device_id,
                        'target_device': rule.target_device_id,
                        'packet_type': f'0x{pkt_type:02X}',
                        'latency_ms': latency_ms
                    })

    def _get_tx_echo_key(self, data: bytes) -> bytes:
        """
        Create a key for TX echo detection.

        Uses bytes 0 + 2-15 (skipping seq at byte 1) to identify the packet.
        """
        if len(data) >= 16:
            return bytes([data[0]]) + data[2:16]
        elif len(data) >= 2:
            return bytes([data[0]]) + data[2:]
        return data

    def _get_dedup_key(self, data: bytes, pkt_type: int, device_id: str) -> tuple:
        """
        Create a deduplication key from packet content.

        Excludes sequence number (byte 1) since that changes for each retransmit.
        Includes the meaningful payload to distinguish different commands.
        """
        # For SET_LEVEL: include level value
        if 0x81 <= pkt_type <= 0x83 and len(data) > 14 and data[7] == 0x0E:
            level = data[14] if len(data) > 14 else 0
            return (device_id, 'SET_LEVEL', level)

        # For button packets: include button code
        if 0x88 <= pkt_type <= 0x8B and len(data) > 8:
            button = data[8] if len(data) > 8 else 0
            return (device_id, 'BUTTON', button)

        # For state reports: include level
        if 0x81 <= pkt_type <= 0x83 and len(data) > 8:
            level = data[8] if len(data) > 8 else 0
            return (device_id, 'STATE', level)

        # Fallback: use first 12 bytes (excluding seq at byte 1)
        key_bytes = bytes([data[0]]) + data[2:12] if len(data) >= 12 else data
        return (device_id, 'OTHER', key_bytes.hex())

    def _extract_device_id(self, data: bytes, pkt_type: int) -> Optional[str]:
        """
        Extract device ID from packet based on type.

        For relay matching purposes:
        - Button packets: use device ID at bytes 2-5 (BE) - that's the Pico sending
        - SET_LEVEL packets: use TARGET ID at bytes 9-12 (BE) - that's what we're controlling
        - State reports: use device ID at bytes 2-5 (LE) - that's the device reporting

        Returns:
            8-char hex device ID or None if can't extract
        """
        if len(data) < 6:
            return None

        # Button packets (0x88-0x8B): big-endian at bytes 2-5
        if 0x88 <= pkt_type <= 0x8B:
            device_id = struct.unpack('>I', data[2:6])[0]
            return f'{device_id:08X}'

        # State/level packets (0x81-0x83)
        if 0x81 <= pkt_type <= 0x83:
            # Check if this is SET_LEVEL (format 0x0E) - match on TARGET device
            if len(data) > 12 and data[7] == 0x0E:
                # SET_LEVEL: target at bytes 9-12 (big-endian)
                device_id = struct.unpack('>I', data[9:13])[0]
                return f'{device_id:08X}'
            else:
                # State report: device at bytes 2-5 (little-endian)
                device_id = struct.unpack('<I', data[2:6])[0]
                return f'{device_id:08X}'

        return None

    def _rewrite_packet(self, data: bytes, pkt_type: int, rule: RelayRule) -> Optional[bytes]:
        """
        Rewrite packet with new device ID and recalculate CRC.

        Args:
            data: Original packet bytes
            pkt_type: Packet type byte
            rule: Relay rule to apply

        Returns:
            Rewritten packet bytes or None if failed
        """
        # Make a mutable copy
        packet = bytearray(data)

        # Parse target device ID
        try:
            target_id = int(rule.target_device_id, 16)
        except ValueError:
            logger.error(f"Invalid target device ID: {rule.target_device_id}")
            return None

        # Update sequence number
        seq = self._get_next_sequence(rule.target_device_id)
        packet[1] = seq

        # Rewrite device ID based on packet type
        if 0x88 <= pkt_type <= 0x8B:
            # Button packets: big-endian at bytes 2-5
            struct.pack_into('>I', packet, 2, target_id)

        elif 0x81 <= pkt_type <= 0x83:
            # Check if this is a SET_LEVEL packet (format 0x0E)
            if len(packet) > 12 and packet[7] == 0x0E:
                # SET_LEVEL: source @ 2-5 (LE), target @ 9-12 (BE)
                # Source: optionally replace with target_bridge_id, otherwise keep original
                if rule.target_bridge_id:
                    try:
                        bridge_id = int(rule.target_bridge_id, 16)
                        struct.pack_into('<I', packet, 2, bridge_id)
                        logger.debug(f"[RELAY] SET_LEVEL: source -> {rule.target_bridge_id}")
                    except ValueError:
                        pass  # Keep original source

                # Target: always rewrite to the rule's target device
                struct.pack_into('>I', packet, 9, target_id)
                logger.debug(f"[RELAY] SET_LEVEL: target -> {rule.target_device_id}")
            else:
                # State report: little-endian at bytes 2-5
                struct.pack_into('<I', packet, 2, target_id)
                logger.debug(f"[RELAY] STATE_RPT: device -> {rule.target_device_id}")

        # Recalculate CRC
        if CCA_AVAILABLE:
            # Standard packets: CRC at bytes 22-23
            if len(packet) >= 24:
                crc = cca.calc_crc(bytes(packet[:22]))
                packet[22] = (crc >> 8) & 0xFF
                packet[23] = crc & 0xFF
            # Pairing packets: CRC at bytes 51-52
            elif len(packet) >= 53:
                crc = cca.calc_crc(bytes(packet[:51]))
                packet[51] = (crc >> 8) & 0xFF
                packet[52] = crc & 0xFF

        return bytes(packet)

    def _get_next_sequence(self, device_id: str) -> int:
        """Get and increment sequence number for a device."""
        current = self._sequences.get(device_id, 0)
        next_seq = (current + self.SEQUENCE_INCREMENT) % self.SEQUENCE_MAX
        self._sequences[device_id] = next_seq
        return current

    def _transmit_packet(self, packet: bytes):
        """Send TX command to ESP32 via UDP."""
        if not self._tx_socket:
            return

        # Track TX for echo suppression
        tx_key = self._get_tx_echo_key(packet)
        self._recent_tx[tx_key] = time.time()

        # Build TX command: [CMD:1][LEN:1][DATA:N]
        cmd = bytes([CMD_TX_RAW, len(packet)]) + packet

        try:
            self._tx_socket.sendto(cmd, (self.esp32_host, self.tx_port))
        except Exception as e:
            logger.error(f"Failed to send TX command: {e}")
            self.stats.packets_dropped += 1

    def _check_for_ack(self, data: bytes, pkt_type: int):
        """
        Check if an incoming state report is an ACK for a pending TX.

        State reports (0x81-0x83) from the target device indicate successful reception.
        """
        if len(data) < 6:
            return

        # Extract device ID (little-endian for state reports)
        device_id = struct.unpack('<I', data[2:6])[0]
        device_id_str = f'{device_id:08X}'

        # Check if we have a pending TX for this device
        pending = self._pending_tx.get(device_id_str)
        if pending:
            # ACK received, clear pending
            del self._pending_tx[device_id_str]
            if self.on_relay_event:
                self.on_relay_event('ack_received', {
                    'device_id': device_id_str,
                    'latency_ms': (time.time() - pending.timestamp) * 1000
                })

    def handle_state_report(self, data: bytes, rssi: int, direction: str = 'rx'):
        """
        Handle state report packets for ACK tracking (deprecated, use _check_for_ack).

        State reports (0x81-0x83) from the target device indicate successful reception.
        """
        if len(data) < 6:
            return

        pkt_type = data[0]
        if not (0x81 <= pkt_type <= 0x83):
            return

        self._check_for_ack(data, pkt_type)

    def get_stats(self) -> dict:
        """Get relay statistics."""
        return {
            'packets_received': self.stats.packets_received,
            'packets_relayed': self.stats.packets_relayed,
            'packets_dropped': self.stats.packets_dropped,
            'last_relay_latency_ms': round(self.stats.last_relay_latency_ms, 2),
            'avg_relay_latency_ms': round(self.stats.avg_relay_latency_ms, 2),
            'active_rules': len(self._rules_by_id),
            'pending_acks': len(self._pending_tx)
        }

    def get_rules(self) -> List[dict]:
        """Get all loaded rules."""
        return [
            {
                'id': rule.id,
                'name': rule.name,
                'enabled': rule.enabled,
                'source_device_id': rule.source_device_id,
                'target_device_id': rule.target_device_id,
                'target_bridge_id': rule.target_bridge_id,
                'bidirectional': rule.bidirectional,
                'relay_buttons': rule.relay_buttons,
                'relay_level': rule.relay_level
            }
            for rule in self._rules_by_id.values()
        ]

    def check_retries(self):
        """
        Periodic cleanup of deduplication and echo suppression entries.

        Call this periodically (every ~50ms).
        """
        now = time.time()

        # Clean up old deduplication entries (older than 2x window)
        max_age = self._dedup_window_ms * 2 / 1000.0
        expired_keys = [k for k, v in self._recent_relays.items() if now - v > max_age]
        for k in expired_keys:
            del self._recent_relays[k]

        # Clean up old TX echo entries
        tx_max_age = self._tx_echo_window_ms * 2 / 1000.0
        expired_tx = [k for k, v in self._recent_tx.items() if now - v > tx_max_age]
        for k in expired_tx:
            del self._recent_tx[k]


# Async wrapper for integration with asyncio event loops
class AsyncPacketRelay(PacketRelay):
    """Async-friendly packet relay with background ACK timeout handling."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._ack_task: Optional[asyncio.Task] = None

    async def start_async(self):
        """Start the relay with async ACK timeout handling."""
        self.start()
        self._ack_task = asyncio.create_task(self._ack_timeout_loop())

    async def stop_async(self):
        """Stop the relay and cancel async tasks."""
        if self._ack_task:
            self._ack_task.cancel()
            try:
                await self._ack_task
            except asyncio.CancelledError:
                pass
        self.stop()

    async def _ack_timeout_loop(self):
        """Check for ACK timeouts and retry pending TX."""
        while self._running:
            await asyncio.sleep(0.05)  # 50ms check interval

            now = time.time()
            to_retry = []
            to_drop = []

            for device_id, pending in self._pending_tx.items():
                age_ms = (now - pending.timestamp) * 1000
                if age_ms >= pending.timeout_ms:
                    if pending.retries < pending.max_retries:
                        to_retry.append(device_id)
                    else:
                        to_drop.append(device_id)

            # Retry packets
            for device_id in to_retry:
                pending = self._pending_tx[device_id]
                pending.retries += 1
                pending.timestamp = now
                self._transmit_packet(pending.packet)
                if self.on_relay_event:
                    self.on_relay_event('retry', {
                        'device_id': device_id,
                        'retry_count': pending.retries
                    })

            # Drop packets that exceeded max retries
            for device_id in to_drop:
                del self._pending_tx[device_id]
                self.stats.packets_dropped += 1
                if self.on_relay_event:
                    self.on_relay_event('dropped', {
                        'device_id': device_id,
                        'reason': 'max_retries_exceeded'
                    })
