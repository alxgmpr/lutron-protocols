import type { Device } from '../../types'
import './UnknownDeviceRow.css'

interface UnknownDeviceRowProps {
  device: Device
  onClick: () => void
  formatTime?: (dateString: string) => string
}

function getDeviceHint(device: Device): string {
  const category = device.info?.category || ''
  const type = device.info?.type || ''
  
  if (category === 'pico') return 'Pico Remote'
  if (category === 'scene_pico') return 'Scene Pico'
  if (category === 'bridge_controlled') return 'Dimmer/Switch'
  if (category === 'dimmer_passive' || category === 'dimmer') return 'Dimmer'
  if (type === 'LEVEL') return 'Dimmer'
  if (type?.startsWith('BTN_')) return 'Remote'
  return 'Unknown'
}

export function UnknownDeviceRow({ device, onClick, formatTime }: UnknownDeviceRowProps) {
  const info = device.info || {}
  const lastSeen = formatTime ? formatTime(device.last_seen) : ''
  const hint = getDeviceHint(device)
  // Use stored subnet from backend (extracted from bridge for LEVEL, device for STATE_RPT)
  const subnet = info.subnet

  return (
    <div className="unknown-device-row" onClick={onClick}>
      <div className="unknown-device-main">
        <div className="unknown-device-id">
          {device.id}
          {subnet && <span className="unknown-device-subnet" title="Subnet Address">{subnet}</span>}
        </div>
        <div className="unknown-device-hint">{hint}{info.id_format === 'label' ? ' (Label ID)' : ''}</div>
      </div>
      <div className="unknown-device-meta">
        {info.level && <span className="unknown-device-level">{info.level}</span>}
        <span className="unknown-device-time">{lastSeen}</span>
        <span className="unknown-device-action">Click to configure →</span>
      </div>
    </div>
  )
}



