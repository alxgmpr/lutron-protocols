import { useCallback, useState, useMemo } from 'react'
import type { FieldDef, FieldFormatType } from '../../context/ProtocolDefinitionContext'
import { useProtocolDefinition } from '../../context/ProtocolDefinitionContext'
import './HexByte.css'

interface HexFieldProps {
  field: FieldDef
  bytes: string[]
  fieldIndex: number
  isHighlighted: boolean
  onHover: (fieldIndex: number | null) => void
  onClick?: () => void
}

function HexField({
  field,
  bytes,
  fieldIndex,
  isHighlighted,
  onHover,
  onClick
}: HexFieldProps) {
  const { getFieldColor, parseFieldValue } = useProtocolDefinition()

  const handleMouseEnter = useCallback(() => {
    onHover(fieldIndex)
  }, [fieldIndex, onHover])

  const handleMouseLeave = useCallback(() => {
    onHover(null)
  }, [onHover])

  const color = getFieldColor(field.format as FieldFormatType)
  const isKnown = field.name !== 'Payload' && field.name !== 'Padding' && field.name !== 'Fixed' && field.name !== 'Unknown'
  const isUnknown = field.name === 'Payload' || field.name === 'Padding' || field.name === 'Unknown'

  // Get decoded value for tooltip
  const { decoded } = parseFieldValue(bytes, 0, bytes.length, field.format)

  const className = [
    'hex-field',
    isKnown && 'hex-field-known',
    isUnknown && 'hex-field-unknown',
    isHighlighted && 'hex-field-highlighted',
  ].filter(Boolean).join(' ')

  const style = {
    '--field-color': color,
  } as React.CSSProperties

  const tooltipText = decoded
    ? `${field.name}: ${decoded} (${bytes.join(' ')})`
    : `${field.name}: ${bytes.join(' ')}`

  return (
    <span
      className={className}
      style={style}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
      data-field={field.name}
      title={tooltipText}
    >
      <span className="hex-field-bytes">
        {bytes.join('')}
      </span>
      {isHighlighted && (
        <span className="hex-field-label">{field.name}</span>
      )}
    </span>
  )
}

// Component for bytes that don't belong to any defined field
interface UnmappedBytesProps {
  bytes: string[]
  startIndex: number
  isHighlighted: boolean
  onHover: (id: string | null) => void
}

function UnmappedBytes({ bytes, startIndex, isHighlighted, onHover }: UnmappedBytesProps) {
  const id = `unmapped-${startIndex}`

  return (
    <span
      className={`hex-field hex-field-unmapped ${isHighlighted ? 'hex-field-highlighted' : ''}`}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      title={`Unknown bytes at offset ${startIndex}`}
    >
      <span className="hex-field-bytes">
        {bytes.join('')}
      </span>
    </span>
  )
}

interface HexByteRowProps {
  bytes: string[]
  packetType: string
  onFieldClick?: (field: FieldDef, bytes: string[]) => void
}

export function HexByteRow({ bytes, packetType, onFieldClick }: HexByteRowProps) {
  const { getPacketTypeDef } = useProtocolDefinition()
  const [highlightedField, setHighlightedField] = useState<number | string | null>(null)

  // Get field definitions for this packet type
  const packetDef = getPacketTypeDef(packetType)
  const fields = packetDef.fields

  // Build segments: either a field or unmapped bytes
  const segments = useMemo(() => {
    const result: Array<
      | { type: 'field'; field: FieldDef; bytes: string[]; fieldIndex: number }
      | { type: 'unmapped'; bytes: string[]; startIndex: number }
    > = []

    // Sort fields by offset
    const sortedFields = [...fields].sort((a, b) => a.offset - b.offset)

    let currentIndex = 0

    for (const field of sortedFields) {
      // Add unmapped bytes before this field
      if (currentIndex < field.offset) {
        const unmappedBytes = bytes.slice(currentIndex, field.offset)
        if (unmappedBytes.length > 0) {
          result.push({
            type: 'unmapped',
            bytes: unmappedBytes,
            startIndex: currentIndex
          })
        }
      }

      // Add the field
      const fieldBytes = bytes.slice(field.offset, field.offset + field.size)
      if (fieldBytes.length > 0) {
        result.push({
          type: 'field',
          field,
          bytes: fieldBytes,
          fieldIndex: fields.indexOf(field)
        })
      }

      currentIndex = Math.max(currentIndex, field.offset + field.size)
    }

    // Add any remaining unmapped bytes
    if (currentIndex < bytes.length) {
      result.push({
        type: 'unmapped',
        bytes: bytes.slice(currentIndex),
        startIndex: currentIndex
      })
    }

    return result
  }, [bytes, fields])

  const handleFieldHover = useCallback((fieldIndex: number | null) => {
    setHighlightedField(fieldIndex)
  }, [])

  const handleUnmappedHover = useCallback((id: string | null) => {
    setHighlightedField(id)
  }, [])

  return (
    <div className="hex-byte-row">
      {segments.map((segment, i) => {
        if (segment.type === 'field') {
          return (
            <HexField
              key={`field-${i}`}
              field={segment.field}
              bytes={segment.bytes}
              fieldIndex={segment.fieldIndex}
              isHighlighted={highlightedField === segment.fieldIndex}
              onHover={handleFieldHover}
              onClick={onFieldClick ? () => onFieldClick(segment.field, segment.bytes) : undefined}
            />
          )
        } else {
          return (
            <UnmappedBytes
              key={`unmapped-${i}`}
              bytes={segment.bytes}
              startIndex={segment.startIndex}
              isHighlighted={highlightedField === `unmapped-${segment.startIndex}`}
              onHover={handleUnmappedHover}
            />
          )
        }
      })}
    </div>
  )
}

// Keep this export for backwards compatibility if needed elsewhere
export { HexField as HexByte }
