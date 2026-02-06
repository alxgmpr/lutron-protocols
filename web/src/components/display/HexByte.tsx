import { useCallback, useState, useMemo } from 'react'
import type { FieldDef, FieldFormat } from '../../context/ProtocolDefinitionContext'
import { useProtocolDefinition } from '../../context/ProtocolDefinitionContext'
import './HexByte.css'

/** Rotating color palette for defined fields */
const FIELD_COLORS = [
  '#E91E63', // pink - type byte
  '#FFC107', // amber - sequence
  '#2196F3', // blue - device id
  '#4CAF50', // green
  '#FF9800', // orange
  '#9C27B0', // purple
  '#00BCD4', // cyan
  '#FF5722', // deep orange
  '#8BC34A', // light green
  '#3F51B5', // indigo
  '#CDDC39', // lime
  '#795548', // brown
]

function getFieldColor(fieldIndex: number): string {
  return FIELD_COLORS[fieldIndex % FIELD_COLORS.length]
}

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
  const { parseFieldValue } = useProtocolDefinition()

  const handleMouseEnter = useCallback(() => {
    onHover(fieldIndex)
  }, [fieldIndex, onHover])

  const handleMouseLeave = useCallback(() => {
    onHover(null)
  }, [onHover])

  const color = getFieldColor(fieldIndex)

  // Get decoded value for tooltip
  const { decoded } = parseFieldValue(bytes, 0, bytes.length, field.format as FieldFormat)

  // Check if this is a broadcast field
  const isBroadcast = field.name === 'broadcast' && decoded === 'BROADCAST'

  const className = [
    'hex-field',
    'hex-field-known',
    isHighlighted && 'hex-field-highlighted',
  ].filter(Boolean).join(' ')

  const style = {
    '--field-color': color,
  } as React.CSSProperties

  const label = isBroadcast ? 'BCAST' : field.name
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
        <span className="hex-field-label">{label}</span>
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
  packetType?: string  // Optional - we identify from bytes now
  onFieldClick?: (field: FieldDef, bytes: string[]) => void
}

export function HexByteRow({ bytes, onFieldClick }: HexByteRowProps) {
  const { identifyPacketFromHex } = useProtocolDefinition()
  const [highlightedField, setHighlightedField] = useState<number | string | null>(null)

  // Identify packet and get field definitions from bytes
  const identified = useMemo(() => identifyPacketFromHex(bytes), [bytes, identifyPacketFromHex])
  const fields = identified.fields

  // Build segments: either a field or unmapped bytes
  const segments = useMemo(() => {
    const result: Array<
      | { type: 'field'; field: FieldDef; bytes: string[]; fieldIndex: number }
      | { type: 'unmapped'; bytes: string[]; startIndex: number }
    > = []

    // Sort fields by offset
    const sortedFields = [...fields].sort((a, b) => a.offset - b.offset)

    let currentIndex = 0

    for (let fi = 0; fi < sortedFields.length; fi++) {
      const field = sortedFields[fi]
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
          fieldIndex: fi
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
