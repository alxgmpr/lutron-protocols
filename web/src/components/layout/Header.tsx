import { useState, useEffect } from 'react'
import { ConfigModal } from './ConfigModal'
import { ProtocolGuide, DeviceReference } from '../docs'
import './Header.css'

interface HeaderProps {
  connected: boolean
}

export function Header({ connected }: HeaderProps) {
  const [showModal, setShowModal] = useState(false)
  const [showProtocolGuide, setShowProtocolGuide] = useState(false)
  const [showDeviceReference, setShowDeviceReference] = useState(false)
  const [espHost, setEspHost] = useState('...')

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await fetch('/api/esp/config')
        if (response.ok) {
          const data = await response.json()
          setEspHost(data.host)
        }
      } catch {
        // ignore - backend may not be running
      }
    }
    fetchConfig()
    const interval = setInterval(fetchConfig, 5000)
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
        <div className="header-center">
          <button className="header-nav-btn" onClick={() => setShowProtocolGuide(true)}>
            Protocol Guide
          </button>
          <button className="header-nav-btn" onClick={() => setShowDeviceReference(true)}>
            Device Reference
          </button>
        </div>
        <div className="header-right" onClick={() => setShowModal(true)}>
          <span className={`status-indicator ${connected ? 'online' : 'offline'}`} />
          <span className="status-text">ESP32 @ {espHost}</span>
        </div>
      </header>

      {showModal && (
        <ConfigModal onClose={() => setShowModal(false)} />
      )}

      {showProtocolGuide && (
        <div className="protocol-guide-modal" onClick={() => setShowProtocolGuide(false)}>
          <div className="protocol-guide-content" onClick={e => e.stopPropagation()}>
            <div className="modal-close-bar">
              <button className="modal-close-btn" onClick={() => setShowProtocolGuide(false)}>
                Close
              </button>
            </div>
            <ProtocolGuide />
          </div>
        </div>
      )}

      {showDeviceReference && (
        <div className="protocol-guide-modal" onClick={() => setShowDeviceReference(false)}>
          <div className="protocol-guide-content" onClick={e => e.stopPropagation()}>
            <div className="modal-close-bar">
              <button className="modal-close-btn" onClick={() => setShowDeviceReference(false)}>
                Close
              </button>
            </div>
            <DeviceReference />
          </div>
        </div>
      )}
    </>
  )
}



