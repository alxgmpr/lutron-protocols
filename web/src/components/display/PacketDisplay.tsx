import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { Card, Button } from '../common'
import { useProtocolDefinition } from '../../context/ProtocolDefinitionContext'
import type { FieldDef, FieldFormat } from '../../context/ProtocolDefinitionContext'
import type { Packet } from '../../types'
import './PacketDisplay.css'

interface PacketDisplayProps {
  title: string
  packets: Packet[]
  onClear: () => void
  variant: 'tx' | 'rx'
  paused?: boolean
  onTogglePause?: () => void
  collapsible?: boolean
  defaultCollapsed?: boolean
}

export function PacketDisplay({
  title,
  packets,
  onClear,
  variant,
  paused = false,
  onTogglePause,
  collapsible = false,
  defaultCollapsed = false
}: PacketDisplayProps) {
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
        collapsible={collapsible}
        defaultCollapsed={defaultCollapsed}
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
                className={`packet-entry packet-entry-${variant}${packet.crcOk === false ? ' packet-bad-crc' : ''}`}
                onClick={() => handlePacketClick(packet)}
              >
                <span className="packet-time">{packet.time}</span>
                <span className={`packet-type packet-type-${packet.type.toLowerCase().replace(/_/g, '-')}`}>
                  {packet.type}
                </span>
                {packet.crcOk === false && (
                  <span className="packet-crc-warning" title="Bad CRC - packet may be corrupted">!</span>
                )}
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
  const { identifyPacketFromHex, parseFieldValue, getCategoryColor } = useProtocolDefinition()

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

  const bytes = useMemo(() =>
    packet.rawBytes?.split(/\s+/).filter(b => b.length > 0) || [],
    [packet.rawBytes]
  )

  const identified = useMemo(() =>
    identifyPacketFromHex(bytes),
    [bytes, identifyPacketFromHex]
  )

  // Use backend-provided fields if available, otherwise use protocol-ui identification
  const hasBackendFields = packet.fields && packet.fields.length > 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content packet-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{packet.direction.toUpperCase()} Packet: {identified.typeName}</h2>
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
                <span>Byte Mapping ({bytes.length} bytes, Type: {identified.typeName})</span>
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
                  {hasBackendFields ? (
                    // Render backend-provided fields directly
                    packet.fields!.map((field, i) => (
                      <tr key={i}>
                        <td className="byte-offset">{field.start}{field.end - field.start > 1 ? `-${field.end - 1}` : ''}</td>
                        <td className="byte-field-name">{field.name}</td>
                        <td className="byte-value">
                          {field.decoded ? (
                            <>
                              <span className="byte-decoded">{field.decoded}</span>
                              <span className="byte-raw">{field.raw}</span>
                            </>
                          ) : (
                            <span className="byte-raw">{field.raw}</span>
                          )}
                        </td>
                      </tr>
                    ))
                  ) : (
                    // Use protocol-ui field definitions
                    identified.fields.map((field: FieldDef, i: number) => {
                      if (field.offset >= bytes.length) return null
                      const { raw, decoded } = parseFieldValue(bytes, field.offset, field.size, field.format as FieldFormat)
                      return (
                        <tr key={i}>
                          <td className="byte-offset">{field.offset}{field.size > 1 ? `-${Math.min(field.offset + field.size, bytes.length) - 1}` : ''}</td>
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
                    })
                  )}
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

          {/* Protocol info */}
          {identified.category !== 'unknown' && (
            <div className="packet-protocol-info">
              <div className="packet-protocol-header">
                <span
                  className="packet-protocol-badge"
                  style={{ backgroundColor: getCategoryColor(identified.category) }}
                >
                  {bytes[0] ? `0x${bytes[0].toUpperCase()}` : '??'}
                </span>
                <span className="packet-protocol-name">{identified.typeName}</span>
                <span className="packet-protocol-category">{identified.category}</span>
              </div>
              <p className="packet-protocol-desc">{identified.description}</p>
              {identified.isVirtual && (
                <p className="packet-protocol-desc" style={{ fontStyle: 'italic' }}>
                  Virtual type - reclassified from wire type 0x{bytes[0]?.toUpperCase()} based on format byte
                </p>
              )}
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
