import { useState, useEffect, useCallback } from 'react'
import { Modal, Button } from '../common'
import './ConfigModal.css'

interface Config {
  host: string
  port: number
  default_host: string
  last_packet_age: number | null
  packets_received: number
  clients_connected: number
  receiving_packets: boolean
  healthy: boolean
}

interface ConfigModalProps {
  onClose: () => void
}

export function ConfigModal({ onClose }: ConfigModalProps) {
  const [config, setConfig] = useState<Config | null>(null)
  const [newHost, setNewHost] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ success: boolean; text: string } | null>(null)

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/esp/config')
      const data = await response.json()
      setConfig(data)
      if (!newHost) {
        setNewHost(data.host)
      }
    } catch (e) {
      console.error('Failed to fetch config:', e)
    }
  }, [newHost])

  useEffect(() => {
    fetchConfig()
    const interval = setInterval(fetchConfig, 2000)
    return () => clearInterval(interval)
  }, [fetchConfig])

  const handleSave = async () => {
    if (!newHost.trim()) return
    setSaving(true)
    setMessage(null)
    try {
      await fetch('/api/esp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: newHost.trim() })
      })
      await fetchConfig()
      setMessage({ success: true, text: 'Host updated' })
    } catch (e) {
      setMessage({ success: false, text: 'Failed to save: ' + String(e) })
    } finally {
      setSaving(false)
    }
  }

  const formatAge = (age: number | null) => {
    if (age === null) return 'Never'
    if (age < 1) return 'Just now'
    if (age < 60) return `${Math.round(age)}s ago`
    if (age < 3600) return `${Math.round(age / 60)}m ago`
    return `${Math.round(age / 3600)}h ago`
  }

  const getHealthStatus = () => {
    if (!config) return { status: 'unknown', label: 'Loading...' }
    if (config.healthy) return { status: 'healthy', label: 'Connected' }
    if (config.packets_received > 0 && !config.receiving_packets) return { status: 'warning', label: 'No Recent Packets' }
    if (config.clients_connected === 0) return { status: 'warning', label: 'No Clients' }
    return { status: 'error', label: 'Disconnected' }
  }

  const health = getHealthStatus()

  return (
    <Modal title="ESP32 Configuration" onClose={onClose}>
      {/* Health Status */}
      <div className="config-section">
        <div className="config-health">
          <div className={`health-indicator health-${health.status}`} />
          <div className="health-info">
            <span className="health-label">{health.label}</span>
            <span className="health-detail">
              {config?.host || '...'}:{config?.port || '...'}
            </span>
          </div>
        </div>
      </div>

      {/* Status Grid */}
      <div className="config-section">
        <h3>Status</h3>
        <div className="status-grid">
          <div className="status-item">
            <span className="status-label">Packets RX</span>
            <span className="status-value">
              {config?.packets_received?.toLocaleString() ?? '...'}
            </span>
          </div>
          <div className="status-item">
            <span className="status-label">Last Packet</span>
            <span className={`status-value ${config?.receiving_packets ? 'status-ok' : 'status-warn'}`}>
              {config ? formatAge(config.last_packet_age) : '...'}
            </span>
          </div>
          <div className="status-item">
            <span className="status-label">SSE Clients</span>
            <span className={`status-value ${(config?.clients_connected ?? 0) > 0 ? 'status-ok' : 'status-warn'}`}>
              {config?.clients_connected ?? '...'}
            </span>
          </div>
          <div className="status-item">
            <span className="status-label">Receiving</span>
            <span className={`status-value ${config?.receiving_packets ? 'status-ok' : 'status-error'}`}>
              {config?.receiving_packets ? 'Yes' : 'No'}
            </span>
          </div>
        </div>
      </div>

      {/* Change Host */}
      <div className="config-section">
        <h3>ESP32 Host</h3>
        <p className="config-hint">
          The hostname is for display only. UDP packets are received on port 9433 from any source.
        </p>
        <div className="host-row">
          <input
            type="text"
            value={newHost}
            onChange={e => setNewHost(e.target.value)}
            placeholder="IP address or hostname"
            className="host-input"
          />
          <Button
            size="sm"
            variant="green"
            onClick={handleSave}
            disabled={saving || !newHost.trim() || newHost === config?.host}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
        {config?.default_host && config.default_host !== newHost && (
          <button
            className="reset-link"
            onClick={() => setNewHost(config.default_host)}
          >
            Reset to default ({config.default_host})
          </button>
        )}
        {message && (
          <div className={`test-result ${message.success ? 'success' : 'error'}`}>
            {message.text}
          </div>
        )}
      </div>
    </Modal>
  )
}
