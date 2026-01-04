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
  format?: 'hex' | 'decimal' | 'device_id' | 'device_id_be' | 'level_16bit' | 'level_byte' | 'button' | 'action'
}

// STATE_RPT: Dimmer broadcasting its current level
const STATE_RPT_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Device ID', start: 2, end: 6, format: 'device_id' },
  { name: 'Format', start: 6, end: 8, format: 'hex' },  // 00 08
  { name: 'Fixed', start: 8, end: 11, format: 'hex' },  // 00 1B 01
  { name: 'Level', start: 11, end: 12, format: 'level_byte' },
  { name: 'Fixed', start: 12, end: 16, format: 'hex' },  // 00 1B 92 XX
  { name: 'Padding', start: 16, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

// LEVEL: Bridge sending level command to dimmer
const LEVEL_CMD_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Source ID', start: 2, end: 6, format: 'device_id' },
  { name: 'Format', start: 6, end: 8, format: 'hex' },  // 21 0E
  { name: 'Fixed', start: 8, end: 9, format: 'hex' },
  { name: 'Target ID', start: 9, end: 13, format: 'device_id_be' },
  { name: 'Fixed', start: 13, end: 16, format: 'hex' },  // FE 40 02
  { name: 'Level', start: 16, end: 18, format: 'level_16bit' },
  { name: 'Trailer', start: 18, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

// BTN: Button press packets (short and long format)
const BUTTON_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Device ID', start: 2, end: 6, format: 'device_id_be' },
  { name: 'Protocol', start: 6, end: 8, format: 'hex' },  // 21 04/0E
  { name: 'Fixed', start: 8, end: 10, format: 'hex' },
  { name: 'Button', start: 10, end: 11, format: 'button' },
  { name: 'Action', start: 11, end: 12, format: 'action' },
  { name: 'Payload', start: 12, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

// BEACON: Bridge pairing beacon
const BEACON_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Load ID', start: 2, end: 6, format: 'device_id_be' },
  { name: 'Format', start: 6, end: 8, format: 'hex' },  // 21 0C
  { name: 'Fixed', start: 8, end: 9, format: 'hex' },
  { name: 'Broadcast', start: 9, end: 14, format: 'hex' },  // FF FF FF FF FF
  { name: 'Fixed', start: 14, end: 20, format: 'hex' },
  { name: 'Padding', start: 20, end: 22, format: 'hex' },
  { name: 'CRC', start: 22, end: 24, format: 'hex' },
]

// PAIRING: Pico pairing packets (53 bytes)
const PAIRING_FIELDS: ByteField[] = [
  { name: 'Type', start: 0, end: 1, format: 'hex' },
  { name: 'Sequence', start: 1, end: 2, format: 'decimal' },
  { name: 'Device ID', start: 2, end: 6, format: 'device_id_be' },
  { name: 'Format', start: 6, end: 8, format: 'hex' },  // 21 25
  { name: 'Fixed', start: 8, end: 10, format: 'hex' },
  { name: 'Btn Scheme', start: 10, end: 11, format: 'hex' },  // 04=5btn, 0B=4btn
  { name: 'Fixed', start: 11, end: 13, format: 'hex' },
  { name: 'Broadcast', start: 13, end: 18, format: 'hex' },
  { name: 'Fixed', start: 18, end: 20, format: 'hex' },
  { name: 'Device ID 2', start: 20, end: 24, format: 'device_id_be' },
  { name: 'Device ID 3', start: 24, end: 28, format: 'device_id_be' },
  { name: 'Capabilities', start: 28, end: 41, format: 'hex' },
  { name: 'Broadcast 2', start: 41, end: 45, format: 'hex' },
  { name: 'Padding', start: 45, end: 51, format: 'hex' },
  { name: 'CRC', start: 51, end: 53, format: 'hex' },
]

const BUTTON_NAMES: Record<string, string> = {
  '02': 'ON', '03': 'FAV', '04': 'OFF', '05': 'RAISE', '06': 'LOWER',
  '08': 'SCENE4/ON', '09': 'SCENE3/RAISE', '0A': 'SCENE2/LOWER', '0B': 'SCENE1/OFF',
}

const PACKET_TYPE_NAMES: Record<string, string> = {
  '81': 'STATE/LEVEL', '82': 'STATE/LEVEL', '83': 'STATE/LEVEL',
  '88': 'BTN_SHORT_A', '89': 'BTN_LONG_A', '8A': 'BTN_SHORT_B', '8B': 'BTN_LONG_B',
  '91': 'BEACON', '92': 'BEACON', '93': 'BEACON',
  'A2': 'LEVEL',
  'B8': 'PAIR_B8', 'B9': 'PAIR_B9', 'BA': 'PAIR_BA', 'BB': 'PAIR_BB',
}

function getFieldsForPacket(packetType: string, bytes: string[]): ByteField[] {
  // Pairing packets (53 bytes)
  if (packetType.startsWith('PAIR_')) {
    return PAIRING_FIELDS
  }
  // Beacon packets
  if (packetType.startsWith('BEACON')) {
    return BEACON_FIELDS
  }
  // Button packets
  if (packetType.startsWith('BTN_')) {
    return BUTTON_FIELDS
  }
  // STATE_RPT vs LEVEL - distinguish by bytes 6-7
  if (packetType === 'LEVEL' || packetType === 'STATE_RPT') {
    // STATE_RPT: bytes 6-7 = 00 08
    // LEVEL cmd: bytes 6-7 = 21 0E
    if (bytes.length >= 8 && bytes[6] === '00' && bytes[7] === '08') {
      return STATE_RPT_FIELDS
    }
    return LEVEL_CMD_FIELDS
  }
  return BUTTON_FIELDS  // fallback
}

function formatFieldValue(bytes: string[], field: ByteField): { raw: string, decoded: string | null } {
  const fieldBytes = bytes.slice(field.start, Math.min(field.end, bytes.length))
  const raw = fieldBytes.join(' ')

  if (fieldBytes.length === 0) {
    return { raw: '-', decoded: null }
  }

  switch (field.format) {
    // Little-endian device ID (STATE_RPT, LEVEL source)
    case 'device_id':
      if (fieldBytes.length >= 4) {
        const id = `${fieldBytes[3]}${fieldBytes[2]}${fieldBytes[1]}${fieldBytes[0]}`.toUpperCase()
        return { raw, decoded: id }
      }
      return { raw, decoded: null }

    // Big-endian device ID (button packets, pairing, targets)
    case 'device_id_be':
      if (fieldBytes.length >= 4) {
        const id = `${fieldBytes[0]}${fieldBytes[1]}${fieldBytes[2]}${fieldBytes[3]}`.toUpperCase()
        return { raw, decoded: id }
      }
      return { raw, decoded: null }

    // 16-bit level (LEVEL command: 0x0000-0xFEFF = 0-100%)
    case 'level_16bit':
      if (fieldBytes.length >= 2) {
        const levelRaw = parseInt(fieldBytes[0] + fieldBytes[1], 16)
        const level = levelRaw === 0 ? 0 : Math.round((levelRaw * 100) / 65279)
        return { raw, decoded: `${level}%` }
      }
      return { raw, decoded: null }

    // Single byte level (STATE_RPT: 0x00-0xFE = 0-100%)
    case 'level_byte':
      const levelByte = parseInt(fieldBytes[0], 16)
      const levelPct = levelByte === 0 ? 0 : Math.round((levelByte * 100) / 254)
      return { raw, decoded: `${levelPct}%` }

    case 'button':
      const btnName = BUTTON_NAMES[fieldBytes[0]?.toUpperCase()]
      return { raw, decoded: btnName || `0x${fieldBytes[0]}` }

    case 'action':
      const actionMap: Record<string, string> = {
        '00': 'PRESS', '01': 'RELEASE', '03': 'SAVE'
      }
      const action = actionMap[fieldBytes[0]?.toLowerCase()] || `0x${fieldBytes[0]}`
      return { raw, decoded: action }

    case 'decimal':
      return { raw, decoded: String(parseInt(fieldBytes[0], 16)) }

    case 'hex':
    default:
      // For hex, don't duplicate - just show raw
      return { raw, decoded: null }
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
  const fields = getFieldsForPacket(packet.type, bytes)
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
                    <th>Value</th>
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
                        <td className="byte-value">
                          {decoded ? (
                            <>
                              <span className="byte-decoded">{decoded}</span>
                              <span className="byte-raw">{raw}</span>
                            </>
                          ) : (
                            <span className="byte-raw">{raw}</span>
                          )}
                        </td>
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
