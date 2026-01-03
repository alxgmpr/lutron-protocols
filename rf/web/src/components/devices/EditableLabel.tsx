import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import './EditableLabel.css'

interface EditableLabelProps {
  value: string
  placeholder?: string
  onSave: (value: string) => void
  className?: string
}

export function EditableLabel({ value, placeholder = 'unnamed', onSave, className = '' }: EditableLabelProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleStartEdit = () => {
    setEditValue(value)
    setIsEditing(true)
  }

  const handleSave = () => {
    setIsEditing(false)
    if (editValue !== value) {
      onSave(editValue)
    }
  }

  const handleCancel = () => {
    setIsEditing(false)
    setEditValue(value)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSave()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }

  if (isEditing) {
    return (
      <div className={`editable-label editing ${className}`}>
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="editable-label-input"
        />
      </div>
    )
  }

  return (
    <div 
      className={`editable-label ${className} ${!value ? 'empty' : ''}`}
      onClick={handleStartEdit}
      title="Click to edit"
    >
      {value || <span className="editable-label-placeholder">{placeholder}</span>}
    </div>
  )
}

