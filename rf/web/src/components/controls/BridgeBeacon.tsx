import { useState } from 'react'
import { Card, Button, FormGroup, FormInput } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeBeacon({ showStatus }: Props) {
  const { post } = useApi()
  const [bridgeId, setBridgeId] = useState('0xAF902C01')
  const [duration, setDuration] = useState(30)

  const handleSend = async () => {
    showStatus(`Starting beacon from ${bridgeId} for ${duration}s...`)
    try {
      const result = await post('/api/beacon', {
        device: bridgeId,
        duration,
        type: '0x92'
      })
      if (result.status === 'ok') {
        showStatus(`Beacon started: ${result.device}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <Card title="Bridge Beacon Mode" badge="BRIDGE PAIRING <WIP>" variant="bridge">
      <p className="help-text">Starts pairing mode on the bridge which is a beacon that blinks to indicate pairing mode. Devices within range will go to their bridge pairing mode, where a 10 second press of the button will pair to the bridge. <span className="text-muted">(WIP)</span></p>
      <div className="form-row">
        <FormGroup label="Bridge ID">
          <FormInput value={bridgeId} onChange={setBridgeId} width={120} />
        </FormGroup>
        <FormGroup label="Duration">
          <FormInput 
            type="number" 
            value={duration} 
            onChange={v => setDuration(parseInt(v) || 30)}
            width={70}
            min={5}
            max={120}
          />
        </FormGroup>
        <Button variant="blue" onClick={handleSend}>START BEACON</Button>
      </div>
    </Card>
  )
}

