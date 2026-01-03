import './Header.css'

interface HeaderProps {
  connected: boolean
  espHost?: string
}

export function Header({ connected, espHost = '10.1.4.59' }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <h1 className="header-title">
          <span className="header-logo">⚡</span>
          CCA Playground
        </h1>
        <span className="header-subtitle">Lutron Clear Connect Type A</span>
      </div>
      <div className="header-right">
        <span className={`status-indicator ${connected ? 'online' : 'offline'}`} />
        <span className="status-text">ESP32 @ {espHost}</span>
      </div>
    </header>
  )
}

