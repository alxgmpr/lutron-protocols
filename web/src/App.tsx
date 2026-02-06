import { useState, useCallback } from 'react'
import { usePacketStream } from './hooks/usePacketStream'
import { DeviceProvider } from './context/DeviceContext'
import { ProtocolDefinitionProvider } from './context/ProtocolDefinitionContext'

import { Header, StatusBar } from './components/layout'
import { ControlTabs } from './components/controls'
import { PacketDataTable } from './components/display'

import type { Device } from './types'
import './App.css'

function App() {
  const {
    allPackets,
    paused, togglePause,
    clearAll,
    connected,
    lastHeartbeat
  } = usePacketStream()

  const [devices] = useState<Record<string, Device>>({})
  const [lastTx, setLastTx] = useState<{ message: string; type: 'success' | 'error' | '' }>({ message: 'Ready', type: '' })

  const showStatus = useCallback((message: string, type: 'success' | 'error' | '' = '') => {
    setLastTx({ message, type })
  }, [])

  return (
    <ProtocolDefinitionProvider>
      <DeviceProvider devices={devices}>
        <div className="app">
          <Header />

          <main className="main-layout">
            <section className="packets-section">
              <PacketDataTable
                packets={allPackets}
                paused={paused}
                onTogglePause={togglePause}
                onClear={clearAll}
              />
            </section>

            <section className="controls-section">
              <ControlTabs showStatus={showStatus} />
            </section>
          </main>

          <StatusBar connected={connected} lastTx={lastTx} lastHeartbeat={lastHeartbeat} />
        </div>
      </DeviceProvider>
    </ProtocolDefinitionProvider>
  )
}

export default App
