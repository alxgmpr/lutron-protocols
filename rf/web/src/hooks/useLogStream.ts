import { useEffect, useRef, useState, useCallback } from 'react'
import type { LogEntry } from '../types'

interface ParsedPacket {
  time: string
  data: string
}

export function useLogStream() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [txPackets, setTxPackets] = useState<ParsedPacket[]>([])
  const [rxPackets, setRxPackets] = useState<ParsedPacket[]>([])
  const [connected, setConnected] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)

  const clearLogs = useCallback(() => setLogs([]), [])
  const clearTx = useCallback(() => setTxPackets([]), [])
  const clearRx = useCallback(() => setRxPackets([]), [])

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
        const time = data.time ? data.time.split('T')[1].split('.')[0] : ''

        const txMatch = msg.match(/TX\s+\d+\s+bytes:\s*([A-F0-9]{2}(?:\s+[A-F0-9]{2})+)/i)
        if (txMatch) {
          setTxPackets(prev => [...prev.slice(-29), { time, data: txMatch[1] }])
        }

        const rxMatch = msg.match(/RX:\s+(\S+\s+\|.+)/)
        if (rxMatch) {
          setRxPackets(prev => [...prev.slice(-29), { time, data: rxMatch[1] }])
        }

        // Also capture raw Bytes: dumps (undecoded packets)
        const bytesMatch = msg.match(/Bytes:\s*([A-F0-9]{2}(?:\s+[A-F0-9]{2})+)/i)
        if (bytesMatch && !rxMatch) {
          setRxPackets(prev => [...prev.slice(-29), { time, data: bytesMatch[1] }])
        }

        setLogs(prev => [...prev.slice(-199), { ...data, msg }])
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

  return { logs, txPackets, rxPackets, connected, clearLogs, clearTx, clearRx }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[0?;?[0-9]*m/g, '')
}

