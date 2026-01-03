import { useRef, useEffect, useState, useCallback } from 'react'
import { Card, Button } from '../common'
import type { Packet } from '../../types'
import './PacketDisplay.css'

interface PacketDisplayProps {
  title: string
  packets: Packet[]
  onClear: () => void
  variant: 'tx' | 'rx'
}

export function PacketDisplay({ title, packets, onClear, variant }: PacketDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedPacket, setSelectedPacket] = useState<Packet | null>(null)

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [packets])

  const handleCopy = () => {
    const text = packets.map(p => {
      const details = p.details.length > 0 ? ` | ${p.details.join(' | ')}` : ''
      return `${p.time} ${p.type} | ${p.summary}${details}`
    }).join('\n')
    navigator.clipboard.writeText(text)
  }

  const handlePacketClick = useCallback((packet: Packet) => {
    setSelectedPacket(packet)
  }, [])

  const closeModal = useCallback(() => {
    setSelectedPacket(null)
  }, [])

  return (
    <>
      <Card
        title={title}
        variant={variant}
        className="packet-card"
        badge={packets.length > 0 ? `${packets.length}` : undefined}
        actions={
          <>
            <Button size="sm" onClick={handleCopy}>Copy</Button>
            <Button size="sm" onClick={onClear}>Clear</Button>
          </>
        }
      >
        <div ref={containerRef} className="packet-container">
          {packets.length === 0 ? (
            <div className="packet-empty">No {variant.toUpperCase()} packets yet</div>
          ) : (
            packets.map((packet, index) => (
              <div
                key={index}
                className={`packet-entry packet-entry-${variant}`}
                onClick={() => handlePacketClick(packet)}
              >
                <span className="packet-time">{packet.time}</span>
                <span className={`packet-type packet-type-${packet.type.toLowerCase().replace(/_/g, '-')}`}>
                  {packet.type}
                </span>
                <span className="packet-summary">{packet.summary}</span>
                {packet.details.length > 0 && (
                  <span className="packet-details">
                    {packet.details.map((detail, i) => (
                      <span key={i} className="packet-detail">{detail}</span>
                    ))}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </Card>

      {selectedPacket && (
        <PacketDetailModal packet={selectedPacket} onClose={closeModal} />
      )}
    </>
  )
}

interface PacketDetailModalProps {
  packet: Packet
  onClose: () => void
}

function PacketDetailModal({ packet, onClose }: PacketDetailModalProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const copyRawBytes = () => {
    if (packet.rawBytes) {
      navigator.clipboard.writeText(packet.rawBytes)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content packet-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{packet.direction.toUpperCase()} Packet Details</h2>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body">
          <div className="packet-detail-row">
            <span className="packet-detail-label">Time</span>
            <span className="packet-detail-value">{packet.time}</span>
          </div>
          <div className="packet-detail-row">
            <span className="packet-detail-label">Type</span>
            <span className="packet-detail-value">{packet.type}</span>
          </div>
          <div className="packet-detail-row">
            <span className="packet-detail-label">Summary</span>
            <span className="packet-detail-value">{packet.summary}</span>
          </div>
          {packet.details.length > 0 && (
            <div className="packet-detail-row">
              <span className="packet-detail-label">Details</span>
              <span className="packet-detail-value">{packet.details.join(' | ')}</span>
            </div>
          )}
          {packet.rawBytes && (
            <div className="packet-detail-raw">
              <div className="packet-detail-raw-header">
                <span className="packet-detail-label">Raw Bytes</span>
                <Button size="sm" onClick={copyRawBytes}>Copy</Button>
              </div>
              <pre className="packet-raw-bytes">{packet.rawBytes}</pre>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="default" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}
