import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select } from '../ui/select'
import { useApi } from '../../hooks/useApi'
import { PAIRING_PRESETS } from '../../types'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function PicoPairing({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('CC110001')
  const [preset, setPreset] = useState('5btn')
  const [duration, setDuration] = useState(4)

  const handlePair = async () => {
    showStatus(`Pairing ${deviceId} for ${duration}s...`)
    try {
      const result = await post('/api/pair-pico', {
        device: '0x' + deviceId.replace(/^0x/i, ''),
        preset,
        duration
      })
      if (result.status === 'ok') {
        showStatus(`Paired ${deviceId}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const currentPreset = PAIRING_PRESETS[preset] || PAIRING_PRESETS['5btn']

  return (
    <ControlSection title="Pico Pairing" storageKey="ctrl-pico-pairing">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">pico:</span>
        <Input
          value={deviceId}
          onChange={e => setDeviceId(e.target.value.replace(/^0x/i, ''))}
          className="w-[100px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">type:</span>
        <Select value={preset} onChange={e => setPreset(e.target.value)} className="w-[130px]">
          <option value="5btn">5-Button</option>
          <option value="2btn">2-Button</option>
          <option value="4btn-rl">4-Btn R/L</option>
          <option value="4btn-scene-std">4-Btn Scene</option>
        </Select>
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">dur:</span>
        <Input
          type="number"
          value={duration}
          onChange={e => setDuration(parseInt(e.target.value) || 4)}
          min={3}
          max={30}
          className="w-[44px]"
        />
        <Button variant="purple" onClick={handlePair}>
          <svg className="size-3" viewBox="0 0 12 12" fill="currentColor"><path d="M7 1L3 7h3l-1 4 4-6H6z"/></svg>
          Pair
        </Button>
      </div>
      <div className="text-[11px] font-mono text-[var(--text-muted)] border-t border-[var(--border-primary)] pt-2">
        {currentPreset.desc}
      </div>
    </ControlSection>
  )
}
