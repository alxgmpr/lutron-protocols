import { useState, useEffect } from 'react'
import { useApi } from '../../hooks/useApi'
import { FormGroup } from '../common/FormGroup'
import { FormInput } from '../common/FormInput'
import { Button } from '../common/Button'
import type { MqttConfig } from '../../types'

interface MqttSettingsProps {
  config: MqttConfig | null
  status: { connected: boolean; published_count: number }
  onSave: (config: Partial<MqttConfig>) => void
  onPublishDiscovery: () => void
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function MqttSettings({ config, status, onSave, onPublishDiscovery, showStatus }: MqttSettingsProps) {
  const { postJson } = useApi()
  const [formData, setFormData] = useState({
    enabled: false,
    broker_host: 'homeassistant.local',
    broker_port: 1883,
    username: '',
    password: '',
    discovery_prefix: 'homeassistant'
  })
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (config) {
      setFormData({
        enabled: !!config.enabled,
        broker_host: config.broker_host || 'homeassistant.local',
        broker_port: config.broker_port || 1883,
        username: config.username || '',
        password: '', // Don't populate masked password
        discovery_prefix: config.discovery_prefix || 'homeassistant'
      })
    }
  }, [config])

  const handleTestConnection = async () => {
    setTesting(true)
    try {
      const result = await postJson('/api/mqtt/test', {
        host: formData.broker_host,
        port: formData.broker_port,
        username: formData.username || undefined,
        password: formData.password || undefined
      }) as unknown as { connected: boolean }
      if (result.connected) {
        showStatus('Connection successful', 'success')
      } else {
        showStatus('Connection failed', 'error')
      }
    } catch {
      showStatus('Connection test error', 'error')
    } finally {
      setTesting(false)
    }
  }

  const handleSave = () => {
    const saveData: Partial<MqttConfig> = {
      enabled: formData.enabled ? 1 : 0,
      broker_host: formData.broker_host,
      broker_port: formData.broker_port,
      username: formData.username || undefined,
      discovery_prefix: formData.discovery_prefix
    }
    // Only include password if it was changed
    if (formData.password && formData.password !== '********') {
      saveData.password = formData.password
    }
    onSave(saveData)
  }

  return (
    <div className="mqtt-settings">
      <div className="mqtt-status">
        <span className={`mqtt-status-indicator ${status.connected ? 'connected' : 'disconnected'}`} />
        <span>{status.connected ? 'Connected' : 'Disconnected'}</span>
        {status.connected && (
          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {status.published_count} messages published
          </span>
        )}
      </div>

      <div className="mqtt-form-row">
        <FormGroup label="Broker Host">
          <FormInput
            value={formData.broker_host}
            onChange={(value) => setFormData(d => ({ ...d, broker_host: value }))}
            placeholder="homeassistant.local"
          />
        </FormGroup>
        <FormGroup label="Port">
          <FormInput
            type="number"
            value={String(formData.broker_port)}
            onChange={(value) => setFormData(d => ({ ...d, broker_port: parseInt(value) || 1883 }))}
          />
        </FormGroup>
      </div>

      <div className="mqtt-form-row">
        <FormGroup label="Username">
          <FormInput
            value={formData.username}
            onChange={(value) => setFormData(d => ({ ...d, username: value }))}
            placeholder="optional"
          />
        </FormGroup>
        <FormGroup label="Password">
          <input
            type="password"
            className="form-input"
            value={formData.password}
            onChange={(e) => setFormData(d => ({ ...d, password: e.target.value }))}
            placeholder={config?.password ? '********' : 'optional'}
          />
        </FormGroup>
      </div>

      <div className="mqtt-form-row single">
        <FormGroup label="Discovery Prefix">
          <FormInput
            value={formData.discovery_prefix}
            onChange={(value) => setFormData(d => ({ ...d, discovery_prefix: value }))}
            placeholder="homeassistant"
          />
        </FormGroup>
      </div>

      <div className="mqtt-form-row single">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={formData.enabled}
            onChange={(e) => setFormData(d => ({ ...d, enabled: e.target.checked }))}
          />
          Enable MQTT Integration
        </label>
      </div>

      <div className="mqtt-actions">
        <Button onClick={handleTestConnection} disabled={testing}>
          {testing ? 'Testing...' : 'Test Connection'}
        </Button>
        <Button variant="primary" onClick={handleSave}>
          Save Settings
        </Button>
        <Button
          onClick={onPublishDiscovery}
          disabled={!status.connected}
          title={!status.connected ? 'Connect to MQTT first' : 'Publish Home Assistant discovery for all devices'}
        >
          Publish Discovery
        </Button>
      </div>
    </div>
  )
}
