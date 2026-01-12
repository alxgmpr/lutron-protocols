"""
SQLite Database for CCA Playground

Stores raw and decoded RF packets for persistent storage and analysis.
Supports schema migrations for future updates.

Tables:
- raw_packets: Unique raw packet bytes (deduplicated by hash)
- decoded_packets: Decoded packet data with reference to raw packet
- devices: Device registry with metadata

Packet Log Format:
    PACKET:<direction>,<type>,<device_id>,<timestamp>,<decoded_csv>,<raw_hex>

Example:
    PACKET:RX,LEVEL,002C90AF,2026-01-03T12:00:00,source=AF902C00|target=002C90AF|level=50,81 00 01 AF 90 2C 00 ...
"""

import sqlite3
import hashlib
import json
import os
from datetime import datetime
from typing import Optional, Dict, List, Tuple, Any
from contextlib import contextmanager

# Database file location
DB_FILE = os.path.join(os.path.dirname(__file__), "cca_playground.db")

# Current schema version - increment when making breaking changes
SCHEMA_VERSION = 3

def get_connection() -> sqlite3.Connection:
    """Get a database connection with row factory."""
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

@contextmanager
def get_db():
    """Context manager for database connections."""
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def init_db():
    """Initialize database with schema."""
    with get_db() as conn:
        # Check current schema version
        try:
            result = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
            current_version = int(result['value']) if result else 0
        except sqlite3.OperationalError:
            current_version = 0

        # Run migrations
        if current_version < SCHEMA_VERSION:
            _run_migrations(conn, current_version)

def _run_migrations(conn: sqlite3.Connection, from_version: int):
    """Run database migrations from from_version to SCHEMA_VERSION."""

    if from_version < 1:
        # Initial schema
        conn.executescript("""
            -- Meta table for schema versioning
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            -- Raw packets - stores unique raw bytes (deduplicated)
            CREATE TABLE IF NOT EXISTS raw_packets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hash TEXT UNIQUE NOT NULL,           -- SHA256 of raw_bytes for deduplication
                raw_bytes BLOB NOT NULL,             -- Raw packet bytes
                raw_hex TEXT NOT NULL,               -- Hex string for display
                byte_count INTEGER NOT NULL,         -- Length of packet
                first_seen TEXT NOT NULL,            -- ISO timestamp
                last_seen TEXT NOT NULL,             -- ISO timestamp
                seen_count INTEGER DEFAULT 1,        -- How many times seen
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_raw_packets_hash ON raw_packets(hash);
            CREATE INDEX IF NOT EXISTS idx_raw_packets_first_seen ON raw_packets(first_seen);

            -- Decoded packets - stores parsed packet data
            CREATE TABLE IF NOT EXISTS decoded_packets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                raw_packet_id INTEGER,               -- Reference to raw_packets (nullable for TX)
                direction TEXT NOT NULL,             -- 'rx' or 'tx'
                packet_type TEXT NOT NULL,           -- LEVEL, BTN_SHORT_A, BEACON, etc.
                device_id TEXT,                      -- Primary device ID (8 hex chars)
                source_id TEXT,                      -- Source device (for LEVEL packets)
                target_id TEXT,                      -- Target device (for LEVEL packets)
                level INTEGER,                       -- Level value 0-100 (for LEVEL/STATE_RPT)
                button TEXT,                         -- Button name (ON, OFF, RAISE, etc.)
                rssi INTEGER,                        -- Signal strength (RX only)
                timestamp TEXT NOT NULL,             -- ISO timestamp
                decoded_data TEXT,                   -- JSON of all decoded fields
                raw_hex TEXT,                        -- Copy of raw hex for convenience
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (raw_packet_id) REFERENCES raw_packets(id)
            );
            CREATE INDEX IF NOT EXISTS idx_decoded_device ON decoded_packets(device_id);
            CREATE INDEX IF NOT EXISTS idx_decoded_type ON decoded_packets(packet_type);
            CREATE INDEX IF NOT EXISTS idx_decoded_timestamp ON decoded_packets(timestamp);
            CREATE INDEX IF NOT EXISTS idx_decoded_direction ON decoded_packets(direction);

            -- Devices - stores device registry with user metadata
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,                 -- Device ID (8 hex chars)
                label TEXT,                          -- User-friendly name
                device_type TEXT DEFAULT 'auto',     -- pico-5btn, dimmer, etc.
                model TEXT,                          -- Lutron model number
                link_id TEXT,                        -- Bridge pairing ID (4 hex chars)
                bridge_id TEXT,                      -- Controlling bridge ID
                factory_id TEXT,                     -- Factory/hardware ID
                category TEXT,                       -- pico, dimmer, bridge_controlled, etc.
                controllable INTEGER DEFAULT 0,      -- Can we send commands to it
                first_seen TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                packet_count INTEGER DEFAULT 0,
                info TEXT,                           -- JSON of additional info
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_devices_label ON devices(label);
            CREATE INDEX IF NOT EXISTS idx_devices_link_id ON devices(link_id);
            CREATE INDEX IF NOT EXISTS idx_devices_category ON devices(category);

            -- Set schema version
            INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1');
        """)
        print(f"[DATABASE] Initialized schema version 1")

    if from_version < 2:
        # Schema v2: Add MQTT, proxy, virtual devices, and events tables
        conn.executescript("""
            -- MQTT configuration (singleton row)
            CREATE TABLE IF NOT EXISTS mqtt_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                enabled INTEGER DEFAULT 0,
                broker_host TEXT DEFAULT 'homeassistant.local',
                broker_port INTEGER DEFAULT 1883,
                username TEXT,
                password TEXT,
                discovery_prefix TEXT DEFAULT 'homeassistant',
                client_id TEXT DEFAULT 'cca_playground',
                retain_state INTEGER DEFAULT 1,
                publish_raw INTEGER DEFAULT 0,
                updated_at TEXT DEFAULT (datetime('now'))
            );

            -- Seed default MQTT config
            INSERT OR IGNORE INTO mqtt_config (id) VALUES (1);

            -- Proxy rules: source device -> target device(s)
            CREATE TABLE IF NOT EXISTS proxy_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                enabled INTEGER DEFAULT 1,
                source_device_id TEXT NOT NULL,
                source_type TEXT NOT NULL,
                target_device_id TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_bridge_id TEXT,
                mode TEXT DEFAULT 'forward',
                button_map TEXT,
                level_transform TEXT,
                debounce_ms INTEGER DEFAULT 100,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_proxy_source ON proxy_rules(source_device_id);
            CREATE INDEX IF NOT EXISTS idx_proxy_target ON proxy_rules(target_device_id);
            CREATE INDEX IF NOT EXISTS idx_proxy_enabled ON proxy_rules(enabled);

            -- Virtual devices: fake dimmers/picos the ESP32 emulates
            CREATE TABLE IF NOT EXISTS virtual_devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                device_type TEXT NOT NULL,
                subnet TEXT,
                current_level INTEGER DEFAULT 0,
                last_command_at TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );

            -- Semantic events log
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                device_id TEXT NOT NULL,
                details TEXT,
                packet_ids TEXT,
                timestamp TEXT NOT NULL,
                published_mqtt INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
            CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
            CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

            -- Update schema version
            UPDATE meta SET value = '2' WHERE key = 'schema_version';
        """)
        print(f"[DATABASE] Migrated to schema version 2 (MQTT, proxy, virtual devices, events)")

    if from_version < 3:
        # Schema v3: Add target_bridge_id to proxy_rules for multi-bridge setups
        # Check if column exists first (in case table was created fresh with new schema)
        cursor = conn.execute("PRAGMA table_info(proxy_rules)")
        columns = [row[1] for row in cursor.fetchall()]
        if 'target_bridge_id' not in columns:
            conn.execute("ALTER TABLE proxy_rules ADD COLUMN target_bridge_id TEXT")
        conn.execute("UPDATE meta SET value = '3' WHERE key = 'schema_version'")
        print(f"[DATABASE] Migrated to schema version 3 (proxy rule target_bridge_id)")

def compute_packet_hash(raw_bytes: bytes) -> str:
    """Compute SHA256 hash of raw packet bytes."""
    return hashlib.sha256(raw_bytes).hexdigest()

def bytes_to_hex(raw_bytes: bytes) -> str:
    """Convert bytes to space-separated hex string."""
    return ' '.join(f'{b:02X}' for b in raw_bytes)

def hex_to_bytes(hex_str: str) -> bytes:
    """Convert space-separated hex string to bytes."""
    hex_str = hex_str.replace(' ', '').replace('\n', '')
    return bytes.fromhex(hex_str)

# ═══════════════════════════════════════════════════════════════════════════════
# RAW PACKETS
# ═══════════════════════════════════════════════════════════════════════════════

def insert_raw_packet(raw_hex: str, timestamp: Optional[str] = None) -> Tuple[int, bool]:
    """Insert a raw packet, returning (id, is_new).

    Deduplicates by hash - if packet already exists, updates seen_count and last_seen.
    """
    raw_bytes = hex_to_bytes(raw_hex)
    packet_hash = compute_packet_hash(raw_bytes)
    timestamp = timestamp or datetime.now().isoformat()

    with get_db() as conn:
        # Check if exists
        existing = conn.execute(
            "SELECT id FROM raw_packets WHERE hash = ?", (packet_hash,)
        ).fetchone()

        if existing:
            # Update existing
            conn.execute("""
                UPDATE raw_packets
                SET seen_count = seen_count + 1, last_seen = ?
                WHERE id = ?
            """, (timestamp, existing['id']))
            return existing['id'], False
        else:
            # Insert new
            cursor = conn.execute("""
                INSERT INTO raw_packets (hash, raw_bytes, raw_hex, byte_count, first_seen, last_seen)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (packet_hash, raw_bytes, raw_hex, len(raw_bytes), timestamp, timestamp))
            return cursor.lastrowid, True

def get_raw_packet(packet_id: int) -> Optional[Dict]:
    """Get a raw packet by ID."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM raw_packets WHERE id = ?", (packet_id,)
        ).fetchone()
        return dict(row) if row else None

def get_raw_packets(limit: int = 100, offset: int = 0) -> List[Dict]:
    """Get recent raw packets."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT * FROM raw_packets
            ORDER BY last_seen DESC
            LIMIT ? OFFSET ?
        """, (limit, offset)).fetchall()
        return [dict(row) for row in rows]

# ═══════════════════════════════════════════════════════════════════════════════
# DECODED PACKETS
# ═══════════════════════════════════════════════════════════════════════════════

def insert_decoded_packet(
    direction: str,
    packet_type: str,
    timestamp: str,
    raw_hex: Optional[str] = None,
    device_id: Optional[str] = None,
    source_id: Optional[str] = None,
    target_id: Optional[str] = None,
    level: Optional[int] = None,
    button: Optional[str] = None,
    rssi: Optional[int] = None,
    decoded_data: Optional[Dict] = None
) -> int:
    """Insert a decoded packet record."""

    # If we have raw bytes, insert/update raw_packets first
    raw_packet_id = None
    if raw_hex:
        raw_packet_id, _ = insert_raw_packet(raw_hex, timestamp)

    with get_db() as conn:
        cursor = conn.execute("""
            INSERT INTO decoded_packets
            (raw_packet_id, direction, packet_type, device_id, source_id, target_id,
             level, button, rssi, timestamp, decoded_data, raw_hex)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            raw_packet_id, direction, packet_type, device_id, source_id, target_id,
            level, button, rssi, timestamp,
            json.dumps(decoded_data) if decoded_data else None,
            raw_hex
        ))
        return cursor.lastrowid

def get_decoded_packets(
    direction: Optional[str] = None,
    packet_type: Optional[str] = None,
    device_id: Optional[str] = None,
    subnet: Optional[str] = None,
    limit: int = 100,
    offset: int = 0
) -> List[Dict]:
    """Query decoded packets with optional filters.

    Args:
        direction: 'rx' or 'tx'
        packet_type: LEVEL, BTN_SHORT_A, STATE_RPT, etc.
        device_id: Match device_id, source_id, or target_id
        subnet: Match subnet in source_id (for LEVEL commands to a zone)
        limit: Max results
        offset: Pagination offset
    """
    conditions = []
    params = []

    if direction:
        conditions.append("direction = ?")
        params.append(direction)
    if packet_type:
        conditions.append("packet_type = ?")
        params.append(packet_type)
    if device_id:
        conditions.append("(device_id = ? OR source_id = ? OR target_id = ?)")
        params.extend([device_id, device_id, device_id])
    if subnet:
        # Subnet is stored in source_id bytes 1-2 (little-endian)
        # e.g., subnet "902C" matches source_id "??2C90??" (bytes 1-2 reversed)
        # Convert subnet to little-endian pattern for LIKE query
        if len(subnet) == 4:
            subnet_lo = subnet[2:4]
            subnet_hi = subnet[0:2]
            # Match source_id where bytes 1-2 are subnet_lo + subnet_hi
            pattern = f"__{subnet_lo}{subnet_hi}__"
            conditions.append("source_id LIKE ?")
            params.append(pattern)

    where_clause = " AND ".join(conditions) if conditions else "1=1"

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT * FROM decoded_packets
            WHERE {where_clause}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        """, (*params, limit, offset)).fetchall()

        results = []
        for row in rows:
            d = dict(row)
            if d['decoded_data']:
                d['decoded_data'] = json.loads(d['decoded_data'])
            results.append(d)
        return results

# ═══════════════════════════════════════════════════════════════════════════════
# DEVICES
# ═══════════════════════════════════════════════════════════════════════════════

def upsert_device(
    device_id: str,
    category: Optional[str] = None,
    bridge_id: Optional[str] = None,
    factory_id: Optional[str] = None,
    info: Optional[Dict] = None
) -> Dict:
    """Insert or update a device record."""
    now = datetime.now().isoformat()

    # Compute link_id from device_id or bridge_id
    link_id = None
    if bridge_id:
        try:
            id_str = bridge_id.replace('0x', '').replace('0X', '')
            id_num = int(id_str, 16)
            link_id = f"{(id_num >> 8) & 0xFFFF:04X}"
        except:
            pass

    with get_db() as conn:
        existing = conn.execute(
            "SELECT * FROM devices WHERE id = ?", (device_id,)
        ).fetchone()

        if existing:
            # Update existing
            updates = ["last_seen = ?", "packet_count = packet_count + 1", "updated_at = ?"]
            params = [now, now]

            if category:
                updates.append("category = ?")
                params.append(category)
            if bridge_id:
                updates.append("bridge_id = ?")
                params.append(bridge_id)
            if factory_id:
                updates.append("factory_id = ?")
                params.append(factory_id)
            if link_id:
                updates.append("link_id = ?")
                params.append(link_id)
            if info:
                # Merge with existing info
                existing_info = json.loads(existing['info']) if existing['info'] else {}
                existing_info.update(info)
                updates.append("info = ?")
                params.append(json.dumps(existing_info))

            params.append(device_id)
            conn.execute(f"UPDATE devices SET {', '.join(updates)} WHERE id = ?", params)
        else:
            # Insert new
            conn.execute("""
                INSERT INTO devices (id, link_id, bridge_id, factory_id, category, controllable,
                                    first_seen, last_seen, packet_count, info)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            """, (
                device_id, link_id, bridge_id, factory_id, category,
                1 if category in ('pico', 'scene_pico', 'bridge_controlled') else 0,
                now, now,
                json.dumps(info) if info else None
            ))

    # Get device after commit (outside the with block)
    return get_device(device_id)

def get_device(device_id: str) -> Optional[Dict]:
    """Get a device by ID."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if row:
            d = dict(row)
            if d['info']:
                d['info'] = json.loads(d['info'])
            return d
        return None

def get_all_devices() -> Dict[str, Dict]:
    """Get all devices as a dictionary keyed by ID."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM devices ORDER BY last_seen DESC").fetchall()
        result = {}
        for row in rows:
            d = dict(row)
            if d['info']:
                d['info'] = json.loads(d['info'])
            # Convert to match existing API format
            result[d['id']] = {
                'id': d['id'],
                'type': d['category'] or 'unknown',
                'label': d['label'],
                'device_type': d['device_type'],
                'model': d['model'],
                'link_id': d['link_id'],
                'bridge_id': d['bridge_id'],
                'first_seen': d['first_seen'],
                'last_seen': d['last_seen'],
                'count': d['packet_count'],
                'info': d['info'] or {}
            }
        return result

def update_device_label(device_id: str, label: str) -> bool:
    """Set a device label."""
    with get_db() as conn:
        cursor = conn.execute(
            "UPDATE devices SET label = ?, updated_at = ? WHERE id = ?",
            (label, datetime.now().isoformat(), device_id)
        )
        return cursor.rowcount > 0

def update_device_type(device_id: str, device_type: str) -> bool:
    """Set a device type."""
    with get_db() as conn:
        cursor = conn.execute(
            "UPDATE devices SET device_type = ?, updated_at = ? WHERE id = ?",
            (device_type, datetime.now().isoformat(), device_id)
        )
        return cursor.rowcount > 0

def update_device_model(device_id: str, model: str) -> bool:
    """Set a device model."""
    with get_db() as conn:
        cursor = conn.execute(
            "UPDATE devices SET model = ?, updated_at = ? WHERE id = ?",
            (model, datetime.now().isoformat(), device_id)
        )
        return cursor.rowcount > 0

def delete_device(device_id: str) -> bool:
    """Delete a device."""
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        return cursor.rowcount > 0

def clear_all_devices() -> int:
    """Clear all devices, return count deleted."""
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM devices")
        return cursor.rowcount

def get_bridge_pairings() -> List[str]:
    """Get all unique bridge pairing IDs."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT link_id FROM devices WHERE link_id IS NOT NULL ORDER BY link_id"
        ).fetchall()
        return [row['link_id'] for row in rows]

# ═══════════════════════════════════════════════════════════════════════════════
# PACKET LOG FORMAT PARSING
# ═══════════════════════════════════════════════════════════════════════════════

def parse_packet_log(log_line: str) -> Optional[Dict]:
    """Parse a PACKET: log line into structured data.

    Format: PACKET:<direction>,<type>,<device_id>,<timestamp>,<decoded_csv>,<raw_hex>

    The decoded_csv field uses | as separator for key=value pairs.

    Example:
        PACKET:RX,LEVEL,002C90AF,2026-01-03T12:00:00,source=AF902C00|target=002C90AF|level=50,81 00 01 ...

    Returns dict with all parsed fields, or None if not a PACKET line.
    """
    if not log_line.startswith('PACKET:'):
        return None

    try:
        # Remove prefix and split by comma
        content = log_line[7:]  # Remove "PACKET:"
        parts = content.split(',', 5)  # Max 6 parts

        if len(parts) < 4:
            return None

        direction = parts[0].lower()
        packet_type = parts[1]
        device_id = parts[2]
        timestamp = parts[3]
        decoded_csv = parts[4] if len(parts) > 4 else ""
        raw_hex = parts[5] if len(parts) > 5 else ""

        # Parse decoded CSV (key=value|key=value)
        decoded_data = {}
        if decoded_csv:
            for pair in decoded_csv.split('|'):
                if '=' in pair:
                    key, value = pair.split('=', 1)
                    decoded_data[key.strip()] = value.strip()

        return {
            'direction': direction,
            'packet_type': packet_type,
            'device_id': device_id,
            'timestamp': timestamp,
            'decoded_data': decoded_data,
            'raw_hex': raw_hex,
            'source_id': decoded_data.get('source'),
            'target_id': decoded_data.get('target'),
            'level': int(decoded_data['level']) if 'level' in decoded_data else None,
            'button': decoded_data.get('button'),
            'rssi': int(decoded_data['rssi']) if 'rssi' in decoded_data else None,
        }
    except Exception as e:
        print(f"[DATABASE] Error parsing packet log: {e}")
        return None

def format_packet_log(
    direction: str,
    packet_type: str,
    device_id: str,
    decoded_data: Dict,
    raw_hex: str = ""
) -> str:
    """Format packet data into PACKET: log line.

    Returns: PACKET:<direction>,<type>,<device_id>,<timestamp>,<decoded_csv>,<raw_hex>
    """
    timestamp = datetime.now().isoformat()

    # Convert decoded_data dict to CSV format
    decoded_csv = '|'.join(f"{k}={v}" for k, v in decoded_data.items() if v is not None)

    return f"PACKET:{direction.upper()},{packet_type},{device_id},{timestamp},{decoded_csv},{raw_hex}"

def process_packet_log(log_line: str) -> Optional[int]:
    """Process a PACKET: log line and store in database.

    Returns the decoded_packet ID if successful, None otherwise.
    """
    parsed = parse_packet_log(log_line)
    if not parsed:
        return None

    # Insert decoded packet
    packet_id = insert_decoded_packet(
        direction=parsed['direction'],
        packet_type=parsed['packet_type'],
        timestamp=parsed['timestamp'],
        raw_hex=parsed['raw_hex'],
        device_id=parsed['device_id'],
        source_id=parsed['source_id'],
        target_id=parsed['target_id'],
        level=parsed['level'],
        button=parsed['button'],
        rssi=parsed['rssi'],
        decoded_data=parsed['decoded_data']
    )

    # Also update device registry
    if parsed['device_id']:
        upsert_device(
            device_id=parsed['device_id'],
            category=_infer_category(parsed['packet_type'], parsed['decoded_data']),
            bridge_id=parsed['source_id'] if parsed['packet_type'] == 'LEVEL' else None,
            factory_id=parsed['target_id'] if parsed['packet_type'] == 'LEVEL' else parsed['device_id'],
            info=parsed['decoded_data']
        )

    return packet_id

def _infer_category(packet_type: str, decoded_data: Dict) -> str:
    """Infer device category from packet type."""
    if packet_type == 'LEVEL':
        return 'bridge_controlled'
    elif packet_type == 'STATE_RPT':
        return 'dimmer_passive'
    elif packet_type.startswith('BTN_'):
        if decoded_data.get('button', '').startswith('SCENE'):
            return 'scene_pico'
        return 'pico'
    elif packet_type.startswith('BEACON'):
        return 'beacon'
    elif packet_type.startswith('PAIR'):
        return 'pairing'
    return 'unknown'

# ═══════════════════════════════════════════════════════════════════════════════
# STATISTICS
# ═══════════════════════════════════════════════════════════════════════════════

def get_stats() -> Dict:
    """Get database statistics."""
    with get_db() as conn:
        stats = {
            'raw_packets': conn.execute("SELECT COUNT(*) as c FROM raw_packets").fetchone()['c'],
            'decoded_packets': conn.execute("SELECT COUNT(*) as c FROM decoded_packets").fetchone()['c'],
            'devices': conn.execute("SELECT COUNT(*) as c FROM devices").fetchone()['c'],
            'rx_packets': conn.execute("SELECT COUNT(*) as c FROM decoded_packets WHERE direction='rx'").fetchone()['c'],
            'tx_packets': conn.execute("SELECT COUNT(*) as c FROM decoded_packets WHERE direction='tx'").fetchone()['c'],
        }

        # Get packet type breakdown
        rows = conn.execute("""
            SELECT packet_type, COUNT(*) as count
            FROM decoded_packets
            GROUP BY packet_type
            ORDER BY count DESC
        """).fetchall()
        stats['packet_types'] = {row['packet_type']: row['count'] for row in rows}

        return stats

# ===============================================================================
# MQTT CONFIGURATION
# ===============================================================================

def get_mqtt_config() -> Optional[Dict]:
    """Get MQTT configuration (singleton row)."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM mqtt_config WHERE id = 1").fetchone()
        if row:
            return dict(row)
        return None

def update_mqtt_config(**kwargs) -> bool:
    """Update MQTT configuration fields."""
    if not kwargs:
        return False

    valid_fields = {'enabled', 'broker_host', 'broker_port', 'username', 'password',
                    'discovery_prefix', 'client_id', 'retain_state', 'publish_raw'}

    updates = []
    params = []
    for key, value in kwargs.items():
        if key in valid_fields:
            updates.append(f"{key} = ?")
            params.append(value)

    if not updates:
        return False

    updates.append("updated_at = ?")
    params.append(datetime.now().isoformat())

    with get_db() as conn:
        conn.execute(f"UPDATE mqtt_config SET {', '.join(updates)} WHERE id = 1", params)
        return True

# ===============================================================================
# PROXY RULES
# ===============================================================================

def get_proxy_rules(enabled_only: bool = False) -> List[Dict]:
    """Get all proxy rules."""
    with get_db() as conn:
        if enabled_only:
            rows = conn.execute(
                "SELECT * FROM proxy_rules WHERE enabled = 1 ORDER BY created_at"
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM proxy_rules ORDER BY created_at").fetchall()

        results = []
        for row in rows:
            d = dict(row)
            if d['button_map']:
                d['button_map'] = json.loads(d['button_map'])
            if d['level_transform']:
                d['level_transform'] = json.loads(d['level_transform'])
            results.append(d)
        return results

def get_proxy_rule(rule_id: int) -> Optional[Dict]:
    """Get a proxy rule by ID."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM proxy_rules WHERE id = ?", (rule_id,)).fetchone()
        if row:
            d = dict(row)
            if d['button_map']:
                d['button_map'] = json.loads(d['button_map'])
            if d['level_transform']:
                d['level_transform'] = json.loads(d['level_transform'])
            return d
        return None

def get_proxy_rules_for_source(source_device_id: str) -> List[Dict]:
    """Get all enabled proxy rules for a source device."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM proxy_rules WHERE source_device_id = ? AND enabled = 1",
            (source_device_id,)
        ).fetchall()

        results = []
        for row in rows:
            d = dict(row)
            if d['button_map']:
                d['button_map'] = json.loads(d['button_map'])
            if d['level_transform']:
                d['level_transform'] = json.loads(d['level_transform'])
            results.append(d)
        return results

def create_proxy_rule(
    name: str,
    source_device_id: str,
    source_type: str,
    target_device_id: str,
    target_type: str,
    target_bridge_id: Optional[str] = None,
    mode: str = 'forward',
    button_map: Optional[Dict] = None,
    level_transform: Optional[Dict] = None,
    debounce_ms: int = 100,
    enabled: bool = True
) -> int:
    """Create a new proxy rule, return its ID."""
    with get_db() as conn:
        cursor = conn.execute("""
            INSERT INTO proxy_rules
            (name, enabled, source_device_id, source_type, target_device_id, target_type,
             target_bridge_id, mode, button_map, level_transform, debounce_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            name, 1 if enabled else 0, source_device_id, source_type,
            target_device_id, target_type, target_bridge_id, mode,
            json.dumps(button_map) if button_map else None,
            json.dumps(level_transform) if level_transform else None,
            debounce_ms
        ))
        return cursor.lastrowid

def update_proxy_rule(rule_id: int, **kwargs) -> bool:
    """Update a proxy rule."""
    valid_fields = {'name', 'enabled', 'source_device_id', 'source_type',
                    'target_device_id', 'target_type', 'target_bridge_id',
                    'mode', 'button_map', 'level_transform', 'debounce_ms'}

    updates = []
    params = []
    for key, value in kwargs.items():
        if key in valid_fields:
            if key in ('button_map', 'level_transform') and value is not None:
                value = json.dumps(value)
            updates.append(f"{key} = ?")
            params.append(value)

    if not updates:
        return False

    updates.append("updated_at = ?")
    params.append(datetime.now().isoformat())
    params.append(rule_id)

    with get_db() as conn:
        cursor = conn.execute(
            f"UPDATE proxy_rules SET {', '.join(updates)} WHERE id = ?",
            params
        )
        return cursor.rowcount > 0

def toggle_proxy_rule(rule_id: int) -> bool:
    """Toggle a proxy rule's enabled state."""
    with get_db() as conn:
        conn.execute(
            "UPDATE proxy_rules SET enabled = 1 - enabled, updated_at = ? WHERE id = ?",
            (datetime.now().isoformat(), rule_id)
        )
        return True

def delete_proxy_rule(rule_id: int) -> bool:
    """Delete a proxy rule."""
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM proxy_rules WHERE id = ?", (rule_id,))
        return cursor.rowcount > 0

# ===============================================================================
# VIRTUAL DEVICES
# ===============================================================================

def get_virtual_devices() -> List[Dict]:
    """Get all virtual devices."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM virtual_devices ORDER BY created_at").fetchall()
        return [dict(row) for row in rows]

def get_virtual_device(device_id: str) -> Optional[Dict]:
    """Get a virtual device by ID."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM virtual_devices WHERE id = ?", (device_id,)
        ).fetchone()
        return dict(row) if row else None

def create_virtual_device(
    device_id: str,
    name: str,
    device_type: str,
    subnet: Optional[str] = None
) -> str:
    """Create a virtual device, return its ID."""
    with get_db() as conn:
        conn.execute("""
            INSERT INTO virtual_devices (id, name, device_type, subnet)
            VALUES (?, ?, ?, ?)
        """, (device_id, name, device_type, subnet))
        return device_id

def update_virtual_device_level(device_id: str, level: int) -> bool:
    """Update a virtual device's current level."""
    with get_db() as conn:
        cursor = conn.execute(
            "UPDATE virtual_devices SET current_level = ?, last_command_at = ? WHERE id = ?",
            (level, datetime.now().isoformat(), device_id)
        )
        return cursor.rowcount > 0

def delete_virtual_device(device_id: str) -> bool:
    """Delete a virtual device."""
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM virtual_devices WHERE id = ?", (device_id,))
        return cursor.rowcount > 0

def is_virtual_device(device_id: str) -> bool:
    """Check if a device ID belongs to a virtual device."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT 1 FROM virtual_devices WHERE id = ?", (device_id,)
        ).fetchone()
        return row is not None

# ===============================================================================
# EVENTS
# ===============================================================================

def insert_event(
    event_type: str,
    device_id: str,
    details: Optional[Dict] = None,
    packet_ids: Optional[List[int]] = None,
    timestamp: Optional[str] = None
) -> int:
    """Insert a semantic event, return its ID."""
    timestamp = timestamp or datetime.now().isoformat()

    with get_db() as conn:
        cursor = conn.execute("""
            INSERT INTO events (event_type, device_id, details, packet_ids, timestamp)
            VALUES (?, ?, ?, ?, ?)
        """, (
            event_type, device_id,
            json.dumps(details) if details else None,
            json.dumps(packet_ids) if packet_ids else None,
            timestamp
        ))
        return cursor.lastrowid

def get_events(
    limit: int = 100,
    device_id: Optional[str] = None,
    event_type: Optional[str] = None,
    since: Optional[str] = None
) -> List[Dict]:
    """Get recent events with optional filters."""
    conditions = []
    params = []

    if device_id:
        conditions.append("device_id = ?")
        params.append(device_id)
    if event_type:
        conditions.append("event_type = ?")
        params.append(event_type)
    if since:
        conditions.append("timestamp > ?")
        params.append(since)

    where_clause = " AND ".join(conditions) if conditions else "1=1"
    params.append(limit)

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT * FROM events
            WHERE {where_clause}
            ORDER BY timestamp DESC
            LIMIT ?
        """, params).fetchall()

        results = []
        for row in rows:
            d = dict(row)
            if d['details']:
                d['details'] = json.loads(d['details'])
            if d['packet_ids']:
                d['packet_ids'] = json.loads(d['packet_ids'])
            results.append(d)
        return results

def mark_event_published(event_id: int) -> bool:
    """Mark an event as published to MQTT."""
    with get_db() as conn:
        cursor = conn.execute(
            "UPDATE events SET published_mqtt = 1 WHERE id = ?", (event_id,)
        )
        return cursor.rowcount > 0

def get_unpublished_events(limit: int = 100) -> List[Dict]:
    """Get events that haven't been published to MQTT."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT * FROM events
            WHERE published_mqtt = 0
            ORDER BY timestamp ASC
            LIMIT ?
        """, (limit,)).fetchall()

        results = []
        for row in rows:
            d = dict(row)
            if d['details']:
                d['details'] = json.loads(d['details'])
            if d['packet_ids']:
                d['packet_ids'] = json.loads(d['packet_ids'])
            results.append(d)
        return results

# Initialize on import
init_db()
