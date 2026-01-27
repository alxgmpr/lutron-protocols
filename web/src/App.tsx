import { useState, useEffect, useCallback, useRef } from 'react'
import { useApi } from './hooks/useApi'
import { usePacketStream } from './hooks/usePacketStream'
import { DeviceProvider } from './context/DeviceContext'
import { ProtocolDefinitionProvider } from './context/ProtocolDefinitionContext'

// Layout
import { Header, StatusBar } from './components/layout'

// Controls
import {
  PicoPairing,
  PicoButtons,
  SaveFavorite,
  BridgeLevel,
  BridgeUnpair,
  BridgePairing,
  DeviceState,
  DeviceConfig,
  ResetPico
} from './components/controls'

// Display
import { HexPacketDisplay } from './components/display'

// Devices
import { DeviceList } from './components/devices'

import type { Device } from './types'
import './App.css'

function App() {
  const { get, postJson, del } = useApi()

  // Packet stream from backend (parsed packets via SSE)
  const {
    txPackets, rxPackets,
    clearTx, clearRx,
    pausedTx, pausedRx,
    togglePauseTx, togglePauseRx,
    connected
  } = usePacketStream()

  const [devices, setDevices] = useState<Record<string, Device>>({})
  const [status, setStatus] = useState<{ message: string; type: 'success' | 'error' | '' }>({ message: 'Ready', type: '' })

  // Resizable column widths (stored in localStorage)
  const [leftWidth, setLeftWidth] = useState(() => {
    const saved = localStorage.getItem('cca-left-width')
    return saved ? parseInt(saved, 10) : 340
  })
  const [rightWidth, setRightWidth] = useState(() => {
    const saved = localStorage.getItem('cca-right-width')
    return saved ? parseInt(saved, 10) : 400
  })
  const resizingRef = useRef<'left' | 'right' | null>(null)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  // Handle resize drag
  const handleMouseDown = useCallback((side: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = side
    startXRef.current = e.clientX
    startWidthRef.current = side === 'left' ? leftWidth : rightWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [leftWidth, rightWidth])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      const delta = e.clientX - startXRef.current
      const newWidth = resizingRef.current === 'left'
        ? Math.max(280, Math.min(600, startWidthRef.current + delta))
        : Math.max(300, Math.min(700, startWidthRef.current - delta))
      if (resizingRef.current === 'left') {
        setLeftWidth(newWidth)
      } else {
        setRightWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      if (resizingRef.current) {
        // Save to localStorage
        if (resizingRef.current === 'left') {
          localStorage.setItem('cca-left-width', leftWidth.toString())
        } else {
          localStorage.setItem('cca-right-width', rightWidth.toString())
        }
        resizingRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [leftWidth, rightWidth])

  const loadDevices = useCallback(async () => {
    try {
      const data = await get<Record<string, Device>>('/api/devices')
      setDevices(data)
    } catch {
      // ignore
    }
  }, [get])

  useEffect(() => {
    loadDevices()
    const interval = setInterval(loadDevices, 10000)
    return () => clearInterval(interval)
  }, [loadDevices])

  const showStatus = useCallback((message: string, type: 'success' | 'error' | '' = '') => {
    setStatus({ message, type })
  }, [])

  const deleteDevice = useCallback(async (deviceId: string) => {
    await del(`/api/devices/${deviceId}`)
    loadDevices()
  }, [del, loadDevices])

  const clearDevices = useCallback(async () => {
    if (!confirm('Clear all discovered devices?')) return
    await postJson('/api/devices/clear', {})
    loadDevices()
    showStatus('All devices cleared', 'success')
  }, [postJson, loadDevices, showStatus])

  const clearUnlabeledDevices = useCallback(async () => {
    const unlabeledIds = Object.entries(devices)
      .filter(([, device]) => !device.label)
      .map(([id]) => id)

    if (unlabeledIds.length === 0) {
      showStatus('No unlabeled devices to clear', '')
      return
    }

    for (const id of unlabeledIds) {
      await del(`/api/devices/${id}`)
    }
    loadDevices()
    showStatus(`Cleared ${unlabeledIds.length} unlabeled device(s)`, 'success')
  }, [devices, del, loadDevices, showStatus])

  return (
    <ProtocolDefinitionProvider>
    <DeviceProvider devices={devices}>
    <div className="app">
      <Header connected={connected} />

      <main
        className="main-grid"
        style={{
          gridTemplateColumns: `${leftWidth}px 4px 1fr 4px ${rightWidth}px`
        }}
      >
        <section className="panel left-panel">
          <PicoPairing showStatus={showStatus} />
          <PicoButtons showStatus={showStatus} />
          <SaveFavorite showStatus={showStatus} />
          <BridgeLevel showStatus={showStatus} />
          <DeviceConfig showStatus={showStatus} />
          <BridgeUnpair showStatus={showStatus} />
          <BridgePairing showStatus={showStatus} />
          <DeviceState showStatus={showStatus} />
          <ResetPico showStatus={showStatus} />
        </section>

        <div
          className="resize-handle resize-handle-left"
          onMouseDown={(e) => handleMouseDown('left', e)}
        />

        <section className="panel center-panel">
          <div className="center-panel-header">
            <h2>Packet Monitor</h2>
          </div>
          <HexPacketDisplay
            title="TX Packets"
            packets={txPackets}
            onClear={clearTx}
            variant="tx"
            paused={pausedTx}
            onTogglePause={togglePauseTx}
            collapsible
          />
          <HexPacketDisplay
            title="RX Packets"
            packets={rxPackets}
            onClear={clearRx}
            variant="rx"
            paused={pausedRx}
            onTogglePause={togglePauseRx}
            collapsible
          />
        </section>

        <div
          className="resize-handle resize-handle-right"
          onMouseDown={(e) => handleMouseDown('right', e)}
        />

        <section className="panel right-panel">
          <DeviceList
            devices={devices}
            onDelete={deleteDevice}
            onClear={clearDevices}
            onClearUnlabeled={clearUnlabeledDevices}
            onRefresh={loadDevices}
            showStatus={showStatus}
          />
        </section>
      </main>

      <StatusBar message={status.message} type={status.type} />
    </div>
    </DeviceProvider>
    </ProtocolDefinitionProvider>
  )
}

export default App
