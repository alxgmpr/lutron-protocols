import { useState, useEffect } from 'react'
import { Card } from '../common/Card'
import { Button } from '../common/Button'
import { AutocompleteInput } from '../common/AutocompleteInput'
import type { RelayRule, Device } from '../../types'

interface RelayRuleEditorProps {
  rule: RelayRule | null
  devices: Record<string, Device>
  onSave: (rule: Partial<RelayRule>) => void
  onClose: () => void
}

export function RelayRuleEditor({ rule, devices, onSave, onClose }: RelayRuleEditorProps) {
  const [name, setName] = useState('')
  const [sourceDeviceId, setSourceDeviceId] = useState('')
  const [targetDeviceId, setTargetDeviceId] = useState('')
  const [targetBridgeId, setTargetBridgeId] = useState('')
  const [bidirectional, setBidirectional] = useState(true)
  const [relayButtons, setRelayButtons] = useState(true)
  const [relayLevel, setRelayLevel] = useState(true)

  useEffect(() => {
    if (rule && rule.id) {
      setName(rule.name || '')
      setSourceDeviceId(rule.source_device_id || '')
      setTargetDeviceId(rule.target_device_id || '')
      setTargetBridgeId(rule.target_bridge_id || '')
      setBidirectional(!!rule.bidirectional)
      setRelayButtons(rule.relay_buttons !== false && rule.relay_buttons !== 0)
      setRelayLevel(rule.relay_level !== false && rule.relay_level !== 0)
    }
  }, [rule])

  const handleSubmit = () => {
    if (!sourceDeviceId || !targetDeviceId) {
      alert('Source and Target device IDs are required')
      return
    }

    const ruleData: Partial<RelayRule> = {
      name: name || `${sourceDeviceId} -> ${targetDeviceId}`,
      source_device_id: sourceDeviceId.toUpperCase(),
      target_device_id: targetDeviceId.toUpperCase(),
      target_bridge_id: targetBridgeId ? targetBridgeId.toUpperCase() : undefined,
      bidirectional,
      relay_buttons: relayButtons,
      relay_level: relayLevel
    }

    onSave(ruleData)
  }

  // Get device suggestions for autocomplete (just device IDs as strings)
  const deviceSuggestions = Object.keys(devices)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <Card
          title={rule && rule.id ? 'Edit Relay Rule' : 'Create Relay Rule'}
          variant="pico"
        >
          <div style={{
            background: 'var(--bg-tertiary)',
            padding: '0.75rem',
            borderRadius: '4px',
            marginBottom: '1rem',
            fontSize: '0.85rem',
            lineHeight: '1.4'
          }}>
            <strong>Example:</strong> Bridge sends SET_LEVEL to <code>CC110001</code> (virtual device).
            You want it to control real dimmer <code>058C8E37</code>.
            <br/><br/>
            <strong>Source:</strong> <code>CC110001</code> (what bridge targets)<br/>
            <strong>Target:</strong> <code>058C8E37</code> (real dimmer to control)<br/>
            <strong>Bidirectional:</strong> ON (so dimmer ACKs get relayed back)
          </div>

          <div className="form-group">
            <label>Rule Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Virtual CC110001 -> Real Dimmer"
            />
          </div>

          <div className="form-group">
            <label>Source Device ID (Virtual/Proxy) *</label>
            <AutocompleteInput
              value={sourceDeviceId}
              onChange={setSourceDeviceId}
              suggestions={deviceSuggestions}
              placeholder="e.g., CC110001"
            />
            <small style={{ color: 'var(--text-muted)' }}>
              The device ID the bridge sends commands TO (your virtual/proxy device)
            </small>
          </div>

          <div className="form-group">
            <label>Target Device ID (Real Dimmer) *</label>
            <AutocompleteInput
              value={targetDeviceId}
              onChange={setTargetDeviceId}
              suggestions={deviceSuggestions}
              placeholder="e.g., 058C8E37"
            />
            <small style={{ color: 'var(--text-muted)' }}>
              The REAL dimmer's device ID (from its label or RX packets)
            </small>
          </div>

          <div className="form-group">
            <label>Bridge Zone ID (optional, for SET_LEVEL)</label>
            <AutocompleteInput
              value={targetBridgeId}
              onChange={setTargetBridgeId}
              suggestions={deviceSuggestions}
              placeholder="e.g., 002C90AF"
            />
            <small style={{ color: 'var(--text-muted)' }}>
              Your bridge's zone ID - keeps this as the "source" in relayed SET_LEVEL packets
            </small>
          </div>

          <div className="form-group" style={{ flexDirection: 'row', gap: '1rem', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={bidirectional}
                onChange={e => setBidirectional(e.target.checked)}
              />
              Bidirectional (relay dimmer responses back)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={relayButtons}
                onChange={e => setRelayButtons(e.target.checked)}
              />
              Relay Buttons
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={relayLevel}
                onChange={e => setRelayLevel(e.target.checked)}
              />
              Relay Level
            </label>
          </div>

          <div className="form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="green" onClick={handleSubmit}>
              {rule && rule.id ? 'Update' : 'Create'}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  )
}
