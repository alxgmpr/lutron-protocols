import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function DeviceState({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('8F902C08')
  const [level, setLevel] = useState(50)

  const handleSend = async () => {
    showStatus(`Reporting ${deviceId} at ${level}%...`)
    try {
      const result = await post('/api/state', {
        device: '0x' + deviceId.replace(/^0x/i, ''),
        level
      })
      if (result.status === 'ok') {
        showStatus(`Reported at ${result.level}%`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Device State" storageKey="ctrl-device-state">
      <div className="text-[11px] font-mono text-[var(--text-muted)] leading-snug mb-2 w-full flex-1">
        Report the state of a device to the bridge.
      </div>

      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">device:</span>
        <Input
          value={deviceId}
          onChange={e => setDeviceId(e.target.value.replace(/^0x/i, ''))}
          className="w-[100px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">level:</span>
        <Input
          type="number"
          value={level}
          onChange={e => setLevel(parseInt(e.target.value) || 0)}
          min={0}
          max={100}
          className="w-[48px]"
        />
        <Button variant="orange" onClick={handleSend}>
          <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="6" cy="6" r="1.5"/><path d="M3.5 3.5a3.5 3.5 0 0 0 0 5M8.5 3.5a3.5 3.5 0 0 1 0 5"/></svg>
          Report
        </Button>
      </div>
    </ControlSection>
  )
}
