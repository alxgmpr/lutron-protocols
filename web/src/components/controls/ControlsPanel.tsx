import { useState, ReactNode } from 'react'
import { Card } from '../common'
import './ControlPanel.css'

interface ControlsPanelProps {
  children: ReactNode
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function ControlsPanel({ children }: ControlsPanelProps) {
  return (
    <Card
      title="Controls"
      variant="default"
      collapsible
      defaultCollapsed
      storageKey="cca-controls-collapsed"
    >
      <div className="controls-grid">
        {children}
      </div>
    </Card>
  )
}

interface ControlSectionProps {
  title: string
  storageKey: string
  children: ReactNode
}

export function ControlSection({ title, storageKey, children }: ControlSectionProps) {
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(storageKey)
    return saved !== null ? saved === 'true' : true  // Default collapsed
  })

  const toggle = () => {
    const newValue = !collapsed
    setCollapsed(newValue)
    localStorage.setItem(storageKey, String(newValue))
  }

  return (
    <div className={`control-section ${collapsed ? 'collapsed' : ''}`}>
      <div className="control-section-header" onClick={toggle}>
        <span className="control-section-toggle">{collapsed ? '+' : '-'}</span>
        <span className="control-section-title">{title}</span>
      </div>
      {!collapsed && (
        <div className="control-section-body">
          {children}
        </div>
      )}
    </div>
  )
}
