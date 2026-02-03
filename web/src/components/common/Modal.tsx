import { useEffect, ReactNode } from 'react'
import './Modal.css'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  large?: boolean
}

export function Modal({ title, onClose, children, footer, large }: ModalProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-content ${large ? 'modal-content-large' : ''}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {children}
        </div>
        {footer && (
          <div className="modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
