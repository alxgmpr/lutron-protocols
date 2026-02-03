import { useState } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, FormInput, FormSelect } from '../common'
import { useApi } from '../../hooks/useApi'
import { PAIRING_PRESETS } from '../../types'
import './ControlPanel.css'

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
      <div className="form-row">
        <FormGroup label="Pico ID">
          <FormInput
            value={deviceId}
            onChange={v => setDeviceId(v.replace(/^0x/i, ''))}
            width={90}
          />
        </FormGroup>
        <FormGroup label="Type">
          <FormSelect value={preset} onChange={setPreset} width={120}>
            <option value="5btn">5-Button</option>
            <option value="2btn">2-Button</option>
            <option value="4btn-rl">4-Btn Raise/Lower</option>
            <option value="4btn-scene-std">4-Btn Scene</option>
          </FormSelect>
        </FormGroup>
        <FormGroup label="Sec">
          <FormInput
            type="number"
            value={duration}
            onChange={v => setDuration(parseInt(v) || 4)}
            width={40}
            min={3}
            max={30}
          />
        </FormGroup>
        <Button variant="purple" onClick={handlePair}>Pair</Button>
      </div>
      <div className="info-line">{currentPreset.desc}</div>
    </ControlSection>
  )
}
