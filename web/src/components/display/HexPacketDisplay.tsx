import { useRef, useEffect, useCallback } from 'react'
import { Card, Button } from '../common'
import { HexPacketRow } from './HexPacketRow'
import type { Packet } from '../../types'
import './HexPacketDisplay.css'

interface HexPacketDisplayProps {
  title: string
  packets: Packet[]
  onClear: () => void
  variant: 'tx' | 'rx'
  paused?: boolean
  onTogglePause?: () => void
  collapsible?: boolean
  defaultCollapsed?: boolean
}

export function HexPacketDisplay({
  title,
  packets,
  onClear,
  variant,
  paused = false,
  onTogglePause,
  collapsible = false,
  defaultCollapsed = false
}: HexPacketDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Only auto-scroll when not paused
  useEffect(() => {
    if (containerRef.current && !paused) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [packets, paused])

  const handleDumpJson = useCallback(() => {
    const data = {
      exported_at: new Date().toISOString(),
      variant,
      count: packets.length,
      packets: packets.map(p => ({
        time: p.time,
        type: p.type,
        direction: p.direction,
        summary: p.summary,
        details: p.details,
        rawBytes: p.rawBytes,
        crcOk: p.crcOk
      }))
    }

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cca_${variant}_packets_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [packets, variant])

  return (
    <Card
      title={title}
      variant={variant}
      className={`hex-packet-card ${paused ? 'paused' : ''}`}
      badge={`${packets.length}${paused ? ' (paused)' : ''}`}
      collapsible={collapsible}
      defaultCollapsed={defaultCollapsed}
      actions={
        <>
          {onTogglePause && (
            <Button size="sm" variant={paused ? 'primary' : 'default'} onClick={onTogglePause}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
          )}
          <Button size="sm" onClick={handleDumpJson} disabled={packets.length === 0}>
            Dump JSON
          </Button>
          <Button size="sm" onClick={onClear}>Clear</Button>
        </>
      }
    >
      <div ref={containerRef} className="hex-packet-container">
        {packets.length === 0 ? (
          <div className="hex-packet-empty">No {variant.toUpperCase()} packets yet</div>
        ) : (
          packets.map((packet, index) => (
            <HexPacketRow
              key={index}
              packet={packet}
              variant={variant}
            />
          ))
        )}
      </div>
    </Card>
  )
}
