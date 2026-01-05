import { ReactNode, useState } from 'react'
import './Card.css'

interface CardProps {
  title: string
  badge?: string
  variant?: 'default' | 'pico' | 'bridge' | 'pairing' | 'device' | 'tx' | 'rx' | 'logs'
  actions?: ReactNode
  children: ReactNode
  className?: string
  collapsible?: boolean
  defaultCollapsed?: boolean
}

export function Card({
  title,
  badge,
  variant = 'default',
  actions,
  children,
  className = '',
  collapsible = false,
  defaultCollapsed = false
}: CardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <div className={`card card-${variant} ${className} ${collapsed ? 'card-collapsed' : ''}`}>
      <div className="card-header" onClick={collapsible ? () => setCollapsed(!collapsed) : undefined}>
        <div className="card-header-left">
          {collapsible && (
            <span className={`card-collapse-icon ${collapsed ? 'collapsed' : ''}`}>
              {collapsed ? '+' : '-'}
            </span>
          )}
          <h2 className="card-title">{title}</h2>
          {badge && <span className="card-badge">{badge}</span>}
          {collapsed && <span className="card-collapsed-hint">click to expand</span>}
        </div>
        {actions && !collapsed && <div className="card-actions">{actions}</div>}
      </div>
      {!collapsed && (
        <div className="card-body">
          {children}
        </div>
      )}
    </div>
  )
}

