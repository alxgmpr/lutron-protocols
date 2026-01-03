import { useRef, useEffect } from 'react'
import { Card, Button } from '../common'
import './PacketDisplay.css'

interface Packet {
  time: string
  data: string
}

interface PacketDisplayProps {
  title: string
  packets: Packet[]
  onClear: () => void
  variant: 'tx' | 'rx'
}

export function PacketDisplay({ title, packets, onClear, variant }: PacketDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [packets])

  const handleCopy = () => {
    const text = packets.map(p => `${p.time} ${p.data}`).join('\n')
    navigator.clipboard.writeText(text)
  }

  return (
    <Card
      title={title}
      variant={variant}
      className="packet-card"
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
            <div key={index} className="packet-entry">
              <span className="packet-time">{packet.time}</span>
              <span className="packet-data">{packet.data}</span>
            </div>
          ))
        )}
      </div>
    </Card>
  )
}

