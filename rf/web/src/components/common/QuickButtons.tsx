import { ReactNode } from 'react'
import './QuickButtons.css'

interface QuickButtonsProps {
  children: ReactNode
  className?: string
}

export function QuickButtons({ children, className = '' }: QuickButtonsProps) {
  return (
    <div className={`quick-buttons ${className}`}>
      {children}
    </div>
  )
}

interface QuickButtonDividerProps {
  char?: string
}

export function QuickButtonDivider({ char = '|' }: QuickButtonDividerProps) {
  return <span className="quick-button-divider">{char}</span>
}


