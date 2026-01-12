import type { Device, RfRole } from '../../types'
import './UnknownDeviceRow.css'

interface UnknownDeviceRowProps {
  device: Device
  onClick: () => void
  formatTime?: (dateString: string) => string
}

// Map RF roles to user-friendly hints
function getRfRoleInfo(device: Device): { hint: string; role: RfRole; showSubnet: boolean } {
  const rfRole = device.rf_role || 'unknown'
  const category = device.info?.category || ''
  const type = device.info?.type || ''

  // Use rf_role if available and not unknown
  if (rfRole && rfRole !== 'unknown') {
    if (rfRole === 'one_way_tx') {
      if (category === 'scene_pico') return { hint: 'Scene Pico', role: rfRole, showSubnet: false }
      if (category === 'pico') return { hint: 'Pico Remote', role: rfRole, showSubnet: false }
      return { hint: 'One-Way TX', role: rfRole, showSubnet: false }
    }
    if (rfRole === 'two_way_cca_node') {
      return { hint: 'CCA Device', role: rfRole, showSubnet: true }
    }
    if (rfRole === 'cca_bridge') {
      return { hint: 'CCA Bridge', role: rfRole, showSubnet: true }
    }
    if (rfRole === 'silent_load_candidate') {
      return { hint: 'Possible Receiver', role: rfRole, showSubnet: false }
    }
    return { hint: 'Unknown', role: rfRole, showSubnet: false }
  }

  // Fallback to legacy category inference
  if (category === 'pico') return { hint: 'Pico Remote', role: 'one_way_tx', showSubnet: false }
  if (category === 'scene_pico') return { hint: 'Scene Pico', role: 'one_way_tx', showSubnet: false }
  if (category === 'bridge_controlled') return { hint: 'CCA Device', role: 'two_way_cca_node', showSubnet: true }
  if (category === 'dimmer_passive' || category === 'dimmer') return { hint: 'CCA Device', role: 'two_way_cca_node', showSubnet: true }
  if (type === 'LEVEL') return { hint: 'CCA Device', role: 'two_way_cca_node', showSubnet: true }
  if (type?.startsWith('BTN_')) return { hint: 'One-Way TX', role: 'one_way_tx', showSubnet: false }

  return { hint: 'Unknown', role: 'unknown', showSubnet: false }
}

export function UnknownDeviceRow({ device, onClick, formatTime }: UnknownDeviceRowProps) {
  const info = device.info || {}
  const lastSeen = formatTime ? formatTime(device.last_seen) : ''
  const { hint, role, showSubnet } = getRfRoleInfo(device)
  // Use stored subnet from backend (extracted from bridge for LEVEL, device for STATE_RPT)
  const subnet = info.subnet
  const confidence = device.confidence

  // Determine badge class based on RF role
  const roleClass = role === 'one_way_tx' ? 'rf-role-tx' :
                    role === 'two_way_cca_node' ? 'rf-role-cca' :
                    role === 'cca_bridge' ? 'rf-role-bridge' :
                    role === 'silent_load_candidate' ? 'rf-role-silent' :
                    ''

  return (
    <div className={`unknown-device-row ${roleClass}`} onClick={onClick}>
      <div className="unknown-device-main">
        <div className="unknown-device-id">
          {device.id}
          {showSubnet && subnet && <span className="unknown-device-subnet" title="CCA Subnet">{subnet}</span>}
        </div>
        <div className="unknown-device-hint">
          <span className={`unknown-device-role-badge ${roleClass}`}>{hint}</span>
          {confidence !== undefined && confidence > 0 && (
            <span className="unknown-device-confidence" title="Classification confidence">
              {Math.round(confidence * 100)}%
            </span>
          )}
          {info.id_format === 'label' && <span className="unknown-device-label-tag">Label ID</span>}
        </div>
      </div>
      <div className="unknown-device-meta">
        {info.level && <span className="unknown-device-level">{info.level}</span>}
        <span className="unknown-device-time">{lastSeen}</span>
        <span className="unknown-device-action">Click to configure</span>
      </div>
    </div>
  )
}
