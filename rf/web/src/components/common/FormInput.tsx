import { ChangeEvent } from 'react'
import './FormInput.css'

interface FormInputProps {
  value: string | number
  onChange: (value: string) => void
  type?: 'text' | 'number'
  placeholder?: string
  width?: number | string
  min?: number
  max?: number
  className?: string
}

export function FormInput({
  value,
  onChange,
  type = 'text',
  placeholder,
  width,
  min,
  max,
  className = ''
}: FormInputProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
  }

  const style = width !== undefined 
    ? { width: typeof width === 'number' ? `${width}px` : width }
    : undefined

  return (
    <input
      type={type}
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      min={min}
      max={max}
      style={style}
      className={`form-input ${className}`}
    />
  )
}

