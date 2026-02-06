import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function PicoPairing({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('CC110001')
  const [duration, setDuration] = useState(4)
  const [customPreset, setCustomPreset] = useState('')

  const handlePair = async (preset: string) => {
    showStatus(`Pairing ${deviceId} (${preset}) for ${duration}s...`)
    try {
      const result = await post('/api/pair-pico', {
        device: '0x' + deviceId.replace(/^0x/i, ''),
        preset,
        duration
      })
      if (result.status === 'ok') {
        showStatus(`Paired ${deviceId} (${preset})`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const pairCustom = () => {
    const key = customPreset.trim()
    if (key) handlePair(key)
  }

  return (
    <ControlSection title="Pico Pairing" storageKey="ctrl-pico-pairing">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">pico:</span>
        <Input
          value={deviceId}
          onChange={e => setDeviceId(e.target.value.replace(/^0x/i, ''))}
          className="w-[100px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">dur:</span>
        <Input
          type="number"
          value={duration}
          onChange={e => setDuration(parseInt(e.target.value) || 4)}
          min={3}
          max={30}
          className="w-[44px]"
        />
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button size="sm" variant="purple" onClick={() => handlePair('5btn')}>5-Btn <span className="opacity-50">06</span></Button>
        <Button size="sm" variant="purple" onClick={() => handlePair('2btn')}>ON/OFF <span className="opacity-50">01</span></Button>
        <Button size="sm" variant="purple" onClick={() => handlePair('2btn-home')}>HOME/AWAY <span className="opacity-50">23</span></Button>
        <Button size="sm" variant="purple" onClick={() => handlePair('4btn-rl')}>R/L <span className="opacity-50">21</span></Button>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button size="sm" variant="green" onClick={() => handlePair('4btn-cooking')}>COOKING <span className="opacity-50">25</span></Button>
        <Button size="sm" variant="green" onClick={() => handlePair('4btn-movie')}>MOVIE <span className="opacity-50">26</span></Button>
        <Button size="sm" variant="orange" onClick={() => handlePair('4btn-relax')}>RELAX <span className="opacity-50">27</span></Button>
        <Button size="sm" variant="green" onClick={() => handlePair('4btn-scene-custom')}>CUSTOM <span className="opacity-50">28</span></Button>
      </div>
      <div className="flex items-center gap-3 border-t border-[var(--border-primary)] pt-2">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">preset:</span>
        <Input
          value={customPreset}
          onChange={e => setCustomPreset(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && pairCustom()}
          placeholder="e.g. custom"
          className="w-[90px]"
        />
        <Button size="sm" variant="default" onClick={pairCustom}>Pair</Button>
      </div>
    </ControlSection>
  )
}
