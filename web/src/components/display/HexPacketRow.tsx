import { useMemo } from 'react'
import { HexByteRow } from './HexByte'
import { useProtocolDefinition } from '../../context/ProtocolDefinitionContext'
import type { Packet } from '../../types'
import './HexPacketRow.css'

interface HexPacketRowProps {
  packet: Packet
  variant: 'tx' | 'rx'
}

export function HexPacketRow({ packet, variant }: HexPacketRowProps) {
  const { identifyPacketFromHex, getCategoryColor } = useProtocolDefinition()

  const bytes = useMemo(() =>
    packet.rawBytes?.split(/\s+/).filter(b => b.length > 0) || [],
    [packet.rawBytes]
  )

  const identified = useMemo(() =>
    identifyPacketFromHex(bytes),
    [bytes, identifyPacketFromHex]
  )

  // Format time as HH:MM:SS.ms
  const formattedTime = useMemo(() => {
    if (!packet.time) return ''
    const match = packet.time.match(/(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/)
    if (match) {
      const [, h, m, s, ms] = match
      return ms ? `${h}:${m}:${s}.${ms.padEnd(3, '0').slice(0, 3)}` : `${h}:${m}:${s}`
    }
    return packet.time
  }, [packet.time])

  const typeColor = getCategoryColor(identified.category)

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
        title={identified.description}
      >
        {identified.typeName}
      </span>

      {/* CRC warning */}
      {packet.crcOk === false && (
        <span className="hex-packet-crc-warning" title="Bad CRC - packet may be corrupted">!</span>
      )}

      {/* Hex bytes */}
      <div className="hex-packet-bytes">
        <HexByteRow bytes={bytes} />
      </div>
    </div>
  )
}
