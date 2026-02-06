/**
 * RF Role types (from backend classification):
 * - one_way_tx: One-way transmitter (Pico, motion sensor)
 * - two_way_cca_node: Device on CCA subnet (dimmer, switch controlled via bridge)
 * - cca_bridge: Bridge/processor (initiates SET_LEVEL, owns subnet)
 * - silent_load_candidate: Possible one-way receiver (never transmits)
 * - unknown: Cannot determine from available evidence
 */
export type RfRole = 'one_way_tx' | 'two_way_cca_node' | 'cca_bridge' | 'silent_load_candidate' | 'unknown'

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
  // New RF behavior fields
  rf_role?: RfRole
  confidence?: number  // 0.0 to 1.0
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

export interface ParsedField {
  name: string
  start: number
  end: number
  raw: string
  decoded: string | null
}

export interface Packet {
  time: string
  protocol: 'cca' | 'ccx'
  type: string        // e.g., "LEVEL", "BTN_PRESS_A", "BEACON", "PAIRING" (CCA) or "LEVEL_CONTROL", "BUTTON_PRESS" (CCX)
  summary: string     // Short description for display
  details: string[]   // Additional info parts
  rawBytes?: string   // Hex bytes if available
  direction: 'tx' | 'rx'
  fields?: ParsedField[]  // Backend-parsed field breakdown
  crcOk?: boolean     // CRC validation status (RX packets only, undefined = ok/unknown)
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
  // 5-button picos
  '5btn': { pkt: 'B9', b10: '0x04', b30: '0x03', b31: '0x00', b37: '0x02', b38: '0x06', desc: 'ON / FAV / OFF / RAISE / LOWER' },
  // 2-button picos
  '2btn': { pkt: 'B9', b10: '0x04', b30: '0x03', b31: '0x08', b37: '0x01', b38: '0x01', desc: 'ON / OFF (FAV acts as ON)' },
  '2btn-home': { pkt: 'BB', b10: '0x04', b30: '0x03', b31: '0x00', b37: '0x02', b38: '0x23', desc: 'HOME / AWAY' },
  // 4-button raise/lower
  '4btn-rl': { pkt: 'B9', b10: '0x0B', b30: '0x02', b31: '0x00', b37: '0x02', b38: '0x21', desc: 'ON / RAISE / LOWER / OFF' },
  // 4-button scene picos (factory engraved)
  '4btn-cooking': { pkt: 'B9', b10: '0x0B', b30: '0x04', b31: '0x00', b37: '0x02', b38: '0x25', desc: 'BRIGHT / COOKING / DINING / OFF' },
  '4btn-movie': { pkt: 'B9', b10: '0x0B', b30: '0x04', b31: '0x00', b37: '0x02', b38: '0x26', desc: 'BRIGHT / ENTERTAIN / MOVIE / OFF' },
  '4btn-relax': { pkt: 'B8', b10: '0x0B', b30: '0x04', b31: '0x00', b37: '0x02', b38: '0x27', desc: 'BRIGHT / ENTERTAIN / RELAX / OFF (bridge-only)' },
  '4btn-scene-custom': { pkt: 'B9', b10: '0x0B', b30: '0x04', b31: '0x00', b37: '0x02', b38: '0x28', desc: 'Custom engraved 4-button scene' },
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

// CCA Subnet (discovered from SET_LEVEL/STATE_RPT traffic)
export interface CcaSubnet {
  subnet_id: string              // 4-hex subnet ID (big-endian display format)
  primary_bridge_id?: string     // Best guess at owning bridge (8-hex)
  first_seen: string
  last_seen: string
  confidence: number             // 0.0 to 1.0
  source_counts?: {              // Packet type counts
    set_level?: number
    state_rpt?: number
  }
  member_count?: number          // Number of devices on this subnet
  members?: CcaSubnetMember[]    // Devices on this subnet (when expanded)
}

// CCA Subnet Member
export interface CcaSubnetMember {
  id: number
  subnet_id: string
  cca_device_id: string          // Full 8-hex device address
  first_seen: string
  last_seen: string
  role_hint: 'node' | 'bridge' | 'unknown'
  confidence: number
}

// RF Link (transmitter -> receiver relationship)
export interface RfLink {
  id: number
  tx_id: string                  // Transmitter device ID
  rx_id: string                  // Receiver device ID (or CCA device)
  link_type: 'direct_one_way' | 'via_bridge' | 'unknown'
  first_seen: string
  last_seen: string
  confidence: number
  supporting_event_count: number
}

// RF Link Event (raw observed linkage fact)
export interface RfLinkEvent {
  id: number
  timestamp: string
  tx_id: string
  subnet_id?: string
  rx_candidate_id?: string
  evidence: 'pairing_sequence' | 'control_state_change' | 'ack_chain' | 'user_annotated'
  confidence: number
  packet_refs?: number[]
  details?: Record<string, unknown>
}

// Low-Latency Relay Rule (direct packet translation)
export interface RelayRule {
  id: number
  name: string
  enabled: boolean | number
  source_device_id: string
  target_device_id: string
  target_bridge_id?: string
  bidirectional: boolean | number
  relay_buttons: boolean | number
  relay_level: boolean | number
  created_at?: string
  updated_at?: string
}

// Relay Statistics
export interface RelayStats {
  packets_received: number
  packets_relayed: number
  packets_dropped: number
  last_relay_latency_ms: number
  avg_relay_latency_ms: number
  active_rules: number
  pending_acks: number
}



