import { useState, useEffect, useCallback } from 'react'
import { useApi } from '../../hooks/useApi'
import { Card } from '../common/Card'
import { MqttSettings } from './MqttSettings'
import type { MqttConfig as MqttConfigType, Device } from '../../types'
import './ProxyConfig.css'

interface MqttConfigProps {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
  devices: Record<string, Device>
}

export function MqttConfig({ showStatus, devices }: MqttConfigProps) {
  const { get, postJson } = useApi()

  const [mqttConfig, setMqttConfig] = useState<MqttConfigType | null>(null)
  const [mqttStatus, setMqttStatus] = useState<{ connected: boolean; published_count: number }>({
    connected: false,
    published_count: 0
  })

  const loadMqttConfig = useCallback(async () => {
    try {
      const config = await get<MqttConfigType>('/api/mqtt/config')
      setMqttConfig(config)
    } catch (e) {
      console.error('Failed to load MQTT config:', e)
    }
  }, [get])

  const loadMqttStatus = useCallback(async () => {
    try {
      const status = await get<{ connected: boolean; published_count: number }>('/api/mqtt/status')
      setMqttStatus(status)
    } catch (e) {
      console.error('Failed to load MQTT status:', e)
    }
  }, [get])

  useEffect(() => {
    loadMqttConfig()
    loadMqttStatus()

    // Poll MQTT status every 5 seconds
    const interval = setInterval(loadMqttStatus, 5000)
    return () => clearInterval(interval)
  }, [loadMqttConfig, loadMqttStatus])

  const handleSaveMqttConfig = async (config: Partial<MqttConfigType>) => {
    try {
      await postJson('/api/mqtt/config', config)
      showStatus('MQTT settings saved', 'success')
      loadMqttConfig()
      loadMqttStatus()
    } catch (e) {
      showStatus('Failed to save MQTT settings', 'error')
    }
  }

  const handlePublishDiscovery = async () => {
    try {
      const result = await postJson('/api/mqtt/publish-discovery', {}) as { status: string; published?: number }
      if (result.status === 'ok') {
        showStatus(`Published discovery for ${result.published} devices`, 'success')
      } else {
        showStatus('Failed to publish discovery', 'error')
      }
    } catch (e) {
      showStatus('MQTT not connected', 'error')
    }
  }

  const deviceCount = Object.keys(devices).length

  return (
    <div className="proxy-config">
      <Card title="MQTT Integration" variant="bridge">
        <p className="help-text" style={{ marginBottom: '1rem' }}>
          Connect to Home Assistant via MQTT to report device states and events.
          Devices will be auto-discovered in Home Assistant.
        </p>
        <MqttSettings
          config={mqttConfig}
          status={mqttStatus}
          onSave={handleSaveMqttConfig}
          onPublishDiscovery={handlePublishDiscovery}
          showStatus={showStatus}
        />
      </Card>

      <Card title="Device Status" variant="device">
        <div style={{ padding: '0.5rem 0' }}>
          <p><strong>{deviceCount}</strong> devices discovered</p>
          {mqttStatus.connected && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '0.5rem' }}>
              Device states will be published to MQTT when they change.
              Button presses from Picos will trigger Home Assistant automations.
            </p>
          )}
        </div>
      </Card>

      <Card title="Topic Structure" variant="pico">
        <div className="mqtt-topics">
          <div className="mqtt-topic-item">
            <code>homeassistant/light/cca_{'<device_id>'}/config</code>
            <span className="mqtt-topic-desc">Auto-discovery for dimmers</span>
          </div>
          <div className="mqtt-topic-item">
            <code>cca/device/{'<device_id>'}/state</code>
            <span className="mqtt-topic-desc">ON/OFF state</span>
          </div>
          <div className="mqtt-topic-item">
            <code>cca/device/{'<device_id>'}/brightness</code>
            <span className="mqtt-topic-desc">Level 0-100</span>
          </div>
          <div className="mqtt-topic-item">
            <code>cca/device/{'<device_id>'}/button</code>
            <span className="mqtt-topic-desc">Pico button events</span>
          </div>
        </div>
      </Card>
    </div>
  )
}
