/**
 * Packet parsing utilities for Lutron CCA protocol.
 * Extracted for testability.
 */

// Packet byte field definitions
export interface ByteField {
  name: string
  start: number
  end: number  // exclusive
  format?: 'hex' | 'decimal' | 'device_id' | 'device_id_be' | 'level_16bit' | 'level_byte' | 'button' | 'action'
}

// STATE_RPT: Dimmer broadcasting its current level
export const STATE_RPT_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Device ID', start: 2, end: 6, format: 'device_id' },
  { name: 'Format', start: 6, end: 8, format: 'hex' },
  { name: 'Fixed', start: 8, end: 11, format: 'hex' },
  { name: 'Level', start: 11, end: 12, format: 'level_byte' },
  { name: 'Fixed', start: 12, end: 16, format: 'hex' },
  { name: 'Padding', start: 16, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

// LEVEL: Bridge sending level command to dimmer
export const LEVEL_CMD_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Source ID', start: 2, end: 6, format: 'device_id' },
  { name: 'Format', start: 6, end: 8, format: 'hex' },
  { name: 'Fixed', start: 8, end: 9, format: 'hex' },
  { name: 'Target ID', start: 9, end: 13, format: 'device_id_be' },
  { name: 'Fixed', start: 13, end: 16, format: 'hex' },
  { name: 'Level', start: 16, end: 18, format: 'level_16bit' },
  { name: 'Trailer', start: 18, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

// UNPAIR: Bridge removing a device from the network
export const UNPAIR_CMD_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Bridge Zone', start: 2, end: 6, format: 'device_id' },
  { name: 'Protocol', start: 6, end: 7, format: 'hex' },
  { name: 'Format', start: 7, end: 8, format: 'hex' },
  { name: 'Fixed', start: 8, end: 9, format: 'hex' },
  { name: 'Broadcast', start: 9, end: 14, format: 'hex' },
  { name: 'Command', start: 14, end: 16, format: 'hex' },
  { name: 'Target ID', start: 16, end: 20, format: 'device_id_be' },
  { name: 'Padding', start: 20, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

// BTN: Button press packets
// Note: Device ID is stored little-endian (reversed from label)
export const BUTTON_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Device ID', start: 2, end: 6, format: 'device_id' },  // Little-endian
  { name: 'Protocol', start: 6, end: 8, format: 'hex' },
  { name: 'Fixed', start: 8, end: 10, format: 'hex' },
  { name: 'Button', start: 10, end: 11, format: 'button' },
  { name: 'Action', start: 11, end: 12, format: 'action' },
  { name: 'Payload', start: 12, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

// BEACON: Bridge pairing beacon
export const BEACON_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Load ID', start: 2, end: 6, format: 'device_id_be' },
  { name: 'Format', start: 6, end: 8, format: 'hex' },
  { name: 'Fixed', start: 8, end: 9, format: 'hex' },
  { name: 'Broadcast', start: 9, end: 14, format: 'hex' },
  { name: 'Fixed', start: 14, end: 20, format: 'hex' },
  { name: 'Padding', start: 20, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

// PAIRING: Pico pairing packets (53 bytes)
export const PAIRING_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Device ID', start: 2, end: 6, format: 'device_id_be' },
  { name: 'Format', start: 6, end: 8, format: 'hex' },
  { name: 'Fixed', start: 8, end: 10, format: 'hex' },
  { name: 'Btn Scheme', start: 10, end: 11, format: 'hex' },
  { name: 'Fixed', start: 11, end: 13, format: 'hex' },
  { name: 'Broadcast', start: 13, end: 18, format: 'hex' },
  { name: 'Fixed', start: 18, end: 20, format: 'hex' },
  { name: 'Device ID 2', start: 20, end: 24, format: 'device_id_be' },
  { name: 'Device ID 3', start: 24, end: 28, format: 'device_id_be' },
  { name: 'Capabilities', start: 28, end: 41, format: 'hex' },
  { name: 'Broadcast 2', start: 41, end: 45, format: 'hex' },
  { name: 'Padding', start: 45, end: 51, format: 'hex' },
  { name: 'CRC', start: 51, end: 53, format: 'hex' },
]

export const BUTTON_NAMES: Record<string, string> = {
  '02': 'ON', '03': 'FAV', '04': 'OFF', '05': 'RAISE', '06': 'LOWER',
  '08': 'SCENE1', '09': 'SCENE2', '0A': 'SCENE3', '0B': 'SCENE4',
}

export const ACTION_NAMES: Record<string, string> = {
  '00': 'PRESS', '01': 'RELEASE', '03': 'SAVE'
}

export const PACKET_TYPE_NAMES: Record<string, string> = {
  // STATE_RPT: Dimmer reporting its current level (format byte 0x08)
  '81': 'STATE_RPT', '82': 'STATE_RPT', '83': 'STATE_RPT',
  '88': 'BTN_SHORT_A', '89': 'BTN_LONG_A', '8A': 'BTN_SHORT_B', '8B': 'BTN_LONG_B',
  '91': 'BEACON', '92': 'BEACON', '93': 'BEACON',
  // SET_LEVEL: Bridge commanding a dimmer to a level (format byte 0x0E)
  'A2': 'SET_LEVEL',
  'B0': 'PAIR_B0', 'B8': 'PAIR_B8', 'B9': 'PAIR_B9', 'BA': 'PAIR_BA', 'BB': 'PAIR_BB',
  // Pairing response packets
  'C0': 'PAIR_RESP', 'C1': 'PAIR_RESP', 'C2': 'PAIR_RESP', 'C8': 'PAIR_RESP',
}

/**
 * Get the appropriate field definitions for a packet type.
 */
export function getFieldsForPacket(packetType: string, bytes: string[]): ByteField[] {
  // Pairing packets (53 bytes)
  if (packetType.startsWith('PAIR_')) {
    return PAIRING_FIELDS
  }
  // Beacon packets
  if (packetType.startsWith('BEACON')) {
    return BEACON_FIELDS
  }
  // Button packets
  if (packetType.startsWith('BTN_')) {
    return BUTTON_FIELDS
  }
  // UNPAIR packets
  if (packetType === 'UNPAIR' || packetType === 'UNPAIR_PREP') {
    return UNPAIR_CMD_FIELDS
  }
  // SET_LEVEL: Bridge commanding a level
  if (packetType === 'SET_LEVEL' || packetType === 'LEVEL') {
    return LEVEL_CMD_FIELDS
  }
  // STATE_RPT: Dimmer reporting its level
  if (packetType === 'STATE_RPT') {
    return STATE_RPT_FIELDS
  }
  // Fallback: try to determine from raw bytes
  if (bytes.length >= 8) {
    const formatByte = bytes[7]?.toUpperCase()
    if (formatByte === '08') {
      return STATE_RPT_FIELDS  // STATE_RPT format
    }
    if (formatByte === '0E') {
      return LEVEL_CMD_FIELDS  // SET_LEVEL format
    }
    if (formatByte === '0C') {
      return UNPAIR_CMD_FIELDS  // UNPAIR format
    }
  }
  return BUTTON_FIELDS  // fallback
}

export interface FieldValue {
  raw: string
  decoded: string | null
}

/**
 * Format a field value from raw packet bytes.
 * Handles endianness conversion for device IDs and level calculations.
 */
export function formatFieldValue(bytes: string[], field: ByteField): FieldValue {
  const fieldBytes = bytes.slice(field.start, Math.min(field.end, bytes.length))
  const raw = fieldBytes.join(' ')

  if (fieldBytes.length === 0) {
    return { raw: '-', decoded: null }
  }

  switch (field.format) {
    // Little-endian device ID (STATE_RPT, LEVEL source)
    case 'device_id':
      if (fieldBytes.length >= 4) {
        const id = `${fieldBytes[3]}${fieldBytes[2]}${fieldBytes[1]}${fieldBytes[0]}`.toUpperCase()
        return { raw, decoded: id }
      }
      return { raw, decoded: null }

    // Big-endian device ID (button packets, pairing, targets)
    case 'device_id_be':
      if (fieldBytes.length >= 4) {
        const id = `${fieldBytes[0]}${fieldBytes[1]}${fieldBytes[2]}${fieldBytes[3]}`.toUpperCase()
        return { raw, decoded: id }
      }
      return { raw, decoded: null }

    // 16-bit level (LEVEL command: 0x0000-0xFEFF = 0-100%)
    case 'level_16bit':
      if (fieldBytes.length >= 2) {
        const levelRaw = parseInt(fieldBytes[0] + fieldBytes[1], 16)
        const level = levelRaw === 0 ? 0 : Math.round((levelRaw * 100) / 65279)
        return { raw, decoded: `${level}%` }
      }
      return { raw, decoded: null }

    // Single byte level (STATE_RPT: 0x00-0xFE = 0-100%)
    case 'level_byte':
      const levelByte = parseInt(fieldBytes[0], 16)
      const levelPct = levelByte === 0 ? 0 : Math.round((levelByte * 100) / 254)
      return { raw, decoded: `${levelPct}%` }

    case 'button':
      const btnName = BUTTON_NAMES[fieldBytes[0]?.toUpperCase()]
      return { raw, decoded: btnName || `0x${fieldBytes[0]}` }

    case 'action':
      const action = ACTION_NAMES[fieldBytes[0]?.toLowerCase()] || `0x${fieldBytes[0]}`
      return { raw, decoded: action }

    case 'decimal':
      return { raw, decoded: String(parseInt(fieldBytes[0], 16)) }

    case 'hex':
    default:
      // For hex, don't duplicate - just show raw
      return { raw, decoded: null }
  }
}

/**
 * Parse raw hex bytes string into array of hex byte strings.
 */
export function parseRawBytes(rawBytes: string): string[] {
  return rawBytes.split(/\s+/).filter(b => b.length > 0)
}
