import { ChangeEvent, ReactNode } from 'react'
import './FormSelect.css'

interface FormSelectProps {
  value: string
  onChange: (value: string) => void
  children: ReactNode
  width?: number | string
  className?: string
}

export function FormSelect({
  value,
  onChange,
  children,
  width,
  className = ''
}: FormSelectProps) {
  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    onChange(e.target.value)
  }

  const style = width !== undefined 
    ? { width: typeof width === 'number' ? `${width}px` : width }
    : undefined

  return (
    <select
      value={value}
      onChange={handleChange}
      style={style}
      className={`form-select ${className}`}
    >
      {children}
    </select>
  )
}



