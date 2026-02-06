import { useState, ReactNode } from 'react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../ui/collapsible'

interface ControlSectionProps {
  title: string
  storageKey: string
  children: ReactNode
  defaultOpen?: boolean
}

export function ControlSection({ title, storageKey, children, defaultOpen }: ControlSectionProps) {
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(storageKey)
    if (saved !== null) return saved === 'true'
    return defaultOpen ?? false
  })

  const handleOpenChange = (value: boolean) => {
    setOpen(value)
    localStorage.setItem(storageKey, String(value))
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-2 cursor-pointer select-none hover:bg-[var(--bg-elevated)] transition-colors">
        <svg
          className={`size-2.5 text-[var(--text-muted)] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 10 10"
          fill="currentColor"
        >
          <path d="M3 1l5 4-5 4V1z" />
        </svg>
        <span className="font-mono text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div style={{ padding: '4px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
