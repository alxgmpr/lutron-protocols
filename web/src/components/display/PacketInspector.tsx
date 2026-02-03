import { useState, useEffect, useCallback } from 'react'
import { Button } from '../common'
import './PacketInspector.css'

interface DecodedPacket {
  id: number
  direction: 'rx' | 'tx'
  packet_type: string
  device_id: string | null
  source_id: string | null
  target_id: string | null
  level: number | null
  button: string | null
  rssi: number | null
  timestamp: string
  raw_hex: string | null
  decoded_data: Record<string, string> | null
}

interface PacketInspectorProps {
  deviceId?: string
  subnet?: string
  title: string
  onClose: () => void
}

export function PacketInspector({ deviceId, subnet, title, onClose }: PacketInspectorProps) {
  const [packets, setPackets] = useState<DecodedPacket[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [filter, setFilter] = useState<'all' | 'rx' | 'tx'>('all')
  const [typeFilter, setTypeFilter] = useState<string>('')

  const loadPackets = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '200' })
      if (deviceId) params.set('device', deviceId.replace(/^0x/i, ''))
      if (filter !== 'all') params.set('direction', filter)

      const response = await fetch(`/api/packets?${params}`)
      const data = await response.json()
      const mapped: DecodedPacket[] = (Array.isArray(data) ? data : []).map((p: Record<string, unknown>, index: number) => {
        const details = (p.details as Record<string, string> | null) ?? {}
        const decodedData = Object.fromEntries(
          Object.entries(details).map(([k, v]) => [k, String(v)])
        )
        return {
          id: index,
          direction: (p.direction as 'rx' | 'tx') ?? 'rx',
          packet_type: (p.type as string) ?? 'unknown',
          device_id: (p.device_id as string) ?? null,
          source_id: (p.source_id as string) ?? null,
          target_id: (p.target_id as string) ?? (decodedData.target_id ?? null),
          level: typeof details.level === 'number' ? details.level : (decodedData.level ? parseInt(decodedData.level, 10) : null),
          button: (details.button as string) ?? decodedData.button ?? null,
          rssi: typeof p.rssi === 'number' ? p.rssi : null,
          timestamp: (p.time as string) ?? (p.timestamp as string) ?? new Date().toISOString(),
          raw_hex: (p.raw_hex as string) ?? null,
          decoded_data: Object.keys(decodedData).length > 0 ? decodedData : null
        }
      })
      let filtered = mapped
      if (typeFilter) filtered = filtered.filter(p => p.packet_type === typeFilter)
      if (subnet) filtered = filtered.filter(p => {
        const sid = (p.device_id ?? p.source_id ?? '').toUpperCase()
        return sid.includes(subnet.replace(/^0x/i, '').toUpperCase())
      })
      setPackets(filtered)
    } catch (e) {
      console.error('Failed to load packets:', e)
    } finally {
      setLoading(false)
    }
  }, [deviceId, subnet, filter, typeFilter])

  useEffect(() => {
    loadPackets()
  }, [loadPackets])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString()
  }

  const getPacketTypes = () => {
    const types = new Set(packets.map(p => p.packet_type))
    return Array.from(types).sort()
  }

  const toggleExpand = (id: number) => {
    setExpandedId(expandedId === id ? null : id)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content packet-inspector-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="inspector-toolbar">
          <div className="inspector-filters">
            <select value={filter} onChange={e => setFilter(e.target.value as 'all' | 'rx' | 'tx')}>
              <option value="all">All Directions</option>
              <option value="rx">RX Only</option>
              <option value="tx">TX Only</option>
            </select>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              <option value="">All Types</option>
              {getPacketTypes().map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
          <div className="inspector-info">
            {loading ? 'Loading...' : `${packets.length} packets`}
          </div>
          <Button size="sm" onClick={loadPackets}>Refresh</Button>
        </div>

        <div className="inspector-body">
          {packets.length === 0 && !loading && (
            <div className="inspector-empty">No packets found</div>
          )}

          <div className="inspector-packet-list">
            {packets.map(pkt => (
              <div
                key={pkt.id}
                className={`inspector-packet ${pkt.direction} ${expandedId === pkt.id ? 'expanded' : ''}`}
                onClick={() => toggleExpand(pkt.id)}
              >
                <div className="inspector-packet-header">
                  <span className={`inspector-direction ${pkt.direction}`}>
                    {pkt.direction.toUpperCase()}
                  </span>
                  <span className="inspector-type">{pkt.packet_type}</span>
                  <span className="inspector-summary">
                    {pkt.source_id && pkt.target_id
                      ? `${pkt.source_id} -> ${pkt.target_id}`
                      : pkt.device_id || ''}
                  </span>
                  {pkt.level !== null && (
                    <span className="inspector-level">{pkt.level}%</span>
                  )}
                  {pkt.button && (
                    <span className="inspector-button">{pkt.button}</span>
                  )}
                  {pkt.rssi !== null && (
                    <span className="inspector-rssi">RSSI={pkt.rssi}</span>
                  )}
                  <span className="inspector-time">{formatTime(pkt.timestamp)}</span>
                </div>

                {expandedId === pkt.id && (
                  <div className="inspector-packet-detail">
                    <div className="inspector-detail-row">
                      <span className="detail-label">Timestamp</span>
                      <span className="detail-value">{pkt.timestamp}</span>
                    </div>
                    {pkt.device_id && (
                      <div className="inspector-detail-row">
                        <span className="detail-label">Device ID</span>
                        <span className="detail-value mono">{pkt.device_id}</span>
                      </div>
                    )}
                    {pkt.source_id && (
                      <div className="inspector-detail-row">
                        <span className="detail-label">Source ID</span>
                        <span className="detail-value mono">{pkt.source_id}</span>
                      </div>
                    )}
                    {pkt.target_id && (
                      <div className="inspector-detail-row">
                        <span className="detail-label">Target ID</span>
                        <span className="detail-value mono">{pkt.target_id}</span>
                      </div>
                    )}
                    {pkt.decoded_data && Object.keys(pkt.decoded_data).length > 0 && (
                      <div className="inspector-detail-row">
                        <span className="detail-label">Decoded</span>
                        <span className="detail-value">
                          {Object.entries(pkt.decoded_data).map(([k, v]) => (
                            <span key={k} className="decoded-field">{k}={v}</span>
                          ))}
                        </span>
                      </div>
                    )}
                    {pkt.raw_hex && (
                      <div className="inspector-detail-row raw-hex-row">
                        <span className="detail-label">Raw Bytes</span>
                        <span className="detail-value mono raw-hex">{pkt.raw_hex}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="modal-footer">
          <Button variant="default" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}
