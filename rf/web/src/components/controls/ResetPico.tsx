import { useState } from 'react'
import { Card, Button, FormGroup, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function ResetPico({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
  const [picoId, setPicoId] = useState('0x05851117')

  const handleReset = async () => {
    showStatus(`Sending reset for ${picoId}...`)
    try {
      const result = await post('/api/reset', { pico: picoId })
      if (result.status === 'ok') {
        showStatus(`Reset broadcast: ${result.pico} "forget me"`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <Card title="Reset Pico" badge="FORGET ME" variant="device" collapsible defaultCollapsed>
      <p className="help-text">Broadcasts "forget" message to devices within earshot. Devices who have paired to this Pico will forget about it.</p>
      <div className="form-row">
        <FormGroup label="Pico ID" flex="auto">
          <AutocompleteInput
            value={picoId}
            onChange={setPicoId}
            suggestions={seen.picos}
            placeholder="Pico ID to reset"
            prefix="0x"
          />
        </FormGroup>
        <Button variant="red" onClick={handleReset}>RESET</Button>
      </div>
    </Card>
  )
}

