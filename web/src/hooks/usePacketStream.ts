import { useEffect, useRef, useState, useCallback } from 'react'
import type { Packet, ParsedField } from '../types'

const MAX_PACKETS = 10000
const FLUSH_INTERVAL_MS = 250

interface BackendPacket {
  direction: 'rx' | 'tx'
  protocol?: 'cca' | 'ccx'
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
  seq?: number            // Sequence number (CCX)
  type_num?: number       // Numeric message type (CCX)
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

  // Batch buffer — packets accumulate here and flush to state on interval
  const batchRef = useRef<{ tx: Packet[]; rx: Packet[]; all: Packet[] }>({
    tx: [], rx: [], all: []
  })

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
    batchRef.current.tx = []
  }, [])

  const clearRx = useCallback(() => {
    setRxPackets([])
    setRxSnapshot([])
    batchRef.current.rx = []
  }, [])

  const clearAll = useCallback(() => {
    setTxPackets([])
    setRxPackets([])
    setAllPackets([])
    setTxSnapshot([])
    setRxSnapshot([])
    setAllSnapshot([])
    batchRef.current = { tx: [], rx: [], all: [] }
  }, [])

  useEffect(() => {
    // Flush batched packets to state on interval
    const flushInterval = setInterval(() => {
      const batch = batchRef.current
      if (batch.all.length === 0) return

      const newTx = batch.tx
      const newRx = batch.rx
      const newAll = batch.all
      batchRef.current = { tx: [], rx: [], all: [] }

      if (newTx.length > 0) {
        setTxPackets(prev => [...prev, ...newTx].slice(-MAX_PACKETS))
      }
      if (newRx.length > 0) {
        setRxPackets(prev => [...prev, ...newRx].slice(-MAX_PACKETS))
      }
      setAllPackets(prev => [...prev, ...newAll].sort((a, b) => a.time.localeCompare(b.time)).slice(-MAX_PACKETS))
    }, FLUSH_INTERVAL_MS)

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
        const crcOk = pkt.details?.crc_ok === undefined ? undefined :
                      pkt.details.crc_ok === 'true' || pkt.details.crc_ok === true

        const packet: Packet = {
          time: pkt.time,
          protocol: pkt.protocol ?? 'cca',
          type: pkt.type,
          summary: pkt.summary || pkt.device_id || '',
          details: formatDetails(pkt.details, pkt.rssi),
          rawBytes: pkt.raw_hex,
          direction: pkt.direction,
          fields: pkt.fields,
          crcOk,
          seq: pkt.seq,
          typeNum: pkt.type_num,
        }

        // Filter out bad CRC packets
        if (packet.crcOk === false) return

        // Push into batch buffer (no state update, no re-render)
        if (pkt.direction === 'tx') {
          batchRef.current.tx.push(packet)
        } else {
          batchRef.current.rx.push(packet)
        }
        batchRef.current.all.push(packet)
      }

      eventSource.onerror = () => {
        setConnected(false)
        eventSource.close()
        setTimeout(connect, 2000)
      }
    }

    connect()

    return () => {
      clearInterval(flushInterval)
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
