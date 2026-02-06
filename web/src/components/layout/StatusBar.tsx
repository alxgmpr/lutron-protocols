import { useState, useEffect, useCallback } from 'react'
import './StatusBar.css'

interface EspConfig {
  host: string | null
  port: number
  last_packet_age: number | null
  packets_received: number
  receiving_packets: boolean
  healthy: boolean
}

interface StatusBarProps {
  connected: boolean
  lastTx: { message: string; type: 'success' | 'error' | '' }
}

function formatAge(age: number | null): string {
  if (age === null) return 'never'
  if (age < 1) return 'just now'
  if (age < 60) return `${Math.round(age)}s ago`
  if (age < 3600) return `${Math.round(age / 60)}m ago`
  return `${Math.round(age / 3600)}h ago`
}

export function StatusBar({ connected, lastTx }: StatusBarProps) {
  const [config, setConfig] = useState<EspConfig | null>(null)

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/esp/config')
      if (res.ok) setConfig(await res.json())
    } catch {
      // backend may not be running
    }
  }, [])

  useEffect(() => {
    fetchConfig()
    const interval = setInterval(fetchConfig, 5000)
    return () => clearInterval(interval)
  }, [fetchConfig])

  const isOnline = connected && config?.healthy

  return (
    <div className="unified-status-bar">
      <div className="status-section">
        <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
        <span className="status-host">
          {config?.host || 'no device'}
        </span>
      </div>

      <span className="status-divider" />

      <div className="status-section">
        <span className="status-label">UDP</span>
        <span className="status-value">:{config?.port ?? 9433}</span>
      </div>

      <span className="status-divider" />

      <div className="status-section">
        <span className="status-label">Last RX</span>
        <span className={`status-value ${config?.receiving_packets ? '' : 'status-stale'}`}>
          {config ? formatAge(config.last_packet_age) : '—'}
        </span>
      </div>

      <span className="status-divider" />

      <div className={`status-section status-tx ${lastTx.type}`}>
        <span className="status-label">Last TX</span>
        <span className="status-value">{lastTx.message}</span>
      </div>
    </div>
  )
}
