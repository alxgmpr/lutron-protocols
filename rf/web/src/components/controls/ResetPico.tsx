import { useState } from 'react'
import { Card, Button, FormGroup, FormInput } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function ResetPico({ showStatus }: Props) {
  const { post } = useApi()
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
    <Card title="Reset Pico" badge="FORGET ME" variant="device">
      <div className="form-row">
        <FormGroup label="Pico ID" flex="auto">
          <FormInput 
            value={picoId} 
            onChange={setPicoId}
            placeholder="Pico ID to reset"
          />
        </FormGroup>
        <Button variant="red" onClick={handleReset}>RESET</Button>
      </div>
      <p className="help-text">Broadcasts "forget about me" to all paired devices</p>
    </Card>
  )
}

