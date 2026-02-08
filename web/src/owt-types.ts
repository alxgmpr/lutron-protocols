/**
 * OWT (One Way Transmitter) Device Type Registry
 *
 * Single source of truth for all CCA OWT device types and their button mappings.
 * Covers pico remotes (5-button, 4-button R/L, 4-button scene, 2-button)
 * and sensor placeholders (motion, daylight).
 */

export interface OwtButton {
  /** Button code sent over RF (e.g. 0x02 for ON) */
  code: number
  /** Display label */
  label: string
  /** Button color variant */
  variant: 'green' | 'red' | 'blue' | 'purple' | 'orange' | 'default'
  /** Long-format command bytes (bytes 17-21) if known */
  longCmd?: [number, number, number, number, number]
  /** Can this button save a favorite/scene level? */
  canSave?: boolean
  /** Does this button support hold-to-dim? */
  canHold?: boolean
  /** SVG icon hint: 'up' | 'down' */
  icon?: 'up' | 'down'
}

export interface OwtDeviceType {
  /** Unique type ID (matches DEVICE_TYPES key) */
  id: string
  /** Human-readable name */
  name: string
  /** Category: remote or sensor */
  category: 'remote' | 'sensor'
  /** Button definitions (empty for sensors) */
  buttons: OwtButton[]
  /** Associated pairing preset key (from PAIRING_PRESETS) */
  pairingPreset?: string
  /** Does this device type support pico set-level? */
  supportsLevel?: boolean
  /** Example Lutron model number */
  model?: string
}

export const OWT_TYPES: Record<string, OwtDeviceType> = {
  'pico-5btn': {
    id: 'pico-5btn',
    name: 'Pico 5-Button',
    category: 'remote',
    pairingPreset: '5btn',
    supportsLevel: true,
    model: 'PJ2-3BRL',
    buttons: [
      { code: 0x02, label: 'ON', variant: 'green', longCmd: [0x40, 0x00, 0x20, 0x00, 0x00] },
      { code: 0x03, label: 'FAV', variant: 'purple', longCmd: [0x40, 0x00, 0x21, 0x00, 0x00], canSave: true },
      { code: 0x04, label: 'OFF', variant: 'red', longCmd: [0x40, 0x00, 0x22, 0x00, 0x00] },
      { code: 0x05, label: 'RAISE', variant: 'blue', longCmd: [0x42, 0x02, 0x01, 0x00, 0x16], canHold: true, icon: 'up' },
      { code: 0x06, label: 'LOWER', variant: 'blue', longCmd: [0x42, 0x02, 0x00, 0x00, 0x43], canHold: true, icon: 'down' },
    ]
  },
  'pico-4btn-rl': {
    id: 'pico-4btn-rl',
    name: 'Pico 4B Raise/Lower',
    category: 'remote',
    pairingPreset: '4btn-rl',
    supportsLevel: true,
    model: 'PJ2-4B',
    buttons: [
      { code: 0x08, label: 'ON', variant: 'green' },
      { code: 0x09, label: 'RAISE', variant: 'blue', canHold: true, icon: 'up' },
      { code: 0x0A, label: 'LOWER', variant: 'blue', canHold: true, icon: 'down' },
      { code: 0x0B, label: 'OFF', variant: 'red' },
    ]
  },
  'pico-4btn-scene': {
    id: 'pico-4btn-scene',
    name: 'Pico 4B Scene',
    category: 'remote',
    pairingPreset: '4btn-scene-custom',
    supportsLevel: false,
    model: 'PJ2-4B-S',
    buttons: [
      { code: 0x08, label: 'SCENE 4', variant: 'orange', canSave: true },
      { code: 0x09, label: 'SCENE 3', variant: 'orange', canSave: true },
      { code: 0x0A, label: 'SCENE 2', variant: 'orange', canSave: true },
      { code: 0x0B, label: 'OFF', variant: 'red' },
    ]
  },
  'pico-2btn': {
    id: 'pico-2btn',
    name: 'Pico 2-Button',
    category: 'remote',
    pairingPreset: '2btn',
    supportsLevel: true,
    model: 'PJ2-2B',
    buttons: [
      { code: 0x02, label: 'ON', variant: 'green' },
      { code: 0x04, label: 'OFF', variant: 'red' },
    ]
  },
  'sensor-motion': {
    id: 'sensor-motion',
    name: 'Motion Sensor',
    category: 'sensor',
    model: 'LRF3-OKLB',
    buttons: [
      { code: 0x02, label: 'OCCUPIED', variant: 'green' },
      { code: 0x04, label: 'UNOCCUPIED', variant: 'default' },
    ]
  },
  'sensor-daylight': {
    id: 'sensor-daylight',
    name: 'Daylight Sensor',
    category: 'sensor',
    model: 'LRF3-DKLB',
    buttons: []
  },
}

/** Get buttons for a given OWT type ID */
export function getOwtButtons(typeId: string): OwtButton[] {
  return OWT_TYPES[typeId]?.buttons ?? []
}

/** Get the full OWT device type definition */
export function getOwtType(typeId: string): OwtDeviceType | undefined {
  return OWT_TYPES[typeId]
}

/** Get all remote-category OWT types */
export function getOwtRemoteTypes(): OwtDeviceType[] {
  return Object.values(OWT_TYPES).filter(t => t.category === 'remote')
}

/** Check if a device_type string refers to an OWT type */
export function isOwtType(deviceType: string): boolean {
  return deviceType in OWT_TYPES
}
