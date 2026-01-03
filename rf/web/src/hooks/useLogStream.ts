import { useEffect, useRef, useState, useCallback } from 'react'
import type { LogEntry, Packet } from '../types'

// Max packets/logs to store (scrollable history)
const MAX_PACKETS = 500
const MAX_LOGS = 1000

export function useLogStream() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [txPackets, setTxPackets] = useState<Packet[]>([])
  const [rxPackets, setRxPackets] = useState<Packet[]>([])
  const [connected, setConnected] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const pendingTxContext = useRef<string>('')  // Track TX context from "===" markers

  const clearLogs = useCallback(() => setLogs([]), [])
  const clearTx = useCallback(() => setTxPackets([]), [])
  const clearRx = useCallback(() => setRxPackets([]), [])
  const clearAll = useCallback(() => {
    setLogs([])
    setTxPackets([])
    setRxPackets([])
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
        const time = data.time ? data.time.split('T')[1].split('.')[0] : ''

        // Track TX context from "===" markers
        const contextMatch = msg.match(/===\s*(.+?)\s*===/)
        if (contextMatch) {
          pendingTxContext.current = contextMatch[1]
        }

        // Parse TX packets
        const txMatch = msg.match(/TX\s+(\d+)\s+bytes:\s*([A-F0-9]{2}(?:\s+[A-F0-9]{2})+)/i)
        if (txMatch) {
          const rawBytes = txMatch[2]
          const packet = parseTxPacket(rawBytes, pendingTxContext.current, time)
          setTxPackets(prev => [...prev.slice(-(MAX_PACKETS - 1)), packet])
        }

        // Parse RX packets
        const rxMatch = msg.match(/RX:\s+(\S+)\s+\|\s*(.+)/)
        if (rxMatch) {
          const packet = parseRxPacket(rxMatch[1], rxMatch[2], time, msg)
          setRxPackets(prev => [...prev.slice(-(MAX_PACKETS - 1)), packet])
        }

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

  return { logs, txPackets, rxPackets, connected, clearLogs, clearTx, clearRx, clearAll }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[0?;?[0-9]*m/g, '')
}

function parseTxPacket(rawBytes: string, context: string, time: string): Packet {
  const bytes = rawBytes.split(/\s+/)
  const packetType = bytes[0]?.toUpperCase() || '??'

  // Determine packet type and create summary
  let type = 'TX'
  let summary = ''
  const details: string[] = []

  // Parse based on first byte (packet type)
  if (packetType === '81' || packetType === '82' || packetType === '83') {
    type = 'LEVEL'
    // Extract device IDs from bytes 2-5 (source) and 9-12 (target)
    if (bytes.length >= 13) {
      const sourceId = `${bytes[5]}${bytes[4]}${bytes[3]}${bytes[2]}`.toUpperCase()
      const targetId = `${bytes[9]}${bytes[10]}${bytes[11]}${bytes[12]}`.toUpperCase()
      // Extract level from bytes 16-17
      if (bytes.length >= 18) {
        const levelRaw = parseInt(bytes[16] + bytes[17], 16)
        const level = levelRaw === 0 ? 0 : Math.round((levelRaw * 100) / 65279)
        summary = `${sourceId} -> ${targetId}`
        details.push(`Level=${level}%`)
      } else {
        summary = `${sourceId} -> ${targetId}`
      }
    }
  } else if (packetType === 'B9' || packetType === 'BA' || packetType === 'BB') {
    type = `PAIR_${packetType}`
    if (bytes.length >= 6) {
      const deviceId = `${bytes[5]}${bytes[4]}${bytes[3]}${bytes[2]}`.toUpperCase()
      summary = deviceId
      details.push(`Seq=${parseInt(bytes[1], 16)}`)
    }
  } else if (packetType === '92' || packetType === '91' || packetType === '93') {
    type = 'BEACON'
    if (bytes.length >= 6) {
      const deviceId = `${bytes[5]}${bytes[4]}${bytes[3]}${bytes[2]}`.toUpperCase()
      summary = deviceId
      details.push(`Type=0x${packetType}`)
    }
  } else if (packetType === '04' || packetType === '05' || packetType === '06' ||
             packetType === '02' || packetType === '03') {
    type = 'BUTTON'
    const btnNames: Record<string, string> = { '02': 'ON', '03': 'FAV', '04': 'OFF', '05': 'RAISE', '06': 'LOWER' }
    if (bytes.length >= 6) {
      const deviceId = `${bytes[5]}${bytes[4]}${bytes[3]}${bytes[2]}`.toUpperCase()
      summary = deviceId
      details.push(btnNames[packetType] || `Btn=0x${packetType}`)
    }
  } else if (packetType === '89') {
    type = 'RESET'
    if (bytes.length >= 6) {
      const deviceId = `${bytes[5]}${bytes[4]}${bytes[3]}${bytes[2]}`.toUpperCase()
      summary = deviceId
    }
  } else {
    // Unknown type, use context if available
    type = context || 'TX'
    summary = `0x${packetType}`
  }

  // Add context from "===" markers if we have it
  if (context && !type.includes(context.split(' ')[0])) {
    details.unshift(context)
  }

  return {
    time,
    type,
    summary: summary || rawBytes.substring(0, 30) + '...',
    details,
    rawBytes,
    direction: 'tx'
  }
}

function parseRxPacket(pktType: string, rest: string, time: string, fullMsg: string): Packet {
  const parts = rest.split('|').map(s => s.trim())
  const details = parts.slice(1).filter(p => p && !p.startsWith('RSSI') && !p.startsWith('CRC'))

  // Extract RSSI if present
  const rssiMatch = fullMsg.match(/RSSI=(-?\d+)/)
  if (rssiMatch) {
    details.push(`RSSI=${rssiMatch[1]}`)
  }

  // Extract raw bytes if present
  let rawBytes: string | undefined
  const bytesMatch = fullMsg.match(/Bytes:\s*([A-F0-9]{2}(?:\s+[A-F0-9]{2})+)/i)
  if (bytesMatch) {
    rawBytes = bytesMatch[1]
  }

  return {
    time,
    type: pktType,
    summary: parts[0] || '',
    details,
    rawBytes,
    direction: 'rx'
  }
}

