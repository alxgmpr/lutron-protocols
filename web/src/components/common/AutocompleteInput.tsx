import { useState, useRef, useEffect, ChangeEvent, KeyboardEvent } from 'react'
import './AutocompleteInput.css'

interface AutocompleteInputProps {
  value: string
  onChange: (value: string) => void
  suggestions: string[]
  placeholder?: string
  width?: number | string
  prefix?: string
  disabled?: boolean
  className?: string
}

export function AutocompleteInput({
  value,
  onChange,
  suggestions,
  placeholder,
  width,
  prefix,
  disabled = false,
  className = ''
}: AutocompleteInputProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Strip prefix from displayed value
  const displayValue = prefix && typeof value === 'string' && value.startsWith(prefix)
    ? value.slice(prefix.length)
    : value

  // Filter suggestions based on input (case-insensitive)
  const filteredSuggestions = suggestions.filter(s =>
    s.toUpperCase().includes(displayValue.toUpperCase())
  )

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newValue = prefix ? prefix + e.target.value : e.target.value
    onChange(newValue)
    setIsOpen(true)
    setHighlightedIndex(-1)
  }

  const handleSelect = (suggestion: string) => {
    const newValue = prefix ? prefix + suggestion : suggestion
    onChange(newValue)
    setIsOpen(false)
    setHighlightedIndex(-1)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || filteredSuggestions.length === 0) {
      if (e.key === 'ArrowDown' && filteredSuggestions.length > 0) {
        setIsOpen(true)
        setHighlightedIndex(0)
        e.preventDefault()
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex(prev =>
          prev < filteredSuggestions.length - 1 ? prev + 1 : 0
        )
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex(prev =>
          prev > 0 ? prev - 1 : filteredSuggestions.length - 1
        )
        break
      case 'Enter':
        e.preventDefault()
        if (highlightedIndex >= 0 && highlightedIndex < filteredSuggestions.length) {
          handleSelect(filteredSuggestions[highlightedIndex])
        }
        break
      case 'Escape':
        setIsOpen(false)
        setHighlightedIndex(-1)
        break
    }
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setHighlightedIndex(-1)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const style = width !== undefined
    ? { width: typeof width === 'number' ? `${width}px` : width }
    : undefined

  return (
    <div className="autocomplete-wrapper" ref={wrapperRef} style={style}>
      <div className={`form-input-with-prefix ${disabled ? 'disabled' : ''}`}>
        {prefix && <span className="form-input-prefix">{prefix}</span>}
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => filteredSuggestions.length > 0 && setIsOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          className={`form-input ${prefix ? 'form-input-prefixed' : ''} ${className}`}
        />
      </div>
      {isOpen && filteredSuggestions.length > 0 && (
        <ul className="autocomplete-dropdown">
          {filteredSuggestions.map((suggestion, index) => (
            <li
              key={suggestion}
              className={`autocomplete-item ${index === highlightedIndex ? 'highlighted' : ''}`}
              onClick={() => handleSelect(suggestion)}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              {prefix && <span className="autocomplete-prefix">{prefix}</span>}
              {suggestion}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
