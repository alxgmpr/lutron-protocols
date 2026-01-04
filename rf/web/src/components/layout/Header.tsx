import { useState, useEffect } from 'react'
import { ConnectionModal } from './ConnectionModal'
import './Header.css'

interface HeaderProps {
  connected: boolean
}

export function Header({ connected }: HeaderProps) {
  const [showModal, setShowModal] = useState(false)
  const [espHost, setEspHost] = useState('...')

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await fetch('/api/esp/config')
        const data = await response.json()
        setEspHost(data.host)
      } catch {
        // ignore
      }
    }
    fetchConfig()
    const interval = setInterval(fetchConfig, 10000)
    return () => clearInterval(interval)
  }, [])

  return (
    <>
      <header className="header">
        <div className="header-left">
          <h1 className="header-title">
            CCA Playground
          </h1>
          <span className="header-subtitle">Lutron Clear Connect Type A</span>
        </div>
        <div className="header-right" onClick={() => setShowModal(true)}>
          <span className={`status-indicator ${connected ? 'online' : 'offline'}`} />
          <span className="status-text">ESP32 @ {espHost}</span>
        </div>
      </header>

      {showModal && (
        <ConnectionModal onClose={() => setShowModal(false)} />
      )}
    </>
  )
}

