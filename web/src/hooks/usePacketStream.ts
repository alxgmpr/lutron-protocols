import { useEffect, useRef, useState, useCallback } from 'react'
import type { Packet, ParsedField } from '../types'

const MAX_PACKETS = 10000

interface BackendPacket {
  direction: 'rx' | 'tx'
  type: string
  time: string
  device_id?: string
  source_id?: string
  target_id?: string
  summary?: string
  details?: Record<string, string | boolean>  // crc_ok can be boolean
  raw_hex?: string
  rssi?: number
  fields?: ParsedField[]  // Backend-parsed field breakdown
}

export function usePacketStream() {
  const [txPackets, setTxPackets] = useState<Packet[]>([])
  const [rxPackets, setRxPackets] = useState<Packet[]>([])
  const [allPackets, setAllPackets] = useState<Packet[]>([])
  const [connected, setConnected] = useState(false)
  const [lastHeartbeat, setLastHeartbeat] = useState<number | null>(null)

  // Pause states
  const [pausedTx, setPausedTx] = useState(false)
  const [pausedRx, setPausedRx] = useState(false)
  const [paused, setPaused] = useState(false)

  // Snapshots for paused views
  const [txSnapshot, setTxSnapshot] = useState<Packet[]>([])
  const [rxSnapshot, setRxSnapshot] = useState<Packet[]>([])
  const [allSnapshot, setAllSnapshot] = useState<Packet[]>([])

  const eventSourceRef = useRef<EventSource | null>(null)

  // Unified pause toggle
  const togglePause = useCallback(() => {
    setPaused(prev => {
      if (!prev) setAllSnapshot(allPackets)
      return !prev
    })
  }, [allPackets])

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
    setAllPackets([])
    setTxSnapshot([])
    setRxSnapshot([])
    setAllSnapshot([])
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

        if ('type' in data && data.type === 'heartbeat') {
          setLastHeartbeat(Date.now())
          return
        }
        if ('type' in data && data.type === 'connected') {
          return
        }

        const pkt = data as BackendPacket

        // Convert backend packet to frontend Packet format
        // Extract crc_ok before formatting details (it's sent as string from backend)
        const crcOk = pkt.details?.crc_ok === undefined ? undefined :
                      pkt.details.crc_ok === 'true' || pkt.details.crc_ok === true

        const packet: Packet = {
          time: pkt.time,
          type: pkt.type,
          summary: pkt.summary || pkt.device_id || '',
          details: formatDetails(pkt.details, pkt.rssi),
          rawBytes: pkt.raw_hex,
          direction: pkt.direction,
          fields: pkt.fields,  // Pass through backend-parsed fields
          crcOk  // CRC validation status for RX packets
        }

        if (pkt.direction === 'tx') {
          setTxPackets(prev => [...prev.slice(-(MAX_PACKETS - 1)), packet])
        } else {
          // Filter out bad CRC packets - they're likely corrupted
          if (packet.crcOk === false) {
            return
          }
          setRxPackets(prev => [...prev.slice(-(MAX_PACKETS - 1)), packet])
        }

        // Always add to combined stream
        setAllPackets(prev => [...prev.slice(-(MAX_PACKETS - 1)), packet])
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
    allPackets: paused ? allSnapshot : allPackets,
    connected,
    lastHeartbeat,
    clearTx,
    clearRx,
    clearAll,
    pausedTx,
    pausedRx,
    paused,
    allPaused,
    togglePauseTx,
    togglePauseRx,
    togglePauseAll,
    togglePause
  }
}

function formatDetails(details?: Record<string, string | boolean>, rssi?: number): string[] {
  const result: string[] = []

  if (details) {
    for (const [key, value] of Object.entries(details)) {
      // Skip crc_ok - it's shown as an icon, not in details
      if (key === 'crc_ok') continue

      if (key === 'button') {
        result.push(String(value))
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
