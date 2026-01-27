import { useState, useEffect } from 'react'
import { Button } from '../common'
import './ConnectionModal.css'

interface EspConfig {
  host: string
  port: number
  default_host: string
  last_seen: string | null
  last_log_age: number | null
  thread_alive: boolean
  receiving_logs: boolean
  healthy: boolean
}

interface ConnectionModalProps {
  onClose: () => void
}

export function ConnectionModal({ onClose }: ConnectionModalProps) {
  const [config, setConfig] = useState<EspConfig | null>(null)
  const [newHost, setNewHost] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchConfig()
    const interval = setInterval(fetchConfig, 5000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/esp/config')
      const data = await response.json()
      setConfig(data)
      if (!newHost) {
        setNewHost(data.host)
      }
    } catch (e) {
      console.error('Failed to fetch ESP config:', e)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const response = await fetch('/api/esp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: newHost })
      })
      const data = await response.json()
      setTestResult({
        success: data.connected,
        message: data.connected ? 'Connection successful' : (data.error || 'Connection failed')
      })
    } catch (e) {
      setTestResult({ success: false, message: 'Test failed: ' + String(e) })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!newHost.trim()) return
    setSaving(true)
    try {
      await fetch('/api/esp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: newHost.trim() })
      })
      await fetchConfig()
      setTestResult({ success: true, message: 'Host updated' })
    } catch (e) {
      setTestResult({ success: false, message: 'Failed to save: ' + String(e) })
    } finally {
      setSaving(false)
    }
  }

  const handleReconnect = async () => {
    setReconnecting(true)
    setTestResult({ success: true, message: 'Reconnecting...' })
    try {
      await fetch('/api/esp/reconnect', { method: 'POST' })
      // Give it a moment then refresh config and update status
      setTimeout(async () => {
        await fetchConfig()
        setTestResult({ success: true, message: 'Reconnected' })
        setReconnecting(false)
      }, 2000)
    } catch (e) {
      setTestResult({ success: false, message: 'Reconnect failed: ' + String(e) })
      setReconnecting(false)
    }
  }

  const formatLastSeen = (lastSeen: string | null) => {
    if (!lastSeen) return 'Never'
    const date = new Date(lastSeen)
    return date.toLocaleTimeString()
  }

  const formatAge = (age: number | null) => {
    if (age === null || age < 0) return 'N/A'
    if (age < 60) return `${Math.round(age)}s ago`
    if (age < 3600) return `${Math.round(age / 60)}m ago`
    return `${Math.round(age / 3600)}h ago`
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content connection-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>ESP32 Connection</h2>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="modal-body">
          {/* Status Section */}
          <div className="connection-status-section">
            <h3>Connection Status</h3>
            <div className="connection-status-grid">
              <div className="status-item">
                <span className="status-label">Host</span>
                <span className="status-value mono">{config?.host || '...'}</span>
              </div>
              <div className="status-item">
                <span className="status-label">Port</span>
                <span className="status-value mono">{config?.port || '...'}</span>
              </div>
              <div className="status-item">
                <span className="status-label">Last Seen</span>
                <span className="status-value">{config ? formatLastSeen(config.last_seen) : '...'}</span>
              </div>
              <div className="status-item">
                <span className="status-label">Log Age</span>
                <span className="status-value">{config ? formatAge(config.last_log_age) : '...'}</span>
              </div>
              <div className="status-item">
                <span className="status-label">Log Thread</span>
                <span className={`status-value status-${config?.thread_alive ? 'ok' : 'error'}`}>
                  {config?.thread_alive ? 'Running' : 'Stopped'}
                </span>
              </div>
              <div className="status-item">
                <span className="status-label">Receiving</span>
                <span className={`status-value status-${config?.receiving_logs ? 'ok' : 'warn'}`}>
                  {config?.receiving_logs ? 'Yes' : 'No'}
                </span>
              </div>
            </div>
          </div>

          <div className="modal-divider" />

          {/* Change Host Section */}
          <div className="connection-host-section">
            <h3>Change ESP32 Host</h3>
            <div className="host-input-row">
              <input
                type="text"
                value={newHost}
                onChange={e => setNewHost(e.target.value)}
                placeholder="IP address or hostname"
                className="host-input"
              />
              <Button size="sm" onClick={handleTest} disabled={testing || !newHost.trim()}>
                {testing ? 'Testing...' : 'Test'}
              </Button>
            </div>
            {config?.default_host && config.default_host !== newHost && (
              <button
                className="reset-default-btn"
                onClick={() => setNewHost(config.default_host)}
              >
                Reset to default ({config.default_host})
              </button>
            )}
            {testResult && (
              <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
                {testResult.message}
              </div>
            )}
          </div>

          <div className="modal-divider" />

          {/* Actions Section */}
          <div className="connection-actions-section">
            <h3>Actions</h3>
            <div className="action-buttons">
              <Button
                variant="purple"
                size="sm"
                onClick={handleReconnect}
                disabled={reconnecting}
              >
                {reconnecting ? 'Reconnecting...' : 'Reconnect Logs'}
              </Button>
              <p className="action-hint">Force restart the log subscription to ESP32</p>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <Button variant="default" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="green"
            size="sm"
            onClick={handleSave}
            disabled={saving || !newHost.trim() || newHost === config?.host}
          >
            {saving ? 'Saving...' : 'Save & Reconnect'}
          </Button>
        </div>
      </div>
    </div>
  )
}
