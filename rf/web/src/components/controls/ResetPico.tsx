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
    <Card title="Reset Pico" variant="device" collapsible defaultCollapsed>
      <p className="help-text">Broadcasts "forget me" to unpair this Pico from all devices.</p>
      <div className="form-row">
        <FormGroup label="Pico ID">
          <AutocompleteInput value={picoId} onChange={setPicoId} suggestions={seen.picos} width={110} />
        </FormGroup>
        <Button variant="red" onClick={handleReset}>Reset</Button>
      </div>
    </Card>
  )
}

