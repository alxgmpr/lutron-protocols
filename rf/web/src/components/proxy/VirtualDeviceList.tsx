import { useState } from 'react'
import { Button } from '../common/Button'
import type { VirtualDevice } from '../../types'

interface VirtualDeviceListProps {
  devices: VirtualDevice[]
  onCreate: (device: { name: string; device_type: string; subnet?: string }) => void
  onDelete: (deviceId: string) => void
}

export function VirtualDeviceList({ devices, onCreate, onDelete }: VirtualDeviceListProps) {
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState('dimmer')
  const [newSubnet, setNewSubnet] = useState('')

  const handleCreate = () => {
    if (!newName.trim()) return
    onCreate({
      name: newName.trim(),
      device_type: newType,
      subnet: newSubnet.trim() || undefined
    })
    setNewName('')
    setNewSubnet('')
  }

  return (
    <div className="virtual-device-list">
      {devices.length === 0 ? (
        <div style={{ padding: '0.5rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          No virtual devices. Create one to emulate a Lutron device.
        </div>
      ) : (
        devices.map(device => (
          <div key={device.id} className="virtual-device-item">
            <div className="virtual-device-info">
              <div className="virtual-device-name">{device.name}</div>
              <div className="virtual-device-meta">
                {device.id} | {device.device_type}
                {device.subnet && ` | Subnet: ${device.subnet}`}
                {device.current_level !== undefined && ` | Level: ${device.current_level}%`}
              </div>
            </div>
            <div className="virtual-device-actions">
              <Button size="sm" variant="red" onClick={() => onDelete(device.id)}>
                Delete
              </Button>
            </div>
          </div>
        ))
      )}

      <div className="virtual-device-create">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Device name"
          className="form-input"
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        />
        <select
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
          className="form-select"
        >
          <option value="dimmer">Dimmer</option>
          <option value="pico">Pico</option>
        </select>
        <input
          type="text"
          value={newSubnet}
          onChange={(e) => setNewSubnet(e.target.value)}
          placeholder="Subnet (opt)"
          className="form-input"
          style={{ width: '100px' }}
        />
        <Button onClick={handleCreate} disabled={!newName.trim()}>
          Create
        </Button>
      </div>
    </div>
  )
}
