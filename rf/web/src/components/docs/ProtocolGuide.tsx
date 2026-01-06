import { useState } from 'react'
import './ProtocolGuide.css'

// Comprehensive Lutron Clear Connect Type A (CCA) Protocol Reference
// Based on RF analysis of RadioRA3/Homeworks QSX bridge and device communications

export interface PacketTypeInfo {
  type: number
  name: string
  shortName: string
  category: 'button' | 'state' | 'beacon' | 'pairing' | 'config' | 'handshake' | 'unknown'
  direction: 'device_to_bridge' | 'bridge_to_device' | 'bidirectional' | 'broadcast'
  typicalLength: number
  description: string
  fields: PacketField[]
  notes?: string[]
  examples?: string[]
}

export interface PacketField {
  offset: number
  length: number
  name: string
  description: string
  format?: 'hex' | 'decimal' | 'big_endian' | 'little_endian' | 'bitfield'
}

// Master packet type registry
export const PACKET_TYPES: Record<number, PacketTypeInfo> = {
  // ========== 0x8x: Button & State Packets ==========
  0x80: {
    type: 0x80,
    name: 'State Report (Short)',
    shortName: 'STATE_80',
    category: 'state',
    direction: 'device_to_bridge',
    typicalLength: 24,
    description: 'Dimmer/switch state report (short format). Sent by devices to report their current level.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x80)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 1, name: 'prefix', description: 'Zone prefix (AF/AD/A2/A0)' },
      { offset: 3, length: 2, name: 'subnet', description: 'Subnet address (little-endian)', format: 'little_endian' },
      { offset: 5, length: 1, name: 'zone_suffix', description: 'Zone suffix' },
      { offset: 6, length: 2, name: 'format', description: 'Format bytes (21 08/09)' },
      { offset: 16, length: 2, name: 'level', description: 'Level value (0x0000-0xFEFF)', format: 'big_endian' },
    ],
    notes: [
      'Device ID is little-endian at bytes 2-5',
      'Level 0xFEFF = 100%, 0x0000 = 0%',
    ]
  },
  0x81: {
    type: 0x81,
    name: 'State Report (Standard)',
    shortName: 'STATE_RPT',
    category: 'state',
    direction: 'device_to_bridge',
    typicalLength: 24,
    description: 'Standard dimmer/switch state report. Most common state packet from devices.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x81)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 1, name: 'prefix', description: 'Zone prefix' },
      { offset: 3, length: 2, name: 'subnet', description: 'Subnet address', format: 'little_endian' },
      { offset: 5, length: 1, name: 'zone_suffix', description: 'Zone suffix' },
      { offset: 6, length: 2, name: 'format', description: 'Format bytes (21 09)' },
      { offset: 9, length: 4, name: 'factory_id', description: 'Device factory ID', format: 'big_endian' },
      { offset: 13, length: 1, name: 'unknown', description: 'Unknown (0xFE)' },
      { offset: 14, length: 2, name: 'level_info', description: 'Level/status info' },
    ],
    notes: [
      'Contains factory ID for device identification',
      'Used for tracking device state changes',
    ]
  },
  0x82: {
    type: 0x82,
    name: 'State Report (Extended)',
    shortName: 'STATE_82',
    category: 'state',
    direction: 'device_to_bridge',
    typicalLength: 21,
    description: 'Extended state report format.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x82)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 4, name: 'device_id', description: 'Device identifier' },
    ],
  },
  0x83: {
    type: 0x83,
    name: 'State Report (Alt)',
    shortName: 'STATE_83',
    category: 'state',
    direction: 'device_to_bridge',
    typicalLength: 24,
    description: 'Alternative state report format.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x83)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
    ],
  },
  0x88: {
    type: 0x88,
    name: 'Button Press (Short A)',
    shortName: 'BTN_SHORT_A',
    category: 'button',
    direction: 'device_to_bridge',
    typicalLength: 24,
    description: 'Short button press from Pico remote (variant A). First packet of button press sequence.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x88)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 4, name: 'device_id', description: 'Pico device ID (big-endian)', format: 'big_endian' },
      { offset: 6, length: 2, name: 'format', description: 'Format bytes (21 04)' },
      { offset: 8, length: 2, name: 'button_info', description: 'Button number and state' },
      { offset: 10, length: 1, name: 'button', description: 'Button code (02=ON, 03=FAV, 04=OFF, 05=UP, 06=DN)' },
    ],
    notes: [
      'Button codes: 0x02=ON, 0x03=FAV, 0x04=OFF, 0x05=RAISE, 0x06=LOWER',
      'Scene Pico: 0x08=Scene1, 0x09=Scene2, 0x0A=Scene3, 0x0B=Scene4',
      'Device ID is big-endian (matches label)',
    ]
  },
  0x89: {
    type: 0x89,
    name: 'Button Press (Long A)',
    shortName: 'BTN_LONG_A',
    category: 'button',
    direction: 'device_to_bridge',
    typicalLength: 24,
    description: 'Long/extended button press packet (variant A). Contains additional device info.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x89)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 4, name: 'device_id', description: 'Pico device ID (big-endian)', format: 'big_endian' },
      { offset: 6, length: 2, name: 'format', description: 'Format bytes (21 0E)' },
      { offset: 10, length: 1, name: 'button', description: 'Button code' },
      { offset: 12, length: 4, name: 'device_id_repeat', description: 'Device ID repeated' },
    ],
  },
  0x8A: {
    type: 0x8A,
    name: 'Button Press (Short B)',
    shortName: 'BTN_SHORT_B',
    category: 'button',
    direction: 'device_to_bridge',
    typicalLength: 24,
    description: 'Short button press (variant B). Alternative format.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x8A)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 4, name: 'device_id', description: 'Device ID', format: 'big_endian' },
      { offset: 10, length: 1, name: 'button', description: 'Button code' },
    ],
  },
  0x8B: {
    type: 0x8B,
    name: 'Button Press (Long B)',
    shortName: 'BTN_LONG_B',
    category: 'button',
    direction: 'device_to_bridge',
    typicalLength: 24,
    description: 'Long button press (variant B).',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x8B)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
    ],
  },

  // ========== 0x9x: Beacon Packets ==========
  0x91: {
    type: 0x91,
    name: 'Pairing Beacon',
    shortName: 'BEACON_PAIR',
    category: 'beacon',
    direction: 'broadcast',
    typicalLength: 24,
    description: 'Active pairing beacon. Broadcast by bridge when in pairing mode to alert devices.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x91)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 1, name: 'prefix', description: 'Zone prefix (AF/AD)' },
      { offset: 3, length: 2, name: 'subnet', description: 'Subnet address', format: 'little_endian' },
      { offset: 5, length: 1, name: 'zone_suffix', description: 'Zone suffix (00)' },
      { offset: 6, length: 2, name: 'format', description: 'Format bytes (21 0C)' },
      { offset: 14, length: 2, name: 'beacon_info', description: 'Beacon type info (08 02)' },
      { offset: 16, length: 2, name: 'subnet_repeat', description: 'Subnet repeated' },
    ],
    notes: [
      'Devices flash when receiving pairing beacons',
      'Sent continuously during pairing mode',
    ]
  },
  0x92: {
    type: 0x92,
    name: 'Active Beacon',
    shortName: 'BEACON',
    category: 'beacon',
    direction: 'broadcast',
    typicalLength: 24,
    description: 'Standard bridge beacon. Broadcast regularly to maintain network presence.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x92)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number (increments)' },
      { offset: 2, length: 1, name: 'prefix', description: 'Zone prefix (AF/AD alternating)' },
      { offset: 3, length: 2, name: 'subnet', description: 'Subnet address', format: 'little_endian' },
      { offset: 5, length: 1, name: 'zone_suffix', description: 'Zone suffix (00)' },
      { offset: 6, length: 2, name: 'format', description: 'Format bytes (21 0C)' },
    ],
    notes: [
      'Most common packet type during normal operation',
      'Sent every ~65ms by bridge',
      'Prefix alternates between AF and AD',
    ]
  },
  0x93: {
    type: 0x93,
    name: 'Device Pairing Beacon',
    shortName: 'BEACON_DEV',
    category: 'beacon',
    direction: 'device_to_bridge',
    typicalLength: 24,
    description: 'Beacon from device in pairing mode. Sent when device is held in pairing state.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0x93)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 1, name: 'prefix', description: 'Zone prefix' },
      { offset: 3, length: 2, name: 'subnet', description: 'Subnet address', format: 'little_endian' },
    ],
    notes: [
      'Indicates device is ready to accept pairing',
      'Device flashes while sending these',
    ]
  },

  // ========== 0xAx: Device Config/Info Packets ==========
  0xA1: {
    type: 0xA1,
    name: 'Device Info (Type 1)',
    shortName: 'DEV_INFO_1',
    category: 'config',
    direction: 'device_to_bridge',
    typicalLength: 53,
    description: 'Device information packet type 1. Sent during pairing/configuration.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xA1)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 1, name: 'prefix', description: 'Zone prefix' },
      { offset: 3, length: 2, name: 'subnet', description: 'Subnet', format: 'little_endian' },
      { offset: 9, length: 4, name: 'factory_id', description: 'Factory ID', format: 'big_endian' },
    ],
  },
  0xA2: {
    type: 0xA2,
    name: 'Device Info (Type 2)',
    shortName: 'DEV_INFO_2',
    category: 'config',
    direction: 'device_to_bridge',
    typicalLength: 53,
    description: 'Device information packet type 2. Contains device capabilities.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xA2)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 9, length: 4, name: 'factory_id', description: 'Factory ID', format: 'big_endian' },
    ],
  },
  0xA3: {
    type: 0xA3,
    name: 'Device Info (Type 3)',
    shortName: 'DEV_INFO_3',
    category: 'config',
    direction: 'device_to_bridge',
    typicalLength: 53,
    description: 'Device information packet type 3.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xA3)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
    ],
  },

  // ========== 0xBx: Pairing Assignment Packets ==========
  0xB0: {
    type: 0xB0,
    name: 'Pairing Assignment (Alt)',
    shortName: 'PAIR_B0',
    category: 'pairing',
    direction: 'bridge_to_device',
    typicalLength: 33,
    description: 'Pairing assignment packet (alternate format). Assigns device to subnet/zone.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xB0)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 1, name: 'prefix', description: 'Zone prefix (A0/A2/AF)' },
      { offset: 3, length: 2, name: 'subnet', description: 'Subnet address', format: 'little_endian' },
      { offset: 5, length: 1, name: 'pairing_suffix', description: 'Pairing suffix (0x7F)' },
      { offset: 6, length: 2, name: 'format', description: 'Format (21 17)' },
      { offset: 9, length: 5, name: 'broadcast', description: 'Broadcast address (FF FF FF FF FF)' },
      { offset: 14, length: 2, name: 'device_type_hdr', description: 'Device type header (08 05)' },
      { offset: 16, length: 4, name: 'factory_id', description: 'Target factory ID', format: 'big_endian' },
      { offset: 20, length: 1, name: 'config_byte', description: 'Config byte (04)' },
      { offset: 21, length: 2, name: 'device_type', description: 'Device type (63 02 = dimmer)' },
    ],
    notes: [
      'We initially used B0, but real bridge uses B1',
      'Same structure as B1',
    ]
  },
  0xB1: {
    type: 0xB1,
    name: 'Pairing Assignment',
    shortName: 'PAIR_ASSIGN',
    category: 'pairing',
    direction: 'bridge_to_device',
    typicalLength: 33,
    description: 'Primary pairing assignment packet. Used by real bridge to assign device to network.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xB1)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number (starts at 0x00)' },
      { offset: 2, length: 1, name: 'prefix', description: 'Zone prefix (A0 for seq=0, A2 for seq=2/6, AF for rest)' },
      { offset: 3, length: 2, name: 'subnet', description: 'Subnet address (e.g., 90 2C = 0x2C90)', format: 'little_endian' },
      { offset: 5, length: 1, name: 'pairing_suffix', description: 'Pairing suffix (always 0x7F)' },
      { offset: 6, length: 2, name: 'format', description: 'Format bytes (21 17)' },
      { offset: 8, length: 1, name: 'zero', description: 'Zero byte' },
      { offset: 9, length: 5, name: 'broadcast', description: 'Broadcast address (FF FF FF FF FF)' },
      { offset: 14, length: 2, name: 'device_type_hdr', description: 'Device type header (08 05)' },
      { offset: 16, length: 4, name: 'factory_id', description: 'Target device factory ID', format: 'big_endian' },
      { offset: 20, length: 1, name: 'config_byte', description: 'Config byte (04)' },
      { offset: 21, length: 2, name: 'device_type', description: 'Device type (63 02 = dimmer, 64 01 = switch)' },
      { offset: 23, length: 1, name: 'unknown1', description: 'Unknown (01)' },
      { offset: 24, length: 1, name: 'unknown2', description: 'Unknown (FF)' },
      { offset: 25, length: 4, name: 'config', description: 'Config bytes (00 00 01 03)' },
      { offset: 29, length: 2, name: 'trailer', description: 'Trailer (15 00)' },
      { offset: 31, length: 2, name: 'crc', description: 'CRC-16', format: 'big_endian' },
    ],
    notes: [
      'THIS IS THE CORRECT PACKET TYPE for pairing (not B0)',
      'Real bridge sends ~30 B1 packets over ~1 second',
      'Prefix pattern: A0 (seq=0), A2 (seq=2,6), AF (rest)',
      'Device responds with B3 ~10 seconds after receiving',
    ],
    examples: [
      'B1 00 A0 90 2C 7F 21 17 00 FF FF FF FF FF 08 05 06 FE 43 B1 04 63 02 01 FF 00 00 01 03 15 00 [CRC]',
    ]
  },
  0xB3: {
    type: 0xB3,
    name: 'Pairing Acknowledgment',
    shortName: 'PAIR_ACK',
    category: 'pairing',
    direction: 'device_to_bridge',
    typicalLength: 33,
    description: 'Device acknowledgment of pairing assignment. Sent by device after receiving B1 packets.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xB3)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 1, name: 'prefix', description: 'Zone prefix' },
      { offset: 3, length: 2, name: 'subnet', description: 'Subnet', format: 'little_endian' },
      { offset: 16, length: 4, name: 'factory_id', description: 'Device factory ID', format: 'big_endian' },
    ],
    notes: [
      'Device echoes back the assignment data',
      'Comes ~1.5-10 seconds after B1 packets',
      'Confirms device received pairing assignment',
    ]
  },
  0xB8: {
    type: 0xB8,
    name: 'Pico Pairing (Short)',
    shortName: 'PICO_PAIR_S',
    category: 'pairing',
    direction: 'device_to_bridge',
    typicalLength: 53,
    description: 'Pico remote pairing packet (short variant).',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xB8)' },
    ],
  },
  0xB9: {
    type: 0xB9,
    name: 'Pico Pairing (Standard)',
    shortName: 'PICO_PAIR',
    category: 'pairing',
    direction: 'device_to_bridge',
    typicalLength: 53,
    description: 'Standard Pico pairing packet. Used for direct Pico-to-device pairing.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xB9)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
      { offset: 2, length: 4, name: 'device_id', description: 'Pico device ID', format: 'big_endian' },
      { offset: 30, length: 1, name: 'button_scheme', description: 'Button capability scheme' },
    ],
    notes: [
      'Used for direct Pico pairing (not through bridge)',
      '53 bytes total',
    ]
  },
  0xBA: {
    type: 0xBA,
    name: 'Pico Pairing (Bridge)',
    shortName: 'PICO_PAIR_B',
    category: 'pairing',
    direction: 'bridge_to_device',
    typicalLength: 53,
    description: 'Pico pairing through bridge. For scene Picos that require bridge.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xBA)' },
    ],
  },
  0xBB: {
    type: 0xBB,
    name: 'Pico Pairing (Extended)',
    shortName: 'PICO_PAIR_X',
    category: 'pairing',
    direction: 'device_to_bridge',
    typicalLength: 53,
    description: 'Extended Pico pairing packet.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xBB)' },
    ],
  },

  // ========== 0xCx: Handshake/Confirmation Packets ==========
  0xC1: {
    type: 0xC1,
    name: 'Handshake C1',
    shortName: 'HS_C1',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Pairing handshake packet C1. Part of the multi-packet confirmation sequence.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xC1)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number (increments by 0x20)' },
      { offset: 2, length: 2, name: 'subnet', description: 'Subnet (big-endian here!)' },
      { offset: 4, length: 2, name: 'zone_info', description: 'Zone information' },
    ],
    notes: [
      'Sequence increments by 0x20 (32)',
      'Part of C1/C2/C7/C8/CD/CE handshake sequence',
    ]
  },
  0xC2: {
    type: 0xC2,
    name: 'Handshake C2',
    shortName: 'HS_C2',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Pairing handshake packet C2.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xC2)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
    ],
  },
  0xC7: {
    type: 0xC7,
    name: 'Handshake C7',
    shortName: 'HS_C7',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Pairing handshake packet C7.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xC7)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
    ],
  },
  0xC8: {
    type: 0xC8,
    name: 'Handshake C8',
    shortName: 'HS_C8',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Pairing handshake packet C8.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xC8)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
    ],
  },
  0xCD: {
    type: 0xCD,
    name: 'Handshake CD',
    shortName: 'HS_CD',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Pairing handshake packet CD.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xCD)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
    ],
  },
  0xCE: {
    type: 0xCE,
    name: 'Handshake CE',
    shortName: 'HS_CE',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Pairing handshake packet CE.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xCE)' },
      { offset: 1, length: 1, name: 'seq', description: 'Sequence number' },
    ],
  },

  // ========== 0xDx: Extended Handshake ==========
  0xD3: {
    type: 0xD3,
    name: 'Extended Handshake D3',
    shortName: 'HS_D3',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Extended handshake packet D3.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xD3)' },
    ],
  },
  0xD4: {
    type: 0xD4,
    name: 'Extended Handshake D4',
    shortName: 'HS_D4',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Extended handshake packet D4.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xD4)' },
    ],
  },
  0xD9: {
    type: 0xD9,
    name: 'Extended Handshake D9',
    shortName: 'HS_D9',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Extended handshake packet D9.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xD9)' },
    ],
  },
  0xDA: {
    type: 0xDA,
    name: 'Extended Handshake DA',
    shortName: 'HS_DA',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Extended handshake packet DA.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xDA)' },
    ],
  },
  0xDF: {
    type: 0xDF,
    name: 'Extended Handshake DF',
    shortName: 'HS_DF',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Extended handshake packet DF.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xDF)' },
    ],
  },
  0xE0: {
    type: 0xE0,
    name: 'Final Handshake E0',
    shortName: 'HS_E0',
    category: 'handshake',
    direction: 'bidirectional',
    typicalLength: 24,
    description: 'Final handshake packet E0.',
    fields: [
      { offset: 0, length: 1, name: 'type', description: 'Packet type (0xE0)' },
    ],
  },
}

// Helper to get packet info
export function getPacketTypeInfo(type: number): PacketTypeInfo | undefined {
  return PACKET_TYPES[type]
}

// Get category color
export function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    button: '#4CAF50',
    state: '#2196F3',
    beacon: '#FF9800',
    pairing: '#9C27B0',
    config: '#00BCD4',
    handshake: '#E91E63',
    unknown: '#9E9E9E',
  }
  return colors[category] || colors.unknown
}

// Component
export function ProtocolGuide() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [selectedPacket, setSelectedPacket] = useState<number | null>(null)
  const [searchTerm, setSearchTerm] = useState('')

  const categories = ['button', 'state', 'beacon', 'pairing', 'config', 'handshake']

  const filteredPackets = Object.values(PACKET_TYPES).filter(pkt => {
    if (selectedCategory && pkt.category !== selectedCategory) return false
    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      return (
        pkt.name.toLowerCase().includes(term) ||
        pkt.shortName.toLowerCase().includes(term) ||
        pkt.description.toLowerCase().includes(term) ||
        `0x${pkt.type.toString(16)}`.toLowerCase().includes(term)
      )
    }
    return true
  })

  const selectedPacketInfo = selectedPacket !== null ? PACKET_TYPES[selectedPacket] : null

  return (
    <div className="protocol-guide">
      <div className="protocol-header">
        <h2>Lutron CCA Protocol Reference</h2>
        <p>Clear Connect Type A (433.6 MHz, 2-FSK, 62.5 kbaud)</p>
      </div>

      <div className="protocol-search">
        <input
          type="text"
          placeholder="Search packets (e.g., B1, pairing, button)..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="category-filter">
        <button
          className={selectedCategory === null ? 'active' : ''}
          onClick={() => setSelectedCategory(null)}
        >
          All
        </button>
        {categories.map(cat => (
          <button
            key={cat}
            className={selectedCategory === cat ? 'active' : ''}
            style={{ borderColor: getCategoryColor(cat) }}
            onClick={() => setSelectedCategory(cat)}
          >
            {cat.charAt(0).toUpperCase() + cat.slice(1)}
          </button>
        ))}
      </div>

      <div className="protocol-content">
        <div className="packet-list">
          {filteredPackets.map(pkt => (
            <div
              key={pkt.type}
              className={`packet-item ${selectedPacket === pkt.type ? 'selected' : ''}`}
              onClick={() => setSelectedPacket(pkt.type)}
            >
              <span className="packet-type" style={{ backgroundColor: getCategoryColor(pkt.category) }}>
                0x{pkt.type.toString(16).toUpperCase().padStart(2, '0')}
              </span>
              <span className="packet-name">{pkt.shortName}</span>
              <span className="packet-direction">{pkt.direction.split('_').map(w => w[0]).join('')}</span>
            </div>
          ))}
        </div>

        <div className="packet-detail">
          {selectedPacketInfo ? (
            <>
              <div className="detail-header">
                <h3>
                  <span style={{ backgroundColor: getCategoryColor(selectedPacketInfo.category) }}>
                    0x{selectedPacketInfo.type.toString(16).toUpperCase().padStart(2, '0')}
                  </span>
                  {selectedPacketInfo.name}
                </h3>
                <span className="detail-category">{selectedPacketInfo.category}</span>
              </div>

              <p className="detail-description">{selectedPacketInfo.description}</p>

              <div className="detail-meta">
                <span>Direction: {selectedPacketInfo.direction.replace(/_/g, ' ')}</span>
                <span>Typical length: {selectedPacketInfo.typicalLength} bytes</span>
              </div>

              {selectedPacketInfo.fields.length > 0 && (
                <div className="detail-fields">
                  <h4>Packet Structure</h4>
                  <table>
                    <thead>
                      <tr>
                        <th>Offset</th>
                        <th>Len</th>
                        <th>Field</th>
                        <th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedPacketInfo.fields.map((field, i) => (
                        <tr key={i}>
                          <td>{field.offset}</td>
                          <td>{field.length}</td>
                          <td>{field.name}</td>
                          <td>
                            {field.description}
                            {field.format && <span className="field-format">{field.format}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {selectedPacketInfo.notes && selectedPacketInfo.notes.length > 0 && (
                <div className="detail-notes">
                  <h4>Notes</h4>
                  <ul>
                    {selectedPacketInfo.notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedPacketInfo.examples && selectedPacketInfo.examples.length > 0 && (
                <div className="detail-examples">
                  <h4>Examples</h4>
                  {selectedPacketInfo.examples.map((ex, i) => (
                    <code key={i}>{ex}</code>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="detail-empty">
              <p>Select a packet type to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ProtocolGuide
