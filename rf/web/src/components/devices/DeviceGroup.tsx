import { useCallback } from 'react'
import type { Device } from '../../types'
import './DeviceGroup.css'

interface DeviceGroupProps {
  label: string
  devices: Array<[string, Device]>
  onClick: () => void
  onQuickAction?: (deviceId: string, action: 'on' | 'off') => void
  formatTime?: (dateString: string) => string
}

function getInferredTypeHint(device: Device): string | null {
  const category = device.info?.category || ''
  const type = device.info?.type || ''

  if (category === 'pico') return 'Pico'
  if (category === 'scene_pico') return 'Scene'
  if (category === 'bridge_controlled') return 'Dimmer'
  if (category === 'dimmer_passive' || category === 'dimmer') return 'Dimmer'
  if (type === 'LEVEL') return 'Dimmer'
  if (type?.startsWith('BTN_')) return 'Remote'
  return null
}

function getDeviceCategory(devices: Array<[string, Device]>): 'pico' | 'dimmer' | 'unknown' {
  for (const [, device] of devices) {
    const category = device.info?.category || ''
    if (category === 'pico' || category === 'scene_pico') return 'pico'
    if (category === 'bridge_controlled' || category === 'dimmer_passive' || category === 'dimmer') return 'dimmer'
  }
  return 'unknown'
}

function extractBridgePairing(devices: Array<[string, Device]>): string | null {
  for (const [, device] of devices) {
    // First check for pre-extracted bridge_pairing
    if (device.info?.bridge_pairing) {
      return device.info.bridge_pairing as string
    }
    // Otherwise extract from bridge_id
    if (device.info?.bridge_id) {
      const idStr = (device.info.bridge_id as string).replace(/^0x/i, '')
      const idNum = parseInt(idStr, 16)
      const pairingId = (idNum >> 8) & 0xFFFF
      return pairingId.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return null
}

export function DeviceGroup({
  label,
  devices,
  onClick,
  onQuickAction,
  formatTime
}: DeviceGroupProps) {
  const groupType = devices.find(([, d]) => d.device_type)?.[1].device_type || 'auto'
  const inferredHint = groupType === 'auto' ? getInferredTypeHint(devices[0]?.[1]) : null
  const category = getDeviceCategory(devices)
  const bridgePairing = extractBridgePairing(devices)

  const mostRecentTime = devices.reduce((latest, [, d]) => {
    const time = new Date(d.last_seen || 0).getTime()
    return time > latest ? time : latest
  }, 0)
  const lastSeenStr = formatTime && mostRecentTime > 0
    ? formatTime(new Date(mostRecentTime).toISOString())
    : ''

  // Get current level if any device reports it
  const currentLevel = devices.reduce<string | null>((lvl, [, d]) => {
    if (d.info?.level) return d.info.level as string
    return lvl
  }, null)

  const handleQuickOn = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onQuickAction) return
    // Find a device with controllable info
    const controllable = devices.find(([, d]) => d.info?.controllable)
    if (controllable) {
      onQuickAction(controllable[0], 'on')
    }
  }, [devices, onQuickAction])

  const handleQuickOff = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onQuickAction) return
    const controllable = devices.find(([, d]) => d.info?.controllable)
    if (controllable) {
      onQuickAction(controllable[0], 'off')
    }
  }, [devices, onQuickAction])

  const showQuickButtons = onQuickAction && category !== 'unknown'

  return (
    <div className="device-group" onClick={onClick}>
      <div className="device-group-content">
        <div className="device-group-info">
          <span className="device-group-label">{label}</span>
          {inferredHint && <span className="device-type-badge">{inferredHint}</span>}
          {bridgePairing && <span className="device-bridge-badge">{bridgePairing}</span>}
          {currentLevel && <span className="device-level-badge">{currentLevel}</span>}
        </div>
        <div className="device-group-right">
          {showQuickButtons && (
            <div className="device-quick-actions">
              <button className="quick-btn quick-btn-on" onClick={handleQuickOn}>ON</button>
              <button className="quick-btn quick-btn-off" onClick={handleQuickOff}>OFF</button>
            </div>
          )}
          <span className="device-group-meta">{devices.length}</span>
          {lastSeenStr && <span className="device-group-time">{lastSeenStr}</span>}
        </div>
      </div>
    </div>
  )
}
