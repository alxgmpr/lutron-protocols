import { useState } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function ResetPico({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
  const [picoId, setPicoId] = useState('05851117')

  const handleReset = async () => {
    showStatus(`Sending reset for ${picoId}...`)
    try {
      const result = await post('/api/reset', { pico: '0x' + picoId.replace(/^0x/i, '') })
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
    <ControlSection title="Reset Pico" storageKey="ctrl-reset-pico">
      <div className="form-row">
        <FormGroup label="Pico ID">
          <AutocompleteInput
            value={picoId}
            onChange={v => setPicoId(v.replace(/^0x/i, ''))}
            suggestions={seen.picos.map(s => s.replace(/^0x/i, ''))}
            width={90}
          />
        </FormGroup>
        <Button variant="red" onClick={handleReset}>Reset</Button>
      </div>
    </ControlSection>
  )
}
