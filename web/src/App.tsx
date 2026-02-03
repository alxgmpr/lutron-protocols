import { useState, useCallback } from 'react'
import { usePacketStream } from './hooks/usePacketStream'
import { DeviceProvider } from './context/DeviceContext'
import { ProtocolDefinitionProvider } from './context/ProtocolDefinitionContext'

// Layout
import { Header, StatusBar } from './components/layout'

// Controls
import {
  ControlsPanel,
  PicoPairing,
  PicoButtons,
  SaveFavorite,
  BridgeLevel,
  BridgeUnpair,
  BridgePairing,
  VivePairing,
  ViveControl,
  DeviceState,
  DeviceConfig,
  ResetPico
} from './components/controls'

// Display
import { HexPacketDisplay } from './components/display'

import type { Device } from './types'
import './App.css'

function App() {
  // Packet stream from backend (parsed packets via SSE)
  const {
    txPackets, rxPackets,
    clearTx, clearRx,
    pausedTx, pausedRx,
    togglePauseTx, togglePauseRx,
    connected
  } = usePacketStream()

  const [devices] = useState<Record<string, Device>>({})
  const [status, setStatus] = useState<{ message: string; type: 'success' | 'error' | '' }>({ message: 'Ready', type: '' })

  const showStatus = useCallback((message: string, type: 'success' | 'error' | '' = '') => {
    setStatus({ message, type })
  }, [])

  return (
    <ProtocolDefinitionProvider>
    <DeviceProvider devices={devices}>
    <div className="app">
      <Header connected={connected} />

      <main className="main-layout">
        {/* Packet displays on top */}
        <section className="packets-section">
          <HexPacketDisplay
            title="RX Packets"
            packets={rxPackets}
            onClear={clearRx}
            variant="rx"
            paused={pausedRx}
            onTogglePause={togglePauseRx}
            collapsible
            storageKey="cca-rx-collapsed"
          />
          <HexPacketDisplay
            title="TX Packets"
            packets={txPackets}
            onClear={clearTx}
            variant="tx"
            paused={pausedTx}
            onTogglePause={togglePauseTx}
            collapsible
            defaultCollapsed
            storageKey="cca-tx-collapsed"
          />
        </section>

        {/* Controls on bottom */}
        <section className="controls-section">
          <ControlsPanel showStatus={showStatus}>
            <PicoButtons showStatus={showStatus} />
            <BridgeLevel showStatus={showStatus} />
            <PicoPairing showStatus={showStatus} />
            <BridgePairing showStatus={showStatus} />
            <VivePairing showStatus={showStatus} />
            <ViveControl showStatus={showStatus} />
            <SaveFavorite showStatus={showStatus} />
            <DeviceConfig showStatus={showStatus} />
            <BridgeUnpair showStatus={showStatus} />
            <DeviceState showStatus={showStatus} />
            <ResetPico showStatus={showStatus} />
          </ControlsPanel>
        </section>
      </main>

      <StatusBar message={status.message} type={status.type} />
    </div>
    </DeviceProvider>
    </ProtocolDefinitionProvider>
  )
}

export default App
