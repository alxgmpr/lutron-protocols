import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function OwtLevel({ showStatus }: Props) {
  const { postJson } = useApi()
  const [deviceId, setDeviceId] = useState('0595E68D')
  const [level, setLevel] = useState(50)
  const [fade, setFade] = useState(0.25)

  const handleSend = async (lvl?: number) => {
    const targetLevel = lvl ?? level
    showStatus(`OWT level ${deviceId} → ${targetLevel}%...`)
    try {
      const result = await postJson('/api/pico-level', {
        device: '0x' + deviceId.replace(/^0x/i, ''),
        level: targetLevel,
        fade
      })
      if (result.status === 'ok') {
        showStatus(`OWT level → ${targetLevel}%`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="OWT Set Level" storageKey="ctrl-owt-level" defaultOpen>
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">device:</span>
        <Input
          value={deviceId}
          onChange={e => setDeviceId(e.target.value.replace(/^0x/i, ''))}
          className="w-[100px]"
          placeholder="0595E68D"
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
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">fade:</span>
        <Input
          type="number"
          value={fade}
          onChange={e => setFade(parseFloat(e.target.value) || 0)}
          min={0}
          max={63}
          step={0.25}
          className="w-[52px]"
        />
        <span className="text-[10px] text-[var(--text-muted)]">sec</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="red" onClick={() => handleSend(0)}>0%</Button>
        <Button size="sm" variant="blue" onClick={() => handleSend(25)}>25%</Button>
        <Button size="sm" variant="blue" onClick={() => handleSend(50)}>50%</Button>
        <Button size="sm" variant="blue" onClick={() => handleSend(75)}>75%</Button>
        <Button size="sm" variant="green" onClick={() => handleSend(100)}>100%</Button>
        <div className="flex-1" />
        <Button variant="blue" onClick={() => handleSend()}>
          <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6h7M7 3l3 3-3 3"/></svg>
          Set
        </Button>
      </div>
      <p className="text-[10px] text-[var(--text-muted)] leading-tight mt-0.5">
        Temp limitation: ~3 min delay + ~1 min fade. Level is correct but fade control not yet solved via pico path.
      </p>
    </ControlSection>
  )
}
