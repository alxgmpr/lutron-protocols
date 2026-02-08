import { useCallback } from 'react'
import type { Device, RfRole } from '../../types'
import './DeviceGroup.css'

interface DeviceGroupProps {
  label: string
  devices: Array<[string, Device]>
  onClick: () => void
  onQuickAction?: (deviceId: string, action: 'on' | 'off') => void
  formatTime?: (dateString: string) => string
}

// Map RF roles to user-friendly labels
const RF_ROLE_LABELS: Record<RfRole, string> = {
  'one_way_tx': 'Transmitter',
  'two_way_cca_node': 'CCA Device',
  'cca_bridge': 'Bridge',
  'silent_load_candidate': 'Receiver?',
  'unknown': ''
}

// Map RF roles to more specific device hints based on additional context
function getRfRoleHint(device: Device): { label: string; role: RfRole } {
  const rfRole = device.rf_role || 'unknown'
  const category = device.info?.category || ''
  const type = device.info?.type || ''

  // Use rf_role if available and not unknown
  if (rfRole && rfRole !== 'unknown') {
    // Add specificity based on legacy category
    if (rfRole === 'one_way_tx') {
      if (category === 'scene_pico') return { label: 'OWT Scene', role: rfRole }
      if (category === 'pico') return { label: 'OWT Pico', role: rfRole }
      return { label: 'OWT', role: rfRole }
    }
    if (rfRole === 'two_way_cca_node') {
      return { label: 'CCA Device', role: rfRole }
    }
    if (rfRole === 'cca_bridge') {
      return { label: 'Bridge', role: rfRole }
    }
    return { label: RF_ROLE_LABELS[rfRole], role: rfRole }
  }

  // Fallback to legacy category inference
  if (category === 'pico') return { label: 'OWT Pico', role: 'one_way_tx' }
  if (category === 'scene_pico') return { label: 'OWT Scene', role: 'one_way_tx' }
  if (category === 'bridge_controlled') return { label: 'CCA Device', role: 'two_way_cca_node' }
  if (category === 'dimmer_passive' || category === 'dimmer') return { label: 'CCA Device', role: 'two_way_cca_node' }
  if (type === 'LEVEL') return { label: 'CCA Device', role: 'two_way_cca_node' }
  if (type?.startsWith('BTN_')) return { label: 'OWT', role: 'one_way_tx' }

  return { label: '', role: 'unknown' }
}

function getDeviceCategory(devices: Array<[string, Device]>): 'owt' | 'dimmer' | 'unknown' {
  for (const [, device] of devices) {
    const rfRole = device.rf_role
    if (rfRole === 'one_way_tx') return 'owt'
    if (rfRole === 'two_way_cca_node' || rfRole === 'cca_bridge') return 'dimmer'

    // Legacy fallback
    const category = device.info?.category || ''
    if (category === 'pico' || category === 'scene_pico') return 'owt'
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
    // Check for subnet (new field)
    if (device.info?.subnet) {
      return device.info.subnet as string
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
  const { label: inferredHint, role: rfRole } = groupType === 'auto'
    ? getRfRoleHint(devices[0]?.[1])
    : { label: null, role: 'unknown' as RfRole }
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

  // Determine badge class based on RF role
  const badgeClass = rfRole === 'one_way_tx' ? 'device-type-badge rf-role-tx' :
                     rfRole === 'two_way_cca_node' ? 'device-type-badge rf-role-cca' :
                     rfRole === 'cca_bridge' ? 'device-type-badge rf-role-bridge' :
                     'device-type-badge'

  return (
    <div className="device-group" onClick={onClick}>
      <div className="device-group-content">
        <div className="device-group-info">
          <span className="device-group-label">{label}</span>
          {inferredHint && <span className={badgeClass}>{inferredHint}</span>}
          {bridgePairing && <span className="device-bridge-badge" title="CCA Subnet">{bridgePairing}</span>}
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
