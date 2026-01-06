import './StatusBar.css'

interface StatusBarProps {
  message: string
  type: 'success' | 'error' | ''
}

export function StatusBar({ message, type }: StatusBarProps) {
  return (
    <div className={`status-bar ${type}`}>
      {message}
    </div>
  )
}



