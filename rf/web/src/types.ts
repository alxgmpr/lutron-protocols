export interface Device {
  id: string
  type: string
  first_seen: string
  last_seen: string
  count: number
  label?: string
  model?: string
  device_type?: string
  link_id?: string
  info: DeviceInfo
}

export interface DeviceInfo {
  type?: string
  category?: string
  button?: string
  level?: string
  bridge_id?: string
  bridge_pairing?: string
  factory_id?: string
  rf_tx_id?: string
  controllable?: boolean
  id_format?: 'subnet' | 'label'  // subnet = little-endian with subnet, label = big-endian printed ID
  packet_type?: string
  subnet?: string  // Subnet address in Lutron Designer format (big-endian, e.g., "902C")
}

export interface LogEntry {
  time: string
  level: string
  msg: string
  type?: string
}

export interface Packet {
  time: string
  type: string        // e.g., "LEVEL", "BTN_SHORT_A", "BEACON", "PAIRING"
  summary: string     // Short description for display
  details: string[]   // Additional info parts
  rawBytes?: string   // Hex bytes if available
  direction: 'tx' | 'rx'
}

export interface ApiResponse {
  status: 'ok' | 'error'
  error?: string
  [key: string]: unknown
}

export interface PairingPreset {
  pkt: string
  b10: string
  b30: string
  b31: string
  b37: string
  b38: string
  desc: string
}

export const PAIRING_PRESETS: Record<string, PairingPreset> = {
  '5btn': { pkt: 'B9', b10: '0x04', b30: '0x03', b31: '0x00', b37: '0x02', b38: '0x06', desc: 'Direct pair, FAV button works' },
  '2btn': { pkt: 'B9', b10: '0x04', b30: '0x03', b31: '0x08', b37: '0x01', b38: '0x01', desc: 'Direct pair, FAV acts as ON' },
  '4btn-rl': { pkt: 'B9', b10: '0x0B', b30: '0x02', b31: '0x00', b37: '0x02', b38: '0x21', desc: 'Direct pair, raise/lower' },
  '4btn-scene-custom': { pkt: 'B9', b10: '0x0B', b30: '0x04', b31: '0x00', b37: '0x02', b38: '0x28', desc: 'Direct pair scene (custom engraved)' },
  '4btn-scene-std': { pkt: 'BA', b10: '0x0B', b30: '0x04', b31: '0x00', b37: '0x02', b38: '0x27', desc: 'Bridge-only scene pico' },
  'custom': { pkt: 'B9', b10: '0x04', b30: '0x03', b31: '0x00', b37: '0x02', b38: '0x06', desc: 'Custom parameters' }
}

export const DEVICE_TYPES: Record<string, { name: string; buttons: string | null }> = {
  'auto': { name: 'Auto', buttons: null },
  'pico-5btn': { name: 'Pico 5-Button', buttons: 'pico' },
  'pico-4btn-rl': { name: 'Pico 4B Raise/Lower', buttons: 'pico_4btn_rl' },
  'pico-scene': { name: 'Pico Scene', buttons: 'scene_pico' },
  'pico-2btn': { name: 'Pico 2-Button', buttons: 'pico_2btn' },
  'dimmer': { name: 'Dimmer', buttons: 'dimmer' },
  'switch': { name: 'Switch', buttons: 'switch' },
  'fan': { name: 'Fan', buttons: 'fan' }
}


