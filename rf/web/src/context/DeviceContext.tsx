import { createContext, useContext, useMemo, ReactNode } from 'react'
import type { Device } from '../types'

/**
 * RF Role types (from backend _infer_rf_role):
 * - one_way_tx: One-way transmitter (Pico, motion sensor)
 * - two_way_cca_node: Device on CCA subnet (dimmer, switch controlled via bridge)
 * - cca_bridge: Bridge/processor (initiates SET_LEVEL, owns subnet)
 * - silent_load_candidate: Possible one-way receiver (never transmits)
 * - unknown: Cannot determine from available evidence
 */
type RfRole = 'one_way_tx' | 'two_way_cca_node' | 'cca_bridge' | 'silent_load_candidate' | 'unknown'

interface SeenDevices {
  // CCA subnets (4-char hex like "2C90") - only from actual CCA traffic
  ccaSubnets: string[]
  // Full bridge/processor IDs (8-char hex like "002C90AD")
  bridges: string[]
  // One-way transmitters (Picos, motion sensors) - device IDs
  oneWayTx: string[]
  // Two-way CCA nodes (dimmers, switches on CCA subnet)
  ccaNodes: string[]
  // All device IDs
  all: string[]

  // Legacy aliases for backwards compatibility
  bridgeSubnets: string[]
  bridgeZones: string[]
  picos: string[]
  dimmers: string[]
}

interface DeviceContextValue {
  devices: Record<string, Device>
  seen: SeenDevices
}

const DeviceContext = createContext<DeviceContextValue>({
  devices: {},
  seen: {
    ccaSubnets: [],
    bridges: [],
    oneWayTx: [],
    ccaNodes: [],
    all: [],
    // Legacy
    bridgeSubnets: [],
    bridgeZones: [],
    picos: [],
    dimmers: []
  }
})

function extractCcaSubnet(device: Device): string | null {
  // From subnet field (calculated from CCA packet addresses)
  if (device.info?.subnet) {
    return (device.info.subnet as string).toUpperCase()
  }
  // Fallback: From bridge_pairing (extracted from STATE_RPT)
  if (device.info?.bridge_pairing) {
    return (device.info.bridge_pairing as string).toUpperCase()
  }
  // Fallback: From bridge_id (from LEVEL commands)
  if (device.info?.bridge_id) {
    const idStr = (device.info.bridge_id as string).replace(/^0x/i, '')
    const idNum = parseInt(idStr, 16)
    const subnet = (idNum >> 8) & 0xFFFF
    return subnet.toString(16).toUpperCase().padStart(4, '0')
  }
  return null
}

function extractBridgeId(device: Device): string | null {
  if (device.info?.bridge_id) {
    return (device.info.bridge_id as string).replace(/^0x/i, '').toUpperCase()
  }
  return null
}

function getRfRole(device: Device): RfRole {
  // Prefer explicit rf_role from backend
  if (device.rf_role && device.rf_role !== 'unknown') {
    return device.rf_role as RfRole
  }

  // Fallback to legacy category inference
  const category = device.info?.category || device.type || ''
  const packetType = device.info?.type || ''

  if (category === 'pico' || category === 'scene_pico' || packetType.startsWith('BTN_')) {
    return 'one_way_tx'
  }
  if (category === 'bridge_controlled' || category === 'cca_bridge') {
    return 'two_way_cca_node'
  }
  if (category === 'dimmer_passive' || packetType === 'STATE_RPT') {
    return 'two_way_cca_node'
  }
  if (category === 'beacon') {
    return 'cca_bridge'
  }

  return 'unknown'
}

export function DeviceProvider({ devices, children }: { devices: Record<string, Device>, children: ReactNode }) {
  const seen = useMemo<SeenDevices>(() => {
    const ccaSubnets = new Set<string>()
    const bridges = new Set<string>()
    const oneWayTx = new Set<string>()
    const ccaNodes = new Set<string>()
    const all = new Set<string>()

    Object.entries(devices).forEach(([id, device]) => {
      const upperId = id.toUpperCase()
      all.add(upperId)

      const rfRole = getRfRole(device)

      // Categorize by RF role
      switch (rfRole) {
        case 'one_way_tx':
          oneWayTx.add(upperId)
          break
        case 'two_way_cca_node':
          ccaNodes.add(upperId)
          // Extract subnet for CCA nodes
          const nodeSubnet = extractCcaSubnet(device)
          if (nodeSubnet) ccaSubnets.add(nodeSubnet)
          break
        case 'cca_bridge':
          bridges.add(upperId)
          // Bridges also have subnets
          const bridgeSubnet = extractCcaSubnet(device)
          if (bridgeSubnet) ccaSubnets.add(bridgeSubnet)
          break
        case 'silent_load_candidate':
          // Could be one-way receiver or quiet CCA node
          // For now, don't categorize strongly
          break
        default:
          // Unknown - check for CCA subnet evidence
          const unknownSubnet = extractCcaSubnet(device)
          if (unknownSubnet) {
            ccaSubnets.add(unknownSubnet)
            ccaNodes.add(upperId) // If it has a subnet, it's probably a CCA node
          }
      }

      // Extract bridge ID if present (for SET_LEVEL source tracking)
      const bridgeId = extractBridgeId(device)
      if (bridgeId) bridges.add(bridgeId)

      // Also add factory_id if present (the actual device ID from LEVEL commands)
      if (device.info?.factory_id) {
        const factoryId = (device.info.factory_id as string).toUpperCase()
        all.add(factoryId)
        if (rfRole === 'two_way_cca_node' || rfRole === 'cca_bridge') {
          ccaNodes.add(factoryId)
        }
      }
    })

    // Build result with both new names and legacy aliases
    const ccaSubnetsArray = Array.from(ccaSubnets).sort()
    const bridgesArray = Array.from(bridges).sort()
    const oneWayTxArray = Array.from(oneWayTx).sort()
    const ccaNodesArray = Array.from(ccaNodes).sort()

    return {
      // New naming
      ccaSubnets: ccaSubnetsArray,
      bridges: bridgesArray,
      oneWayTx: oneWayTxArray,
      ccaNodes: ccaNodesArray,
      all: Array.from(all).sort(),

      // Legacy aliases for backwards compatibility
      bridgeSubnets: ccaSubnetsArray,
      bridgeZones: bridgesArray,
      picos: oneWayTxArray,
      dimmers: ccaNodesArray
    }
  }, [devices])

  return (
    <DeviceContext.Provider value={{ devices, seen }}>
      {children}
    </DeviceContext.Provider>
  )
}

export function useDevices() {
  return useContext(DeviceContext)
}
