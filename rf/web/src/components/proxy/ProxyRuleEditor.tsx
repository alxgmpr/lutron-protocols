import { useState, useEffect, useCallback } from 'react'
import { FormGroup } from '../common/FormGroup'
import { FormInput } from '../common/FormInput'
import { FormSelect } from '../common/FormSelect'
import { Button } from '../common/Button'
import type { ProxyRule, Device, RfRole } from '../../types'
import './ProxyRuleEditor.css'

interface ProxyRuleEditorProps {
  rule: ProxyRule | null
  devices: Record<string, Device>
  onSave: (rule: Partial<ProxyRule>) => void
  onClose: () => void
}

interface DeviceInference {
  device_id: string
  inferred_type: string
  bridge_id: string | null
  confidence: number
  rf_role: RfRole
  can_be_source: boolean
  can_be_target: boolean
}

interface ValidationResult {
  valid: boolean
  warnings: string[]
  errors: string[]
  inferred_source_type?: string
  inferred_target_type?: string
  inferred_target_bridge_id?: string
}

const BUTTONS = ['ON', 'OFF', 'FAV', 'RAISE', 'LOWER', 'SCENE1', 'SCENE2', 'SCENE3', 'SCENE4']
const DEVICE_TYPES = ['auto', 'pico', 'scene_pico', 'dimmer', 'bridge', 'virtual', 'unknown']
const MODES = [
  { value: 'forward', label: 'Forward Only' },
  { value: 'bidirectional', label: 'Bidirectional Sync' }
]

// RF Role display info
const RF_ROLE_INFO: Record<RfRole, { label: string; color: string; canSource: boolean; canTarget: boolean }> = {
  'one_way_tx': { label: 'TX', color: '#ff9800', canSource: true, canTarget: false },
  'two_way_cca_node': { label: 'CCA', color: '#2196f3', canSource: true, canTarget: true },
  'cca_bridge': { label: 'Bridge', color: '#9c27b0', canSource: true, canTarget: true },
  'silent_load_candidate': { label: 'RX?', color: '#9e9e9e', canSource: false, canTarget: true },
  'unknown': { label: '?', color: '#666', canSource: true, canTarget: true }
}

export function ProxyRuleEditor({ rule, devices, onSave, onClose }: ProxyRuleEditorProps) {
  const [formData, setFormData] = useState({
    name: '',
    source_device_id: '',
    source_type: 'auto',
    target_device_id: '',
    target_type: 'auto',
    target_bridge_id: '',
    mode: 'forward',
    enabled: true,
    debounce_ms: 100,
    button_map: {} as Record<string, string>
  })

  const [sourceInference, setSourceInference] = useState<DeviceInference | null>(null)
  const [targetInference, setTargetInference] = useState<DeviceInference | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [isValidating, setIsValidating] = useState(false)

  // Load existing rule data
  useEffect(() => {
    if (rule && rule.id) {
      setFormData({
        name: rule.name || '',
        source_device_id: rule.source_device_id || '',
        source_type: rule.source_type || 'auto',
        target_device_id: rule.target_device_id || '',
        target_type: rule.target_type || 'auto',
        target_bridge_id: (rule as any).target_bridge_id || '',
        mode: rule.mode || 'forward',
        enabled: rule.enabled !== false,
        debounce_ms: rule.debounce_ms || 100,
        button_map: rule.button_map || {}
      })
    }
  }, [rule])

  // Fetch device inference when source changes
  useEffect(() => {
    if (!formData.source_device_id) {
      setSourceInference(null)
      return
    }
    fetch(`/api/proxy/infer/${formData.source_device_id}`)
      .then(r => r.json())
      .then(data => {
        setSourceInference(data)
        // Auto-set type if on 'auto'
        if (formData.source_type === 'auto' && data.inferred_type) {
          setFormData(d => ({ ...d, source_type: data.inferred_type }))
        }
      })
      .catch(() => setSourceInference(null))
  }, [formData.source_device_id])

  // Fetch device inference when target changes
  useEffect(() => {
    if (!formData.target_device_id) {
      setTargetInference(null)
      return
    }
    fetch(`/api/proxy/infer/${formData.target_device_id}`)
      .then(r => r.json())
      .then(data => {
        setTargetInference(data)
        // Auto-set type and bridge if on 'auto'
        if (formData.target_type === 'auto' && data.inferred_type) {
          setFormData(d => ({
            ...d,
            target_type: data.inferred_type,
            target_bridge_id: data.bridge_id || d.target_bridge_id
          }))
        } else if (data.bridge_id && !formData.target_bridge_id) {
          setFormData(d => ({ ...d, target_bridge_id: data.bridge_id }))
        }
      })
      .catch(() => setTargetInference(null))
  }, [formData.target_device_id])

  // Validate when source/target change
  const validateRule = useCallback(async () => {
    if (!formData.source_device_id || !formData.target_device_id) {
      setValidation(null)
      return
    }

    setIsValidating(true)
    try {
      const response = await fetch('/api/proxy/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_device_id: formData.source_device_id,
          target_device_id: formData.target_device_id,
          source_type: formData.source_type === 'auto' ? null : formData.source_type,
          target_type: formData.target_type === 'auto' ? null : formData.target_type
        })
      })
      const result = await response.json()
      setValidation(result)
    } catch {
      setValidation(null)
    } finally {
      setIsValidating(false)
    }
  }, [formData.source_device_id, formData.target_device_id, formData.source_type, formData.target_type])

  useEffect(() => {
    validateRule()
  }, [validateRule])

  const handleSave = () => {
    if (!formData.name || !formData.source_device_id || !formData.target_device_id) {
      return
    }

    // Use inferred types if still on 'auto'
    const sourceType = formData.source_type === 'auto'
      ? (validation?.inferred_source_type || sourceInference?.inferred_type || 'unknown')
      : formData.source_type
    const targetType = formData.target_type === 'auto'
      ? (validation?.inferred_target_type || targetInference?.inferred_type || 'unknown')
      : formData.target_type

    const data: Partial<ProxyRule> & { target_bridge_id?: string } = {
      name: formData.name,
      source_device_id: formData.source_device_id,
      source_type: sourceType,
      target_device_id: formData.target_device_id,
      target_type: targetType,
      mode: formData.mode,
      enabled: formData.enabled,
      debounce_ms: formData.debounce_ms
    }

    // Include bridge_id if available
    const bridgeId = formData.target_bridge_id || validation?.inferred_target_bridge_id || targetInference?.bridge_id
    if (bridgeId) {
      data.target_bridge_id = bridgeId
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

  // Build device options with RF role badges
  const getDeviceOptions = (forTarget: boolean) => {
    return Object.entries(devices).map(([id, device]) => {
      const rfRole = device.rf_role || 'unknown'
      const roleInfo = RF_ROLE_INFO[rfRole]
      const canUse = forTarget ? roleInfo.canTarget : roleInfo.canSource
      const label = device.label ? `${device.label} (${id})` : id

      return {
        value: id,
        label: label,
        rfRole,
        roleInfo,
        canUse,
        disabled: !canUse
      }
    }).sort((a, b) => {
      // Sort usable devices first
      if (a.canUse !== b.canUse) return a.canUse ? -1 : 1
      return a.label.localeCompare(b.label)
    })
  }

  const sourceOptions = getDeviceOptions(false)
  const targetOptions = getDeviceOptions(true)

  const handleButtonMapChange = (sourceButton: string, targetButton: string) => {
    setFormData(d => ({
      ...d,
      button_map: { ...d.button_map, [sourceButton]: targetButton }
    }))
  }

  const showButtonMapping = formData.source_type.includes('pico') ||
    sourceInference?.inferred_type?.includes('pico')

  const hasErrors = validation && !validation.valid
  const hasWarnings = validation && validation.warnings.length > 0

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
            <div className="form-section-title">Source Device (transmitter)</div>
            <div className="form-row">
              <FormGroup label="Device ID">
                <select
                  className="form-select rf-role-select"
                  value={formData.source_device_id}
                  onChange={(e) => setFormData(d => ({ ...d, source_device_id: e.target.value, source_type: 'auto' }))}
                >
                  <option value="">Select device...</option>
                  {sourceOptions.map(opt => (
                    <option
                      key={opt.value}
                      value={opt.value}
                      disabled={opt.disabled}
                      className={opt.disabled ? 'option-disabled' : ''}
                    >
                      {opt.label} [{opt.roleInfo.label}]
                    </option>
                  ))}
                </select>
              </FormGroup>
              <FormGroup label="Type">
                <FormSelect
                  value={formData.source_type}
                  onChange={(value) => setFormData(d => ({ ...d, source_type: value }))}
                >
                  {DEVICE_TYPES.map(t => (
                    <option key={t} value={t}>
                      {t === 'auto' ? `Auto${sourceInference ? ` (${sourceInference.inferred_type})` : ''}` : t}
                    </option>
                  ))}
                </FormSelect>
              </FormGroup>
            </div>
            {sourceInference && (
              <div className="device-inference-hint">
                <span
                  className="rf-role-badge"
                  style={{ backgroundColor: RF_ROLE_INFO[sourceInference.rf_role].color }}
                >
                  {RF_ROLE_INFO[sourceInference.rf_role].label}
                </span>
                <span className="inference-confidence">
                  {Math.round(sourceInference.confidence * 100)}% confidence
                </span>
                {!sourceInference.can_be_source && (
                  <span className="inference-error">Cannot be source (one-way receiver)</span>
                )}
              </div>
            )}
          </div>

          <div className="form-section">
            <div className="form-section-title">Target Device (receiver)</div>
            <div className="form-row">
              <FormGroup label="Device ID">
                <select
                  className="form-select rf-role-select"
                  value={formData.target_device_id}
                  onChange={(e) => setFormData(d => ({ ...d, target_device_id: e.target.value, target_type: 'auto' }))}
                >
                  <option value="">Select device...</option>
                  {targetOptions.map(opt => (
                    <option
                      key={opt.value}
                      value={opt.value}
                      disabled={opt.disabled}
                      className={opt.disabled ? 'option-disabled' : ''}
                    >
                      {opt.label} [{opt.roleInfo.label}]
                    </option>
                  ))}
                </select>
              </FormGroup>
              <FormGroup label="Type">
                <FormSelect
                  value={formData.target_type}
                  onChange={(value) => setFormData(d => ({ ...d, target_type: value }))}
                >
                  {DEVICE_TYPES.map(t => (
                    <option key={t} value={t}>
                      {t === 'auto' ? `Auto${targetInference ? ` (${targetInference.inferred_type})` : ''}` : t}
                    </option>
                  ))}
                </FormSelect>
              </FormGroup>
            </div>
            {targetInference && (
              <div className="device-inference-hint">
                <span
                  className="rf-role-badge"
                  style={{ backgroundColor: RF_ROLE_INFO[targetInference.rf_role].color }}
                >
                  {RF_ROLE_INFO[targetInference.rf_role].label}
                </span>
                <span className="inference-confidence">
                  {Math.round(targetInference.confidence * 100)}% confidence
                </span>
                {targetInference.bridge_id && (
                  <span className="inference-bridge">Bridge: {targetInference.bridge_id}</span>
                )}
                {!targetInference.can_be_target && (
                  <span className="inference-error">Cannot be target (one-way transmitter)</span>
                )}
              </div>
            )}
          </div>

          {/* Validation Messages */}
          {validation && (hasErrors || hasWarnings) && (
            <div className="validation-messages">
              {validation.errors.map((err, i) => (
                <div key={`e${i}`} className="validation-error">{err}</div>
              ))}
              {validation.warnings.map((warn, i) => (
                <div key={`w${i}`} className="validation-warning">{warn}</div>
              ))}
            </div>
          )}

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

          {showButtonMapping && (
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
            disabled={!formData.name || !formData.source_device_id || !formData.target_device_id || hasErrors || isValidating}
          >
            {isValidating ? 'Validating...' : (rule?.id ? 'Save Changes' : 'Create Rule')}
          </Button>
        </div>
      </div>
    </div>
  )
}
