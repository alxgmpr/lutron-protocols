import { useRef, useEffect } from 'react'
import { Card, Button } from '../common'
import type { LogEntry } from '../../types'
import './LogDisplay.css'

interface LogDisplayProps {
  logs: LogEntry[]
  onClear: () => void
}

export function LogDisplay({ logs, onClear }: LogDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs])

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
      className="log-card"
      actions={
        <>
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

