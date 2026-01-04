import { useRef, useEffect, useState, useCallback } from 'react'
import { Card, Button } from '../common'
import type { Packet } from '../../types'
import './PacketDisplay.css'

interface PacketDisplayProps {
  title: string
  packets: Packet[]
  onClear: () => void
  variant: 'tx' | 'rx'
  paused?: boolean
  onTogglePause?: () => void
}

export function PacketDisplay({ title, packets, onClear, variant, paused = false, onTogglePause }: PacketDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedPacket, setSelectedPacket] = useState<Packet | null>(null)

  // Only auto-scroll when not paused
  useEffect(() => {
    if (containerRef.current && !paused) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [packets, paused])

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
        className={`packet-card ${paused ? 'paused' : ''}`}
        badge={packets.length > 0 ? `${packets.length}${paused ? ' (paused)' : ''}` : undefined}
        actions={
          <>
            {onTogglePause && (
              <Button size="sm" variant={paused ? 'primary' : 'default'} onClick={onTogglePause}>
                {paused ? 'Resume' : 'Pause'}
              </Button>
            )}
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

// Packet byte field definitions
interface ByteField {
  name: string
  start: number
  end: number  // exclusive
  format?: 'hex' | 'decimal' | 'device_id' | 'level' | 'button' | 'action'
}

const STANDARD_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Device ID', start: 2, end: 6, format: 'device_id' },
  { name: 'Unknown', start: 6, end: 10, format: 'hex' },
  { name: 'Button/Target', start: 10, end: 11, format: 'button' },
  { name: 'Action/Level', start: 11, end: 12, format: 'action' },
  { name: 'Payload', start: 12, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

const LEVEL_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Source ID', start: 2, end: 6, format: 'device_id' },
  { name: 'Unknown', start: 6, end: 9, format: 'hex' },
  { name: 'Target ID', start: 9, end: 13, format: 'device_id' },
  { name: 'Unknown', start: 13, end: 16, format: 'hex' },
  { name: 'Level', start: 16, end: 18, format: 'level' },
  { name: 'Padding', start: 18, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

const PAIRING_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Device ID', start: 2, end: 6, format: 'device_id' },
  { name: 'Unknown', start: 6, end: 10, format: 'hex' },
  { name: 'Byte 10', start: 10, end: 11, format: 'hex' },
  { name: 'Unknown', start: 11, end: 30, format: 'hex' },
  { name: 'Byte 30', start: 30, end: 31, format: 'hex' },
  { name: 'Byte 31', start: 31, end: 32, format: 'hex' },
  { name: 'Unknown', start: 32, end: 37, format: 'hex' },
  { name: 'Byte 37', start: 37, end: 38, format: 'hex' },
  { name: 'Byte 38', start: 38, end: 39, format: 'hex' },
  { name: 'Remaining', start: 39, end: 53, format: 'hex' },
]

const BUTTON_NAMES: Record<string, string> = {
  '02': 'ON', '03': 'FAV', '04': 'OFF', '05': 'RAISE', '06': 'LOWER',
  '08': 'SCENE4', '09': 'SCENE3', '0A': 'SCENE2', '0B': 'SCENE1',
}

const PACKET_TYPE_NAMES: Record<string, string> = {
  '81': 'STATE_RPT', '82': 'STATE_RPT', '83': 'STATE_RPT',
  '88': 'BTN_SHORT_A', '89': 'BTN_LONG_A', '8A': 'BTN_SHORT_B', '8B': 'BTN_LONG_B',
  '91': 'BEACON', '92': 'BEACON', '93': 'BEACON',
  'A2': 'LEVEL',
  'B8': 'PAIR_B8', 'B9': 'PAIR_B9', 'BA': 'PAIR_BA', 'BB': 'PAIR_BB',
}

function getFieldsForPacket(packetType: string): ByteField[] {
  if (packetType.startsWith('PAIR_') || packetType.startsWith('BEACON')) {
    return PAIRING_FIELDS
  }
  if (packetType === 'LEVEL' || packetType === 'STATE_RPT') {
    return LEVEL_FIELDS
  }
  return STANDARD_FIELDS
}

function formatFieldValue(bytes: string[], field: ByteField): { raw: string, decoded: string } {
  const fieldBytes = bytes.slice(field.start, Math.min(field.end, bytes.length))
  const raw = fieldBytes.join(' ')

  if (fieldBytes.length === 0) {
    return { raw: '-', decoded: '-' }
  }

  switch (field.format) {
    case 'device_id':
      if (fieldBytes.length >= 4) {
        const id = `${fieldBytes[3]}${fieldBytes[2]}${fieldBytes[1]}${fieldBytes[0]}`.toUpperCase()
        return { raw, decoded: id }
      }
      return { raw, decoded: raw }

    case 'level':
      if (fieldBytes.length >= 2) {
        const levelRaw = parseInt(fieldBytes[0] + fieldBytes[1], 16)
        const level = levelRaw === 0 ? 0 : Math.round((levelRaw * 100) / 65279)
        return { raw, decoded: `${level}%` }
      }
      return { raw, decoded: raw }

    case 'button':
      const btnName = BUTTON_NAMES[fieldBytes[0]?.toUpperCase()]
      return { raw, decoded: btnName || `0x${fieldBytes[0]}` }

    case 'action':
      const action = fieldBytes[0] === '00' ? 'PRESS' : fieldBytes[0] === '01' ? 'RELEASE' : `0x${fieldBytes[0]}`
      return { raw, decoded: action }

    case 'decimal':
      return { raw, decoded: String(parseInt(fieldBytes[0], 16)) }

    case 'hex':
    default:
      return { raw, decoded: raw }
  }
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

  const bytes = packet.rawBytes?.split(/\s+/).filter(b => b.length > 0) || []
  const fields = getFieldsForPacket(packet.type)
  const packetTypeName = bytes[0] ? (PACKET_TYPE_NAMES[bytes[0].toUpperCase()] || `0x${bytes[0]}`) : '-'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content packet-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{packet.direction.toUpperCase()} Packet: {packet.type}</h2>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body">
          {/* Summary section */}
          <div className="packet-summary-section">
            <div className="packet-detail-row">
              <span className="packet-detail-label">Time</span>
              <span className="packet-detail-value">{packet.time}</span>
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
          </div>

          {/* Byte mapping table */}
          {bytes.length > 0 && (
            <div className="packet-byte-mapping">
              <div className="packet-byte-mapping-header">
                <span>Byte Mapping ({bytes.length} bytes, Type: {packetTypeName})</span>
              </div>
              <table className="packet-byte-table">
                <thead>
                  <tr>
                    <th>Offset</th>
                    <th>Field</th>
                    <th>Raw</th>
                    <th>Decoded</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, i) => {
                    if (field.start >= bytes.length) return null
                    const { raw, decoded } = formatFieldValue(bytes, field)
                    return (
                      <tr key={i}>
                        <td className="byte-offset">{field.start}{field.end - field.start > 1 ? `-${Math.min(field.end, bytes.length) - 1}` : ''}</td>
                        <td className="byte-field-name">{field.name}</td>
                        <td className="byte-raw">{raw}</td>
                        <td className="byte-decoded">{decoded}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Raw bytes */}
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
