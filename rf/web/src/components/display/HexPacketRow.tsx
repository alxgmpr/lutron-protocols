import { useState, useCallback, useMemo } from 'react'
import { HexByteRow } from './HexByte'
import { useProtocolDefinition } from '../../context/ProtocolDefinitionContext'
import type { Packet } from '../../types'
import type { FieldDef } from '../../context/ProtocolDefinitionContext'
import './HexPacketRow.css'

interface HexPacketRowProps {
  packet: Packet
  variant: 'tx' | 'rx'
  onExpandToggle?: (expanded: boolean) => void
  defaultExpanded?: boolean
}

export function HexPacketRow({
  packet,
  variant,
  onExpandToggle,
  defaultExpanded = false
}: HexPacketRowProps) {
  const { getPacketTypeDef, parseFieldValue } = useProtocolDefinition()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [selectedField, setSelectedField] = useState<{ field: FieldDef; bytes: string[] } | null>(null)

  const bytes = useMemo(() =>
    packet.rawBytes?.split(/\s+/).filter(b => b.length > 0) || [],
    [packet.rawBytes]
  )

  const packetDef = useMemo(() =>
    getPacketTypeDef(packet.type),
    [packet.type, getPacketTypeDef]
  )

  const handleToggleExpand = useCallback(() => {
    const newExpanded = !expanded
    setExpanded(newExpanded)
    onExpandToggle?.(newExpanded)
  }, [expanded, onExpandToggle])

  const handleFieldClick = useCallback((field: FieldDef, fieldBytes: string[]) => {
    setSelectedField(prev =>
      prev?.field.name === field.name ? null : { field, bytes: fieldBytes }
    )
  }, [])

  // Format time as HH:MM:SS.ms
  const formattedTime = useMemo(() => {
    if (!packet.time) return ''
    // Assume ISO format: 2024-01-15T12:34:56.789Z or similar
    const match = packet.time.match(/(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/)
    if (match) {
      const [, h, m, s, ms] = match
      return ms ? `${h}:${m}:${s}.${ms.padEnd(3, '0').slice(0, 3)}` : `${h}:${m}:${s}`
    }
    return packet.time
  }, [packet.time])

  // Get type badge color based on category
  const categoryColors: Record<string, string> = {
    status: '#4CAF50',
    control: '#2196F3',
    button: '#FF9800',
    pairing: '#9C27B0',
    unknown: '#9E9E9E',
  }
  const typeColor = categoryColors[packetDef.category] || '#9E9E9E'

  return (
    <div className={`hex-packet-row hex-packet-row-${variant} ${packet.crcOk === false ? 'hex-packet-bad-crc' : ''}`}>
      {/* Timestamp */}
      <span className="hex-packet-time">{formattedTime}</span>

      {/* Direction indicator */}
      <span className={`hex-packet-direction hex-packet-direction-${variant}`}>
        {variant === 'tx' ? '>' : '<'}
      </span>

      {/* Type badge */}
      <span
        className="hex-packet-type"
        style={{ backgroundColor: typeColor }}
        title={packetDef.description}
      >
        {packet.type}
      </span>

      {/* CRC warning */}
      {packet.crcOk === false && (
        <span className="hex-packet-crc-warning" title="Bad CRC - packet may be corrupted">!</span>
      )}

      {/* Summary (clickable to expand) */}
      <span className="hex-packet-summary" onClick={handleToggleExpand}>
        {packet.summary}
      </span>

      {/* Hex bytes */}
      <div className="hex-packet-bytes">
        <HexByteRow
          bytes={bytes}
          packetType={packet.type}
          onFieldClick={handleFieldClick}
        />
      </div>

      {/* Expand button */}
      <button
        className={`hex-packet-expand ${expanded ? 'expanded' : ''}`}
        onClick={handleToggleExpand}
        title={expanded ? 'Collapse' : 'Expand'}
      >
        {expanded ? '−' : '+'}
      </button>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="hex-packet-detail-panel">
          <div className="hex-packet-detail-grid">
            {packetDef.fields.map((field: FieldDef, i: number) => {
              const fieldBytes = bytes.slice(field.offset, field.offset + field.size)
              if (fieldBytes.length === 0) return null
              const { raw, decoded } = parseFieldValue(bytes, field.offset, field.size, field.format)
              const isSelected = selectedField?.field.name === field.name

              return (
                <div
                  key={i}
                  className={`hex-packet-detail-field ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleFieldClick(field, fieldBytes)}
                >
                  <span className="hex-packet-detail-name">{field.name}</span>
                  <span className="hex-packet-detail-value">
                    {decoded ? (
                      <>
                        <span className="decoded">{decoded}</span>
                        <span className="raw">{raw}</span>
                      </>
                    ) : (
                      <span className="raw">{raw}</span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Selected field detail */}
          {selectedField && (
            <div className="hex-packet-field-detail">
              <div className="field-detail-header">
                <span className="field-detail-name">{selectedField.field.name}</span>
                <span className="field-detail-format">{selectedField.field.format}</span>
              </div>
              <div className="field-detail-info">
                <span className="field-detail-offset">
                  Offset: {selectedField.field.offset} ({selectedField.field.size} bytes)
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
