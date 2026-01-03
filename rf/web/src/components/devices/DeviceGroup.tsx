import { DEVICE_TYPES } from '../../types'
import type { Device } from '../../types'
import './DeviceGroup.css'

interface DeviceGroupProps {
  label: string
  devices: Array<[string, Device]>
  onSetType: (id: string, type: string) => void
  onClick: () => void
  formatTime?: (dateString: string) => string
}

export function DeviceGroup({
  label,
  devices,
  onSetType,
  onClick,
  formatTime
}: DeviceGroupProps) {
  const groupType = devices.find(([, d]) => d.device_type)?.[1].device_type || 'auto'
  
  const mostRecentTime = devices.reduce((latest, [, d]) => {
    const time = new Date(d.last_seen || 0).getTime()
    return time > latest ? time : latest
  }, 0)
  const lastSeenStr = formatTime && mostRecentTime > 0 
    ? formatTime(new Date(mostRecentTime).toISOString()) 
    : ''

  const handleGroupTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation()
    const type = e.target.value
    devices.forEach(([id]) => onSetType(id, type))
  }

  const sortedDevices = [...devices].sort((a, b) => {
    const aTime = new Date(a[1].last_seen || 0).getTime()
    const bTime = new Date(b[1].last_seen || 0).getTime()
    return bTime - aTime
  })

  return (
    <div className="device-group" onClick={onClick}>
      <div className="device-group-header">
        <span className="device-group-label">{label}</span>
        <select
          className="device-type-select"
          value={groupType}
          onChange={handleGroupTypeChange}
          onClick={e => e.stopPropagation()}
        >
          {Object.entries(DEVICE_TYPES).map(([key, val]) => (
            <option key={key} value={key}>{val.name}</option>
          ))}
        </select>
        <span className="device-group-meta">{devices.length} ID{devices.length > 1 ? 's' : ''}</span>
        {lastSeenStr && <span className="device-group-time">{lastSeenStr}</span>}
        <span className="device-group-action">Click to manage →</span>
      </div>
      <div className="device-group-ids">
        {sortedDevices.slice(0, 3).map(([id, device]) => (
          <span key={id} className="device-id-chip">
            {id}
            {device.info?.level && <span className="chip-level">{device.info.level}</span>}
          </span>
        ))}
        {sortedDevices.length > 3 && (
          <span className="device-id-more">+{sortedDevices.length - 3} more</span>
        )}
      </div>
    </div>
  )
}
