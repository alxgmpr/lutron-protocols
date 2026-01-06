import { useRef, useEffect } from 'react'
import { Card, Button } from '../common'
import type { LogEntry } from '../../types'
import './LogDisplay.css'

interface LogDisplayProps {
  logs: LogEntry[]
  onClear: () => void
  paused?: boolean
  onTogglePause?: () => void
  collapsible?: boolean
  defaultCollapsed?: boolean
}

export function LogDisplay({
  logs,
  onClear,
  paused = false,
  onTogglePause,
  collapsible = false,
  defaultCollapsed = false
}: LogDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Only auto-scroll when not paused
  useEffect(() => {
    if (containerRef.current && !paused) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, paused])

  const handleCopy = () => {
    const text = logs.map(log => {
      const time = log.time ? log.time.split('T')[1].split('.')[0] : ''
      return `${time} [${log.level}] ${log.msg}`
    }).join('\n')
    navigator.clipboard.writeText(text)
  }

  return (
    <Card
      title="ESP32 Logs"
      variant="logs"
      className={`log-card ${paused ? 'paused' : ''}`}
      badge={paused ? 'paused' : undefined}
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
      <div ref={containerRef} className="log-container">
        {logs.map((log, index) => {
          const time = log.time ? log.time.split('T')[1].split('.')[0] : ''
          return (
            <div key={index} className="log-entry">
              <span className="log-time">{time}</span>
              <span className={`log-level log-level-${log.level}`}>[{log.level}]</span>
              <span className="log-msg">{log.msg}</span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}



