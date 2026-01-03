import { useEffect, useRef, useState, useCallback } from 'react'
import type { Packet } from '../types'

const MAX_PACKETS = 500

interface BackendPacket {
  direction: 'rx' | 'tx'
  type: string
  time: string
  device_id?: string
  source_id?: string
  target_id?: string
  summary?: string
  details?: Record<string, string>
  raw_hex?: string
  rssi?: number
}

export function usePacketStream() {
  const [txPackets, setTxPackets] = useState<Packet[]>([])
  const [rxPackets, setRxPackets] = useState<Packet[]>([])
  const [connected, setConnected] = useState(false)

  // Pause states
  const [pausedTx, setPausedTx] = useState(false)
  const [pausedRx, setPausedRx] = useState(false)

  // Snapshots for paused views
  const [txSnapshot, setTxSnapshot] = useState<Packet[]>([])
  const [rxSnapshot, setRxSnapshot] = useState<Packet[]>([])

  const eventSourceRef = useRef<EventSource | null>(null)

  // Pause toggle functions
  const togglePauseTx = useCallback(() => {
    setPausedTx(prev => {
      if (!prev) setTxSnapshot(txPackets)
      return !prev
    })
  }, [txPackets])

  const togglePauseRx = useCallback(() => {
    setPausedRx(prev => {
      if (!prev) setRxSnapshot(rxPackets)
      return !prev
    })
  }, [rxPackets])

  const togglePauseAll = useCallback(() => {
    const allPaused = pausedTx && pausedRx
    if (allPaused) {
      setPausedTx(false)
      setPausedRx(false)
    } else {
      setTxSnapshot(txPackets)
      setRxSnapshot(rxPackets)
      setPausedTx(true)
      setPausedRx(true)
    }
  }, [pausedTx, pausedRx, txPackets, rxPackets])

  const clearTx = useCallback(() => {
    setTxPackets([])
    setTxSnapshot([])
  }, [])

  const clearRx = useCallback(() => {
    setRxPackets([])
    setRxSnapshot([])
  }, [])

  const clearAll = useCallback(() => {
    setTxPackets([])
    setRxPackets([])
    setTxSnapshot([])
    setRxSnapshot([])
  }, [])

  useEffect(() => {
    const connect = () => {
      const eventSource = new EventSource('/api/packets/stream')
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        setConnected(true)
      }

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data) as BackendPacket | { type: 'heartbeat' | 'connected' }

        if ('type' in data && (data.type === 'heartbeat' || data.type === 'connected')) {
          return
        }

        const pkt = data as BackendPacket

        // Convert backend packet to frontend Packet format
        const packet: Packet = {
          time: pkt.time,
          type: pkt.type,
          summary: pkt.summary || pkt.device_id || '',
          details: formatDetails(pkt.details, pkt.rssi),
          rawBytes: pkt.raw_hex,
          direction: pkt.direction
        }

        if (pkt.direction === 'tx') {
          setTxPackets(prev => [...prev.slice(-(MAX_PACKETS - 1)), packet])
        } else {
          setRxPackets(prev => [...prev.slice(-(MAX_PACKETS - 1)), packet])
        }
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

  const allPaused = pausedTx && pausedRx

  return {
    txPackets: pausedTx ? txSnapshot : txPackets,
    rxPackets: pausedRx ? rxSnapshot : rxPackets,
    connected,
    clearTx,
    clearRx,
    clearAll,
    pausedTx,
    pausedRx,
    allPaused,
    togglePauseTx,
    togglePauseRx,
    togglePauseAll
  }
}

function formatDetails(details?: Record<string, string>, rssi?: number): string[] {
  const result: string[] = []

  if (details) {
    for (const [key, value] of Object.entries(details)) {
      if (key === 'button') {
        result.push(value)
      } else if (key === 'level') {
        result.push(`Level=${value}%`)
      } else if (key === 'seq') {
        result.push(`Seq=${value}`)
      } else {
        result.push(`${key}=${value}`)
      }
    }
  }

  if (rssi !== null && rssi !== undefined) {
    result.push(`RSSI=${rssi}`)
  }

  return result
}
