/**
 * Tests for Lutron CCA packet parsing utilities.
 * Uses test fixtures from rf/test_fixtures/packets.json
 */

import { describe, it, expect } from 'vitest'
import {
  parseFieldValue,
  parseDeviceId,
  parseLevelByte,
  parseLevel16bit,
  getButtonName,
  getActionName,
  identifyPacket,
} from '../../../protocol/protocol-ui'

// Import test fixtures
import fixtures from '../../../test_fixtures/packets.json'

const packetFixtures = fixtures.packets

// Helper to get fixture by ID
function getFixture(id: string) {
  const fixture = packetFixtures.find(f => f.id === id)
  if (!fixture) throw new Error(`Fixture not found: ${id}`)
  return fixture
}

// Helper to parse raw bytes string
function parseRawBytes(rawBytes: string): string[] {
  return rawBytes.split(/\s+/).filter(b => b.length > 0)
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

describe('parseFieldValue - device_id (little-endian)', () => {
  it('converts little-endian bytes to device ID string', () => {
    const bytes = ['AD', '90', '2C', '00']
    const result = parseFieldValue(bytes, 0, 4, 'device_id')
    expect(result.decoded).toBe('002C90AD')
  })

  it('handles STATE_RPT device ID correctly', () => {
    const fixture = getFixture('state_rpt_44pct')
    const bytes = parseRawBytes(fixture.raw_bytes)
    const result = parseFieldValue(bytes, 2, 4, 'device_id')
    expect(result.decoded).toBe(fixture.expected.device_id)
  })
})

describe('parseFieldValue - device_id_be (big-endian)', () => {
  it('converts big-endian bytes to device ID string', () => {
    const bytes = ['07', '01', '6F', 'CE']
    const result = parseFieldValue(bytes, 0, 4, 'device_id_be')
    expect(result.decoded).toBe('07016FCE')
  })

  it('handles UNPAIR target ID correctly', () => {
    const fixture = getFixture('unpair_phase2_flood')
    const bytes = parseRawBytes(fixture.raw_bytes)
    const result = parseFieldValue(bytes, 16, 4, 'device_id_be')
    expect(result.decoded).toBe(fixture.expected.target_id)
  })
})

describe('parseFieldValue - level_byte', () => {
  it('converts 0x00 to 0%', () => {
    const result = parseLevelByte('00')
    expect(result).toBe('0%')
  })

  it('converts 0xFE to 100%', () => {
    const result = parseLevelByte('FE')
    expect(result).toBe('100%')
  })

  it('converts 0x7F to ~50%', () => {
    const result = parseLevelByte('7F')
    const level = parseInt(result.replace('%', ''))
    expect(level).toBeGreaterThanOrEqual(49)
    expect(level).toBeLessThanOrEqual(51)
  })
})

describe('parseFieldValue - level_16bit', () => {
  it('converts 0x0000 to 0%', () => {
    const result = parseLevel16bit(['00', '00'])
    expect(result).toBe('0%')
  })

  it('converts 0xFEFF to 100%', () => {
    const result = parseLevel16bit(['FE', 'FF'])
    expect(result).toBe('100%')
  })

  it('converts 0xBEDF to ~75%', () => {
    const result = parseLevel16bit(['BE', 'DF'])
    const level = parseInt(result.replace('%', ''))
    expect(level).toBeGreaterThanOrEqual(74)
    expect(level).toBeLessThanOrEqual(76)
  })
})

describe('parseFieldValue - button', () => {
  it('decodes ON button (0x02)', () => {
    expect(getButtonName(0x02)).toBe('ON')
  })

  it('decodes all known button codes', () => {
    const expected: Record<number, string> = {
      0x02: 'ON', 0x03: 'FAVORITE', 0x04: 'OFF', 0x05: 'RAISE', 0x06: 'LOWER',
      0x08: 'SCENE4', 0x09: 'SCENE3', 0x0A: 'SCENE2', 0x0B: 'SCENE1',
    }
    for (const [code, name] of Object.entries(expected)) {
      expect(getButtonName(Number(code))).toBe(name)
    }
  })

  it('handles unknown button code', () => {
    expect(getButtonName(0x77)).toBe('0x77')
  })
})

describe('parseFieldValue - action', () => {
  it('decodes PRESS action (0x00)', () => {
    expect(getActionName(0x00)).toBe('PRESS')
  })

  it('decodes RELEASE action (0x01)', () => {
    expect(getActionName(0x01)).toBe('RELEASE')
  })
})

describe('identifyPacket', () => {
  it('identifies BTN_PRESS_A from type byte 0x88', () => {
    const data = [0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04]
    const result = identifyPacket(data)
    expect(result.typeName).toBe('BTN_PRESS_A')
    expect(result.category).toBe('BUTTON')
    expect(result.usesBigEndianDeviceId).toBe(true)
  })

  it('identifies UNPAIR from STATE_RPT type + format byte 0x0C', () => {
    const data = [0x81, 0x00, 0xAD, 0x90, 0x2C, 0x00, 0x21, 0x0C]
    const result = identifyPacket(data)
    expect(result.typeName).toBe('UNPAIR')
    expect(result.category).toBe('CONFIG')
    expect(result.isVirtual).toBe(true)
  })

  it('identifies UNPAIR_PREP from format byte 0x09', () => {
    const data = [0x82, 0x00, 0xAD, 0x90, 0x2C, 0x00, 0x21, 0x09]
    const result = identifyPacket(data)
    expect(result.typeName).toBe('UNPAIR_PREP')
    expect(result.isVirtual).toBe(true)
  })

  it('identifies LED_CONFIG from format byte 0x0A', () => {
    const data = [0x81, 0x00, 0xAD, 0x90, 0x2C, 0x00, 0x21, 0x0A]
    const result = identifyPacket(data)
    expect(result.typeName).toBe('LED_CONFIG')
    expect(result.isVirtual).toBe(true)
  })

  it('identifies STATE_RPT_81 when format is 0x08 (normal state report)', () => {
    const data = [0x81, 0x00, 0xAD, 0x90, 0x2C, 0x00, 0x21, 0x08]
    const result = identifyPacket(data)
    expect(result.typeName).toBe('STATE_RPT_81')
    expect(result.category).toBe('STATE')
    expect(result.isVirtual).toBe(false)
  })

  it('identifies handshake packets', () => {
    const data = [0xC1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
    const result = identifyPacket(data)
    expect(result.typeName).toBe('HS_C1')
    expect(result.category).toBe('HANDSHAKE')
  })

  it('returns UNKNOWN for unrecognized type byte', () => {
    const data = [0xFF, 0x00]
    const result = identifyPacket(data)
    expect(result.typeName).toBe('0xFF')
    expect(result.category).toBe('unknown')
  })

  it('handles empty packet', () => {
    const result = identifyPacket([])
    expect(result.typeName).toBe('UNKNOWN')
  })
})

describe('Fixture-driven parsing tests', () => {
  it('parses button press device ID correctly', () => {
    const fixture = getFixture('btn_on_press_short_a')
    const bytes = parseRawBytes(fixture.raw_bytes)
    // Fixture specifies endianness - use it to parse correctly
    const endian = fixture.expected.device_id_endian as 'little' | 'big'
    const result = parseDeviceId(bytes, 2, endian)
    expect(result).toBe(fixture.expected.device_id)
  })

  it('parses UNPAIR source and target IDs correctly', () => {
    const fixture = getFixture('unpair_phase2_flood')
    const bytes = parseRawBytes(fixture.raw_bytes)

    // Source is little-endian
    const sourceResult = parseDeviceId(bytes, 2, 'little')
    expect(sourceResult).toBe(fixture.expected.source_id)

    // Target is big-endian
    const targetResult = parseDeviceId(bytes, 16, 'big')
    expect(targetResult).toBe(fixture.expected.target_id)
  })
})

describe('Endianness verification', () => {
  it('device_id reverses bytes (little-endian)', () => {
    const bytes = ['AF', '90', '2C', '00']
    const result = parseDeviceId(bytes, 0, 'little')
    expect(result).toBe('002C90AF')
  })

  it('device_id_be keeps byte order (big-endian)', () => {
    const bytes = ['07', '01', '6F', 'CE']
    const result = parseDeviceId(bytes, 0, 'big')
    expect(result).toBe('07016FCE')
  })
})
