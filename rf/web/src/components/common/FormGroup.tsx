import { ReactNode } from 'react'
import './FormGroup.css'

interface FormGroupProps {
  label: string
  children: ReactNode
  flex?: number | 'auto'
  className?: string
  hint?: string
}

export function FormGroup({ label, children, flex, className = '', hint }: FormGroupProps) {
  const style = flex !== undefined
    ? { flex: flex === 'auto' ? 1 : flex }
    : undefined

  return (
    <div className={`form-group ${className}`} style={style}>
      <label className="form-label">{label}</label>
      {children}
      {hint && <span className="form-hint">{hint}</span>}
    </div>
  )
}

