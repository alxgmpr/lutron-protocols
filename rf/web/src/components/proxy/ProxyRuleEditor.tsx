import { useState, useEffect } from 'react'
import { FormGroup } from '../common/FormGroup'
import { FormInput } from '../common/FormInput'
import { FormSelect } from '../common/FormSelect'
import { Button } from '../common/Button'
import type { ProxyRule, Device } from '../../types'

interface ProxyRuleEditorProps {
  rule: ProxyRule | null
  devices: Record<string, Device>
  onSave: (rule: Partial<ProxyRule>) => void
  onClose: () => void
}

const BUTTONS = ['ON', 'OFF', 'FAV', 'RAISE', 'LOWER', 'SCENE1', 'SCENE2', 'SCENE3', 'SCENE4']
const DEVICE_TYPES = ['pico', 'dimmer', 'virtual', 'bridge_controlled', 'scene_pico']
const MODES = [
  { value: 'forward', label: 'Forward Only' },
  { value: 'bidirectional', label: 'Bidirectional Sync' }
]

export function ProxyRuleEditor({ rule, devices, onSave, onClose }: ProxyRuleEditorProps) {
  const [formData, setFormData] = useState({
    name: '',
    source_device_id: '',
    source_type: 'pico',
    target_device_id: '',
    target_type: 'dimmer',
    mode: 'forward',
    enabled: true,
    debounce_ms: 100,
    button_map: {} as Record<string, string>
  })

  useEffect(() => {
    if (rule && rule.id) {
      setFormData({
        name: rule.name || '',
        source_device_id: rule.source_device_id || '',
        source_type: rule.source_type || 'pico',
        target_device_id: rule.target_device_id || '',
        target_type: rule.target_type || 'dimmer',
        mode: rule.mode || 'forward',
        enabled: rule.enabled !== false,
        debounce_ms: rule.debounce_ms || 100,
        button_map: rule.button_map || {}
      })
    }
  }, [rule])

  const handleSave = () => {
    if (!formData.name || !formData.source_device_id || !formData.target_device_id) {
      return
    }

    const data: Partial<ProxyRule> = {
      name: formData.name,
      source_device_id: formData.source_device_id,
      source_type: formData.source_type,
      target_device_id: formData.target_device_id,
      target_type: formData.target_type,
      mode: formData.mode,
      enabled: formData.enabled,
      debounce_ms: formData.debounce_ms
    }

    // Only include button_map if it has entries
    const buttonMap = Object.fromEntries(
      Object.entries(formData.button_map).filter(([, v]) => v && v !== '')
    )
    if (Object.keys(buttonMap).length > 0) {
      data.button_map = buttonMap
    }

    onSave(data)
  }

  const deviceOptions = Object.entries(devices).map(([id, device]) => ({
    value: id,
    label: device.label ? `${device.label} (${id})` : id
  }))

  const handleButtonMapChange = (sourceButton: string, targetButton: string) => {
    setFormData(d => ({
      ...d,
      button_map: { ...d.button_map, [sourceButton]: targetButton }
    }))
  }

  return (
    <div className="proxy-rule-editor-overlay" onClick={onClose}>
      <div className="proxy-rule-editor" onClick={(e) => e.stopPropagation()}>
        <div className="proxy-rule-editor-header">
          <h3>{rule?.id ? 'Edit Proxy Rule' : 'Create Proxy Rule'}</h3>
          <Button size="sm" onClick={onClose}>X</Button>
        </div>

        <div className="proxy-rule-editor-body">
          <div className="form-section">
            <FormGroup label="Rule Name">
              <FormInput
                value={formData.name}
                onChange={(value) => setFormData(d => ({ ...d, name: value }))}
                placeholder="e.g., Kitchen Pico to Living Room Dimmer"
              />
            </FormGroup>
          </div>

          <div className="form-section">
            <div className="form-section-title">Source Device</div>
            <div className="form-row">
              <FormGroup label="Device ID">
                <FormSelect
                  value={formData.source_device_id}
                  onChange={(value) => setFormData(d => ({ ...d, source_device_id: value }))}
                >
                  <option value="">Select device...</option>
                  {deviceOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </FormSelect>
              </FormGroup>
              <FormGroup label="Type">
                <FormSelect
                  value={formData.source_type}
                  onChange={(value) => setFormData(d => ({ ...d, source_type: value }))}
                >
                  {DEVICE_TYPES.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </FormSelect>
              </FormGroup>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Target Device</div>
            <div className="form-row">
              <FormGroup label="Device ID">
                <FormSelect
                  value={formData.target_device_id}
                  onChange={(value) => setFormData(d => ({ ...d, target_device_id: value }))}
                >
                  <option value="">Select device...</option>
                  {deviceOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </FormSelect>
              </FormGroup>
              <FormGroup label="Type">
                <FormSelect
                  value={formData.target_type}
                  onChange={(value) => setFormData(d => ({ ...d, target_type: value }))}
                >
                  {DEVICE_TYPES.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </FormSelect>
              </FormGroup>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Settings</div>
            <div className="form-row">
              <FormGroup label="Mode">
                <FormSelect
                  value={formData.mode}
                  onChange={(value) => setFormData(d => ({ ...d, mode: value }))}
                >
                  {MODES.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </FormSelect>
              </FormGroup>
              <FormGroup label="Debounce (ms)">
                <FormInput
                  type="number"
                  value={String(formData.debounce_ms)}
                  onChange={(value) => setFormData(d => ({ ...d, debounce_ms: parseInt(value) || 100 }))}
                />
              </FormGroup>
            </div>
          </div>

          {formData.source_type.includes('pico') && (
            <div className="form-section">
              <div className="form-section-title">Button Remapping (optional)</div>
              <div className="button-map-editor">
                {BUTTONS.map(button => (
                  <div key={button} className="button-map-row">
                    <span className="button-map-label">{button}</span>
                    <span className="button-map-arrow">-{'>'}</span>
                    <select
                      className="button-map-select"
                      value={formData.button_map[button] || ''}
                      onChange={(e) => handleButtonMapChange(button, e.target.value)}
                    >
                      <option value="">Same ({button})</option>
                      <option value="_ignore">Ignore</option>
                      {BUTTONS.filter(b => b !== button).map(b => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="form-section">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={formData.enabled}
                onChange={(e) => setFormData(d => ({ ...d, enabled: e.target.checked }))}
              />
              Enable this rule
            </label>
          </div>
        </div>

        <div className="proxy-rule-editor-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!formData.name || !formData.source_device_id || !formData.target_device_id}
          >
            {rule?.id ? 'Save Changes' : 'Create Rule'}
          </Button>
        </div>
      </div>
    </div>
  )
}
