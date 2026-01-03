import { ReactNode } from 'react'
import './Card.css'

interface CardProps {
  title: string
  badge?: string
  variant?: 'default' | 'pico' | 'bridge' | 'pairing' | 'device' | 'tx' | 'rx' | 'logs'
  actions?: ReactNode
  children: ReactNode
  className?: string
}

export function Card({ title, badge, variant = 'default', actions, children, className = '' }: CardProps) {
  return (
    <div className={`card card-${variant} ${className}`}>
      <div className="card-header">
        <div className="card-header-left">
          <h2 className="card-title">{title}</h2>
          {badge && <span className="card-badge">{badge}</span>}
        </div>
        {actions && <div className="card-actions">{actions}</div>}
      </div>
      <div className="card-body">
        {children}
      </div>
    </div>
  )
}

