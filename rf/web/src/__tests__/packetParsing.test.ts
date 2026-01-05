/**
 * Tests for Lutron CCA packet parsing utilities.
 * Uses test fixtures from rf/test_fixtures/packets.json
 */

import { describe, it, expect } from 'vitest'
import {
  formatFieldValue,
  getFieldsForPacket,
  parseRawBytes,
  ByteField,
  BUTTON_FIELDS,
  STATE_RPT_FIELDS,
  LEVEL_CMD_FIELDS,
  UNPAIR_CMD_FIELDS,
  BUTTON_NAMES,
} from '../utils/packetParsing'

// Import test fixtures
import fixtures from '../../../test_fixtures/packets.json'

const packetFixtures = fixtures.packets

// Helper to get fixture by ID
function getFixture(id: string) {
  const fixture = packetFixtures.find(f => f.id === id)
  if (!fixture) throw new Error(`Fixture not found: ${id}`)
  return fixture
}

describe('parseRawBytes', () => {
  it('parses space-separated hex bytes', () => {
    const result = parseRawBytes('88 00 8D E6 95 05')
    expect(result).toEqual(['88', '00', '8D', 'E6', '95', '05'])
  })

  it('handles multiple spaces', () => {
    const result = parseRawBytes('88  00   8D')
    expect(result).toEqual(['88', '00', '8D'])
  })
})

describe('formatFieldValue - device_id (little-endian)', () => {
  it('converts little-endian bytes to device ID string', () => {
    // Bytes AD 90 2C 00 -> 002C90AD
    const bytes = ['AD', '90', '2C', '00']
    const field: ByteField = { name: 'Device ID', start: 0, end: 4, format: 'device_id' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('002C90AD')
  })

  it('handles STATE_RPT device ID correctly', () => {
    const fixture = getFixture('state_rpt_44pct')
    const bytes = parseRawBytes(fixture.raw_bytes)
    const field: ByteField = { name: 'Device ID', start: 2, end: 6, format: 'device_id' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe(fixture.expected.device_id)
  })
})

describe('formatFieldValue - device_id_be (big-endian)', () => {
  it('converts big-endian bytes to device ID string', () => {
    // Bytes 07 01 6F CE -> 07016FCE
    const bytes = ['07', '01', '6F', 'CE']
    const field: ByteField = { name: 'Target ID', start: 0, end: 4, format: 'device_id_be' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('07016FCE')
  })

  it('handles UNPAIR target ID correctly', () => {
    const fixture = getFixture('unpair_phase2_flood')
    const bytes = parseRawBytes(fixture.raw_bytes)
    const field: ByteField = { name: 'Target ID', start: 16, end: 20, format: 'device_id_be' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe(fixture.expected.target_id)
  })
})

describe('formatFieldValue - level_byte', () => {
  it('converts 0x00 to 0%', () => {
    const bytes = ['00']
    const field: ByteField = { name: 'Level', start: 0, end: 1, format: 'level_byte' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('0%')
  })

  it('converts 0xFE to 100%', () => {
    const bytes = ['FE']
    const field: ByteField = { name: 'Level', start: 0, end: 1, format: 'level_byte' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('100%')
  })

  it('converts 0x7F to ~50%', () => {
    const bytes = ['7F']
    const field: ByteField = { name: 'Level', start: 0, end: 1, format: 'level_byte' }
    const result = formatFieldValue(bytes, field)
    const level = parseInt(result.decoded!.replace('%', ''))
    expect(level).toBeGreaterThanOrEqual(49)
    expect(level).toBeLessThanOrEqual(51)
  })
})

describe('formatFieldValue - level_16bit', () => {
  it('converts 0x0000 to 0%', () => {
    const bytes = ['00', '00']
    const field: ByteField = { name: 'Level', start: 0, end: 2, format: 'level_16bit' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('0%')
  })

  it('converts 0xFEFF to 100%', () => {
    const bytes = ['FE', 'FF']
    const field: ByteField = { name: 'Level', start: 0, end: 2, format: 'level_16bit' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('100%')
  })

  it('converts 0xBEDF to ~75%', () => {
    const bytes = ['BE', 'DF']
    const field: ByteField = { name: 'Level', start: 0, end: 2, format: 'level_16bit' }
    const result = formatFieldValue(bytes, field)
    const level = parseInt(result.decoded!.replace('%', ''))
    expect(level).toBeGreaterThanOrEqual(74)
    expect(level).toBeLessThanOrEqual(76)
  })
})

describe('formatFieldValue - button', () => {
  it('decodes ON button (0x02)', () => {
    const bytes = ['02']
    const field: ByteField = { name: 'Button', start: 0, end: 1, format: 'button' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('ON')
  })

  it('decodes all known button codes', () => {
    for (const [code, name] of Object.entries(BUTTON_NAMES)) {
      const bytes = [code]
      const field: ByteField = { name: 'Button', start: 0, end: 1, format: 'button' }
      const result = formatFieldValue(bytes, field)
      expect(result.decoded).toBe(name)
    }
  })

  it('handles unknown button code', () => {
    const bytes = ['FF']
    const field: ByteField = { name: 'Button', start: 0, end: 1, format: 'button' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('0xFF')
  })
})

describe('formatFieldValue - action', () => {
  it('decodes PRESS action (0x00)', () => {
    const bytes = ['00']
    const field: ByteField = { name: 'Action', start: 0, end: 1, format: 'action' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('PRESS')
  })

  it('decodes RELEASE action (0x01)', () => {
    const bytes = ['01']
    const field: ByteField = { name: 'Action', start: 0, end: 1, format: 'action' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('RELEASE')
  })
})

describe('getFieldsForPacket', () => {
  it('returns BUTTON_FIELDS for BTN_SHORT_A', () => {
    const fields = getFieldsForPacket('BTN_SHORT_A', [])
    expect(fields).toBe(BUTTON_FIELDS)
  })

  it('returns BUTTON_FIELDS for BTN_LONG_B', () => {
    const fields = getFieldsForPacket('BTN_LONG_B', [])
    expect(fields).toBe(BUTTON_FIELDS)
  })

  it('returns UNPAIR_CMD_FIELDS for UNPAIR', () => {
    const fields = getFieldsForPacket('UNPAIR', [])
    expect(fields).toBe(UNPAIR_CMD_FIELDS)
  })

  it('returns STATE_RPT_FIELDS when format is 00 08', () => {
    const bytes = ['81', '00', 'AD', '90', '2C', '00', '00', '08']
    const fields = getFieldsForPacket('LEVEL', bytes)
    expect(fields).toBe(STATE_RPT_FIELDS)
  })

  it('returns LEVEL_CMD_FIELDS when format is 21 0E', () => {
    const bytes = ['82', '05', 'AD', '90', '2C', '00', '21', '0E']
    const fields = getFieldsForPacket('LEVEL', bytes)
    expect(fields).toBe(LEVEL_CMD_FIELDS)
  })

  it('returns UNPAIR_CMD_FIELDS when format byte is 0C', () => {
    const bytes = ['82', '07', 'AF', '90', '2C', '00', '21', '0C']
    const fields = getFieldsForPacket('LEVEL', bytes)
    expect(fields).toBe(UNPAIR_CMD_FIELDS)
  })
})

describe('Fixture-driven parsing tests', () => {
  it('parses button press device ID correctly', () => {
    const fixture = getFixture('btn_on_press_short_a')
    const bytes = parseRawBytes(fixture.raw_bytes)

    // Button packets store device ID in little-endian (reversed from printed label)
    const field: ByteField = { name: 'Device ID', start: 2, end: 6, format: 'device_id' }
    const result = formatFieldValue(bytes, field)

    expect(result.decoded).toBe(fixture.expected.device_id)
  })

  it('parses UNPAIR source and target IDs correctly', () => {
    const fixture = getFixture('unpair_phase2_flood')
    const bytes = parseRawBytes(fixture.raw_bytes)

    // Source is little-endian
    const sourceField: ByteField = { name: 'Source ID', start: 2, end: 6, format: 'device_id' }
    const sourceResult = formatFieldValue(bytes, sourceField)
    expect(sourceResult.decoded).toBe(fixture.expected.source_id)

    // Target is big-endian
    const targetField: ByteField = { name: 'Target ID', start: 16, end: 20, format: 'device_id_be' }
    const targetResult = formatFieldValue(bytes, targetField)
    expect(targetResult.decoded).toBe(fixture.expected.target_id)
  })

  it('parses scene pico button correctly', () => {
    const fixture = getFixture('btn_scene_bright')
    const bytes = parseRawBytes(fixture.raw_bytes)

    const buttonField: ByteField = { name: 'Button', start: 10, end: 11, format: 'button' }
    const buttonResult = formatFieldValue(bytes, buttonField)
    expect(buttonResult.decoded).toBe(fixture.expected.button)
  })
})

describe('Endianness verification', () => {
  it('device_id reverses bytes (little-endian)', () => {
    // Input: AF 90 2C 00
    // Output: 002C90AF (reversed)
    const bytes = ['AF', '90', '2C', '00']
    const field: ByteField = { name: 'Test', start: 0, end: 4, format: 'device_id' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('002C90AF')
  })

  it('device_id_be keeps byte order (big-endian)', () => {
    // Input: 07 01 6F CE
    // Output: 07016FCE (same order)
    const bytes = ['07', '01', '6F', 'CE']
    const field: ByteField = { name: 'Test', start: 0, end: 4, format: 'device_id_be' }
    const result = formatFieldValue(bytes, field)
    expect(result.decoded).toBe('07016FCE')
  })
})
