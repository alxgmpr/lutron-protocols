import { useState, useEffect, useCallback } from 'react'
import { Button } from '../common'
import { DEVICE_TYPES } from '../../types'
import type { Device } from '../../types'
import './DeviceDetailModal.css'

interface DeviceDetailModalProps {
  device: Device
  groupDevices?: Array<[string, Device]>
  existingLabels: string[]
  onClose: () => void
  onSave: (label: string, deviceType: string, model: string) => void
  onDelete: (id: string) => void
  onReplayButton: (deviceId: string, button: number) => void
  onReplayBridge: (sourceId: string, targetId: string, level: number) => void
  onFakeState: (deviceId: string, level: number) => void
  getEffectiveType: (device: Device) => string
}

function inferDeviceInfo(device: Device): { guess: string; confidence: string; details: string[] } {
  const info = device.info || {}
  const category = info.category || ''
  const details: string[] = []
  
  if (info.bridge_id) {
    details.push(`Controlled by bridge ${info.bridge_id}`)
  }
  if (info.level) {
    details.push(`Last level: ${info.level}`)
  }
  if (info.button) {
    details.push(`Button: ${info.button}`)
  }
  
  let guess = 'Unknown device type'
  let confidence = 'Low'
  
  if (category === 'pico') {
    guess = 'Pico Remote (5-Button)'
    confidence = 'High'
    details.push('Detected button press patterns')
  } else if (category === 'scene_pico') {
    guess = 'Pico Scene Remote'
    confidence = 'High'
    details.push('Detected scene button activity')
  } else if (category === 'bridge_controlled') {
    guess = 'Dimmer/Switch (Bridge-controlled)'
    confidence = 'High'
    details.push('Receives level commands from bridge')
  } else if (category === 'dimmer_passive' || category === 'dimmer') {
    guess = 'Dimmer (Passive listener)'
    confidence = 'Medium'
    details.push('Reports state changes')
  } else if (info.type === 'LEVEL') {
    guess = 'Dimmer or Switch'
    confidence = 'Medium'
  } else if (info.type?.startsWith('BTN_')) {
    guess = 'Remote or Pico'
    confidence = 'Medium'
  }
  
  return { guess, confidence, details }
}

export function DeviceDetailModal({ 
  device, 
  groupDevices,
  existingLabels, 
  onClose, 
  onSave, 
  onDelete,
  onReplayButton,
  onReplayBridge,
  onFakeState,
  getEffectiveType
}: DeviceDetailModalProps) {
  const isLabeled = !!device.label
  const [mode, setMode] = useState<'new' | 'existing'>(isLabeled ? 'existing' : 'new')
  const [newLabel, setNewLabel] = useState(isLabeled ? '' : '')
  const [selectedLabel, setSelectedLabel] = useState(device.label || existingLabels[0] || '')
  const [deviceType, setDeviceType] = useState(device.device_type || 'auto')
  const [model, setModel] = useState(device.model || '')
  
  const { guess, confidence, details } = inferDeviceInfo(device)
  const effectiveType = getEffectiveType(device)
  
  const allDevices = groupDevices || [[device.id, device] as [string, Device]]
  
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const handleSave = () => {
    const label = mode === 'new' ? newLabel : selectedLabel
    onSave(label, deviceType, model)
  }

  const canSave = isLabeled || (mode === 'new' ? newLabel.trim().length > 0 : selectedLabel.length > 0)

  const renderControlButtons = useCallback((targetDevice: Device) => {
    const info = targetDevice.info || {}
    const bridgeId = info.bridge_id as string | undefined
    const factoryId = info.factory_id as string | undefined
    
    if (effectiveType === 'pico-5btn' || effectiveType === 'pico-4b-rl' || effectiveType === 'pico-scene' || effectiveType === 'pico-2btn') {
      return (
        <div className="modal-control-buttons">
          <Button size="sm" onClick={() => onReplayButton(targetDevice.id, 0x02)}>ON</Button>
          <Button size="sm" onClick={() => onReplayButton(targetDevice.id, 0x03)}>FAV</Button>
          <Button size="sm" onClick={() => onReplayButton(targetDevice.id, 0x04)}>OFF</Button>
          <Button size="sm" onClick={() => onReplayButton(targetDevice.id, 0x05)}>▲</Button>
          <Button size="sm" onClick={() => onReplayButton(targetDevice.id, 0x06)}>▼</Button>
        </div>
      )
    }
    
    if (effectiveType === 'dimmer' || effectiveType === 'switch' || effectiveType === 'fan') {
      const levels = effectiveType === 'fan' ? [0, 25, 50, 75, 100] : [0, 25, 50, 75, 100]
      if (bridgeId && factoryId) {
        return (
          <div className="modal-control-buttons">
            {levels.map(level => (
              <Button key={level} size="sm" onClick={() => onReplayBridge(bridgeId, factoryId, level)}>
                {level}%
              </Button>
            ))}
          </div>
        )
      }
    }
    
    if (effectiveType === 'passive-dimmer' || effectiveType === 'passive-switch' || effectiveType === 'passive-fan') {
      return (
        <div className="modal-control-buttons">
          <Button size="sm" variant="purple" onClick={() => onFakeState(targetDevice.id, 50)}>FAKE 50%</Button>
          <Button size="sm" onClick={() => onFakeState(targetDevice.id, 100)}>100%</Button>
          <Button size="sm" onClick={() => onFakeState(targetDevice.id, 0)}>0%</Button>
        </div>
      )
    }
    
    return null
  }, [effectiveType, onReplayButton, onReplayBridge, onFakeState])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content-large" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{isLabeled ? device.label : 'Configure Device'}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        <div className="modal-body">
          {/* Device Info Section */}
          <div className="device-info-section">
            {!isLabeled && (
              <>
                <div className="device-id-display">{device.id}</div>
                <div className="device-inference">
                  <div className="inference-guess">
                    <span className="inference-label">Detected as:</span>
                    <span className="inference-value">{guess}</span>
                    <span className={`inference-confidence confidence-${confidence.toLowerCase()}`}>
                      {confidence} confidence
                    </span>
                  </div>
                  {details.length > 0 && (
                    <ul className="inference-details">
                      {details.map((detail, i) => (
                        <li key={i}>{detail}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
            <div className="device-stats">
              <span>Seen {device.count || 0} times</span>
              <span>First: {new Date(device.first_seen).toLocaleString()}</span>
              <span>Last: {new Date(device.last_seen).toLocaleString()}</span>
            </div>
          </div>

          {/* Paired Device IDs Section - for labeled devices */}
          {isLabeled && allDevices.length > 0 && (
            <>
              <div className="modal-divider" />
              <div className="paired-devices-section">
                <h3>Paired Device IDs ({allDevices.length})</h3>
                <div className="paired-devices-list">
                  {allDevices.map(([id, dev]) => (
                    <div key={id} className="paired-device-item">
                      <div className="paired-device-info">
                        <span className="paired-device-id">{id}</span>
                        {dev.info?.bridge_id && (
                          <span className="paired-device-via">via {dev.info.bridge_id}</span>
                        )}
                        {dev.info?.level && (
                          <span className="paired-device-level">{dev.info.level}</span>
                        )}
                      </div>
                      <div className="paired-device-actions">
                        {renderControlButtons(dev)}
                        <Button size="sm" variant="red" onClick={() => onDelete(id)}>×</Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Controls for single unlabeled device */}
          {!isLabeled && renderControlButtons(device) && (
            <>
              <div className="modal-divider" />
              <div className="controls-section">
                <h3>Quick Controls</h3>
                {renderControlButtons(device)}
              </div>
            </>
          )}

          <div className="modal-divider" />

          {/* Label Section */}
          <div className="label-section">
            <h3>{isLabeled ? 'Edit Label' : 'Assign to Device Group'}</h3>
            
            {isLabeled ? (
              <div className="label-input-group">
                <label>Device Group Name</label>
                <input
                  type="text"
                  value={selectedLabel}
                  onChange={e => setSelectedLabel(e.target.value)}
                  placeholder="e.g., Kitchen Lights, Master Bedroom"
                />
              </div>
            ) : (
              <>
                <div className="label-mode-tabs">
                  <button 
                    className={`mode-tab ${mode === 'new' ? 'active' : ''}`}
                    onClick={() => setMode('new')}
                  >
                    Create New
                  </button>
                  <button 
                    className={`mode-tab ${mode === 'existing' ? 'active' : ''}`}
                    onClick={() => setMode('existing')}
                    disabled={existingLabels.length === 0}
                  >
                    Add to Existing ({existingLabels.length})
                  </button>
                </div>

                {mode === 'new' ? (
                  <div className="label-input-group">
                    <label>Device Group Name</label>
                    <input
                      type="text"
                      value={newLabel}
                      onChange={e => setNewLabel(e.target.value)}
                      placeholder="e.g., Kitchen Lights, Master Bedroom"
                      autoFocus
                    />
                  </div>
                ) : (
                  <div className="label-input-group">
                    <label>Select Existing Group</label>
                    <select 
                      value={selectedLabel} 
                      onChange={e => setSelectedLabel(e.target.value)}
                    >
                      {existingLabels.map(label => (
                        <option key={label} value={label}>{label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="modal-divider" />

          {/* Type Section */}
          <div className="type-section">
            <h3>Device Configuration</h3>
            <div className="type-fields">
              <div className="type-field">
                <label>Device Type</label>
                <select value={deviceType} onChange={e => setDeviceType(e.target.value)}>
                  {Object.entries(DEVICE_TYPES).map(([key, val]) => (
                    <option key={key} value={key}>{val.name}</option>
                  ))}
                </select>
              </div>
              <div className="type-field">
                <label>Lutron Model #</label>
                <input
                  type="text"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder="e.g., PJ2-3BRL, DVRF-6L"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          {!isLabeled && (
            <Button variant="red" size="sm" onClick={() => onDelete(device.id)}>Delete Device</Button>
          )}
          <div className="modal-footer-right">
            <Button variant="default" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="green" size="sm" onClick={handleSave} disabled={!canSave}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

