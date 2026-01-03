import { useEffect, useRef, useState, useCallback } from 'react'
import type { LogEntry } from '../types'

const MAX_LOGS = 1000

/**
 * Hook for streaming raw ESP32 logs (for debugging)
 * Packet parsing is handled by the backend via usePacketStream
 */
export function useLogStream() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [connected, setConnected] = useState(false)
  const [pausedLogs, setPausedLogs] = useState(false)
  const [logsSnapshot, setLogsSnapshot] = useState<LogEntry[]>([])

  const eventSourceRef = useRef<EventSource | null>(null)

  const togglePauseLogs = useCallback(() => {
    setPausedLogs(prev => {
      if (!prev) setLogsSnapshot(logs)
      return !prev
    })
  }, [logs])

  const clearLogs = useCallback(() => {
    setLogs([])
    setLogsSnapshot([])
  }, [])

  useEffect(() => {
    const connect = () => {
      const eventSource = new EventSource('/api/logs/stream')
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        setConnected(true)
      }

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data) as LogEntry
        if (data.type === 'heartbeat') return

        const msg = stripAnsi(data.msg || '')
        setLogs(prev => [...prev.slice(-(MAX_LOGS - 1)), { ...data, msg }])
      }

      eventSource.onerror = () => {
        setConnected(false)
        eventSource.close()
        setTimeout(connect, 2000)
      }
    }

    connect()

    return () => {
      eventSourceRef.current?.close()
    }
  }, [])

  return {
    logs: pausedLogs ? logsSnapshot : logs,
    connected,
    clearLogs,
    pausedLogs,
    togglePauseLogs
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[0?;?[0-9]*m/g, '')
}
