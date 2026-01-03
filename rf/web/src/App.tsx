import { useState, useEffect, useCallback } from 'react'
import { useApi } from './hooks/useApi'
import { useLogStream } from './hooks/useLogStream'
import { usePacketStream } from './hooks/usePacketStream'

// Layout
import { Header, StatusBar } from './components/layout'

// Controls
import {
  PicoPairing,
  PicoButtons,
  SaveFavorite,
  BridgeLevel,
  BridgeBeacon,
  DeviceState,
  ResetPico
} from './components/controls'

// Display
import { PacketDisplay, LogDisplay } from './components/display'

// Devices
import { DeviceList } from './components/devices'

import type { Device } from './types'
import './App.css'

function App() {
  const { get, postJson, del } = useApi()

  // Packet stream from backend (parsed packets via SSE)
  const {
    txPackets, rxPackets,
    clearTx, clearRx, clearAll: clearAllPackets,
    pausedTx, pausedRx, allPaused: allPacketsPaused,
    togglePauseTx, togglePauseRx, togglePauseAll: togglePauseAllPackets,
    connected
  } = usePacketStream()

  // Log stream from backend (raw logs for debugging)
  const {
    logs,
    clearLogs,
    pausedLogs,
    togglePauseLogs
  } = useLogStream()

  const [devices, setDevices] = useState<Record<string, Device>>({})
  const [status, setStatus] = useState<{ message: string; type: 'success' | 'error' | '' }>({ message: 'Ready', type: '' })

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

  const registerDevice = useCallback(async (deviceId: string, type: string, info: Record<string, unknown>) => {
    await postJson('/api/devices', { device_id: deviceId, type, info })
    loadDevices()
  }, [postJson, loadDevices])

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

  // Auto-register devices from RX packets
  // Uses new Packet interface with type, summary, details
  useEffect(() => {
    rxPackets.slice(-1).forEach(packet => {
      const pktType = packet.type

      // Only process known packet types
      const validTypes = ['BTN_SHORT_A', 'BTN_LONG_A', 'BTN_SHORT_B', 'BTN_LONG_B',
                          'LEVEL', 'STATE_RPT', 'PAIR_B8', 'PAIR_B9', 'PAIR_BA', 'PAIR_BB', 'BEACON']
      if (!validTypes.some(t => pktType.startsWith(t))) return

      let deviceId: string | null = null
      const info: Record<string, unknown> = { type: pktType }

      // Parse summary which contains device ID(s)
      const summary = packet.summary

      if (pktType === 'LEVEL' && summary.includes('->')) {
        const ids = summary.split('->').map(s => s.trim())
        deviceId = ids[1]
        info.bridge_id = ids[0]
        info.factory_id = ids[1]
        info.category = 'bridge_controlled'
        info.controllable = true
      } else if (pktType === 'STATE_RPT') {
        deviceId = summary.trim()
        info.rf_tx_id = deviceId
        info.category = 'dimmer_passive'
        info.controllable = false
        // Extract bridge pairing from device ID (middle 16 bits)
        // This helps identify which bridge controls this device
        if (deviceId && /^[0-9A-Fa-f]{8}$/.test(deviceId)) {
          const idNum = parseInt(deviceId, 16)
          const bridgePairing = (idNum >> 8) & 0xFFFF
          info.bridge_pairing = bridgePairing.toString(16).toUpperCase().padStart(4, '0')
        }
      } else if (pktType.startsWith('BTN_')) {
        deviceId = summary.trim()
        info.factory_id = deviceId
        info.controllable = true
      } else {
        deviceId = summary.trim()
      }

      // Parse details array
      for (const detail of packet.details) {
        if (detail.startsWith('SCENE')) {
          info.button = detail
          info.category = 'scene_pico'
        } else if (detail.match(/^(ON|OFF|RAISE|LOWER|FAV)/)) {
          info.button = detail
          info.category = 'pico'
        } else if (detail.startsWith('Level=')) {
          info.level = detail.replace('Level=', '')
        }
      }

      // Device ID must be exactly 8 hex characters
      if (deviceId && /^[0-9A-Fa-f]{8}$/.test(deviceId)) {
        registerDevice(deviceId, pktType, info)
      }
    })
  }, [rxPackets, registerDevice])

  return (
    <div className="app">
      <Header connected={connected} />
      
      <main className="main-grid">
        <section className="panel left-panel">
          <PicoPairing showStatus={showStatus} />
          <PicoButtons showStatus={showStatus} />
          <SaveFavorite showStatus={showStatus} />
          <BridgeLevel showStatus={showStatus} />
          <BridgeBeacon showStatus={showStatus} />
          <DeviceState showStatus={showStatus} />
          <ResetPico showStatus={showStatus} />
        </section>

        <section className="panel center-panel">
          <div className="center-panel-header">
            <h2>Log Monitor</h2>
            <div className="center-panel-actions">
              <button
                className={`pause-all-btn ${allPacketsPaused && pausedLogs ? 'paused' : ''}`}
                onClick={() => { togglePauseAllPackets(); togglePauseLogs(); }}
              >
                {allPacketsPaused && pausedLogs ? 'Resume All' : 'Pause All'}
              </button>
              <button className="clear-all-btn" onClick={() => { clearAllPackets(); clearLogs(); }}>Clear All</button>
            </div>
          </div>
          <PacketDisplay
            title="TX Packets"
            packets={txPackets}
            onClear={clearTx}
            variant="tx"
            paused={pausedTx}
            onTogglePause={togglePauseTx}
          />
          <PacketDisplay
            title="RX Packets"
            packets={rxPackets}
            onClear={clearRx}
            variant="rx"
            paused={pausedRx}
            onTogglePause={togglePauseRx}
          />
          <LogDisplay
            logs={logs}
            onClear={clearLogs}
            paused={pausedLogs}
            onTogglePause={togglePauseLogs}
          />
        </section>

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
  )
}

export default App
