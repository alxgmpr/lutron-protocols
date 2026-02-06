import { useState, useEffect, useCallback } from 'react'
import './StatusBar.css'

interface EspConfig {
  host: string | null
  port: number
  last_packet_age: number | null
  last_heartbeat_age: number | null
  packets_received: number
  receiving_packets: boolean
  healthy: boolean
}

interface StatusBarProps {
  connected: boolean
  lastTx: { message: string; type: 'success' | 'error' | '' }
  lastHeartbeat: number | null
}

function formatAge(age: number | null): string {
  if (age === null) return 'never'
  if (age < 1) return 'just now'
  if (age < 60) return `${Math.round(age)}s ago`
  if (age < 3600) return `${Math.round(age / 60)}m ago`
  return `${Math.round(age / 3600)}h ago`
}

export function StatusBar({ connected, lastTx, lastHeartbeat }: StatusBarProps) {
  const [config, setConfig] = useState<EspConfig | null>(null)
  const [lastPacketAt, setLastPacketAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/esp/config')
      if (res.ok) {
        const data: EspConfig = await res.json()
        const fetchTime = Date.now()
        setConfig(data)
        setLastPacketAt(data.last_packet_age != null ? fetchTime - data.last_packet_age * 1000 : null)
      }
    } catch {
      // backend may not be running
    }
  }, [])

  useEffect(() => {
    fetchConfig()
    const interval = setInterval(fetchConfig, 5000)
    return () => clearInterval(interval)
  }, [fetchConfig])

  // Tick every second to keep displayed ages current
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  // Heartbeat age from SSE (real-time), packet age from polling
  const heartbeatAge = lastHeartbeat !== null ? (now - lastHeartbeat) / 1000 : null
  const packetAge = lastPacketAt !== null ? (now - lastPacketAt) / 1000 : null
  const receivingPackets = packetAge !== null && packetAge < 30
  const isOnline = connected && (heartbeatAge !== null ? heartbeatAge < 15 : receivingPackets)

  return (
    <div className="unified-status-bar">
      <div className="status-section">
        <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
        <span className="status-host">
          {config?.host || 'no device'}
        </span>
        <span className="status-value">:{config?.port ?? 9433}</span>
      </div>

      <span className="status-divider" />

      <div className="status-section">
        <span className="status-label">Last Seen</span>
        <span className={`status-value ${isOnline ? '' : 'status-stale'}`}>
          {config ? formatAge(heartbeatAge) : '—'}
        </span>
      </div>

      <span className="status-divider" />

      <div className="status-section">
        <span className="status-label">Last RX</span>
        <span className={`status-value ${receivingPackets ? '' : 'status-stale'}`}>
          {config ? formatAge(packetAge) : '—'}
        </span>
      </div>

      <span className="status-divider" />

      <div className={`status-section status-tx ${lastTx.type}`}>
        <span className="status-label">Last Action</span>
        <span className="status-value">{lastTx.message}</span>
      </div>
    </div>
  )
}
