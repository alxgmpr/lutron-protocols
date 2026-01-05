import { createContext, useContext, useMemo, ReactNode } from 'react'
import type { Device } from '../types'

interface SeenDevices {
  // Bridge subnets (4-char hex like "2C90")
  bridgeSubnets: string[]
  // Full bridge zone IDs (8-char hex like "002C90AD")
  bridgeZones: string[]
  // Pico device IDs
  picos: string[]
  // Dimmer/switch device IDs (targets for bridge commands)
  dimmers: string[]
  // All device IDs
  all: string[]
}

interface DeviceContextValue {
  devices: Record<string, Device>
  seen: SeenDevices
}

const DeviceContext = createContext<DeviceContextValue>({
  devices: {},
  seen: { bridgeSubnets: [], bridgeZones: [], picos: [], dimmers: [], all: [] }
})

function extractBridgeSubnet(device: Device): string | null {
  // From bridge_pairing (extracted from STATE_RPT)
  if (device.info?.bridge_pairing) {
    return device.info.bridge_pairing as string
  }
  // From bridge_id (from LEVEL commands)
  if (device.info?.bridge_id) {
    const idStr = (device.info.bridge_id as string).replace(/^0x/i, '')
    const idNum = parseInt(idStr, 16)
    const subnet = (idNum >> 8) & 0xFFFF
    return subnet.toString(16).toUpperCase().padStart(4, '0')
  }
  return null
}

function extractBridgeZone(device: Device): string | null {
  if (device.info?.bridge_id) {
    return (device.info.bridge_id as string).replace(/^0x/i, '').toUpperCase()
  }
  return null
}

export function DeviceProvider({ devices, children }: { devices: Record<string, Device>, children: ReactNode }) {
  const seen = useMemo<SeenDevices>(() => {
    const subnets = new Set<string>()
    const zones = new Set<string>()
    const picos = new Set<string>()
    const dimmers = new Set<string>()
    const all = new Set<string>()

    Object.entries(devices).forEach(([id, device]) => {
      all.add(id.toUpperCase())

      const category = device.info?.category || ''
      const type = device.info?.type || ''

      // Extract bridge info
      const subnet = extractBridgeSubnet(device)
      if (subnet) subnets.add(subnet)

      const zone = extractBridgeZone(device)
      if (zone) zones.add(zone)

      // Categorize by device type
      if (category === 'pico' || category === 'scene_pico' || type.startsWith('BTN_')) {
        picos.add(id.toUpperCase())
      } else if (category === 'dimmer' || category === 'dimmer_passive' ||
                 category === 'bridge_controlled' || type === 'LEVEL' || type === 'STATE_RPT') {
        dimmers.add(id.toUpperCase())
        // Also add factory_id if present (the actual device ID)
        if (device.info?.factory_id) {
          dimmers.add((device.info.factory_id as string).toUpperCase())
        }
      }
    })

    return {
      bridgeSubnets: Array.from(subnets).sort(),
      bridgeZones: Array.from(zones).sort(),
      picos: Array.from(picos).sort(),
      dimmers: Array.from(dimmers).sort(),
      all: Array.from(all).sort()
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
