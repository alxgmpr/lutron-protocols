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
  prefix?: string
}

export function FormInput({
  value,
  onChange,
  type = 'text',
  placeholder,
  width,
  min,
  max,
  className = '',
  prefix
}: FormInputProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(prefix ? prefix + e.target.value : e.target.value)
  }

  // Strip prefix from displayed value
  const displayValue = prefix && typeof value === 'string' && value.startsWith(prefix)
    ? value.slice(prefix.length)
    : value

  const style = width !== undefined
    ? { width: typeof width === 'number' ? `${width}px` : width }
    : undefined

  if (prefix) {
    return (
      <div className="form-input-with-prefix" style={style}>
        <span className="form-input-prefix">{prefix}</span>
        <input
          type={type}
          value={displayValue}
          onChange={handleChange}
          placeholder={placeholder}
          min={min}
          max={max}
          className={`form-input form-input-prefixed ${className}`}
        />
      </div>
    )
  }

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

