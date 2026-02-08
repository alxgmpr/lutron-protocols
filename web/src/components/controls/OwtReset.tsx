import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function OwtReset({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('05851117')

  const handleReset = async () => {
    showStatus(`Sending reset for ${deviceId}...`)
    try {
      const result = await post('/api/reset', { pico: '0x' + deviceId.replace(/^0x/i, '') })
      if (result.status === 'ok') {
        showStatus(`Reset broadcast sent`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="OWT Reset" storageKey="ctrl-owt-reset">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">device:</span>
        <Input
          value={deviceId}
          onChange={e => setDeviceId(e.target.value.replace(/^0x/i, ''))}
          className="w-[100px]"
        />
        <Button variant="red" onClick={handleReset}>
          <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1.5 2v3h3"/><path d="M2 5a4 4 0 1 1 .5 3"/></svg>
          Reset
        </Button>
      </div>
    </ControlSection>
  )
}
