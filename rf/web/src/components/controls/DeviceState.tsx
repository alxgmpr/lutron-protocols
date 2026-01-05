import { useState } from 'react'
import { Card, Button, FormGroup, FormInput } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function DeviceState({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('0x8F902C08')
  const [level, setLevel] = useState(50)

  const handleSend = async () => {
    showStatus(`Reporting ${deviceId} at ${level}%...`)
    try {
      const result = await post('/api/state', { device: deviceId, level })
      if (result.status === 'ok') {
        showStatus(`Reported ${result.device} at ${result.level}%`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <Card title="Device State Report" badge="DEVICE → BRIDGE" variant="device">
      <p className="help-text">
        Report the current level of a device to the bridge. This will update the bridge with the current level of the dimmer.
      </p>
      <div className="form-row">
        <FormGroup label="Device ID">
          <FormInput value={deviceId} onChange={setDeviceId} width={120} prefix="0x" />
        </FormGroup>
        <FormGroup label="Level">
          <FormInput 
            type="number" 
            value={level} 
            onChange={v => setLevel(parseInt(v) || 0)}
            width={70}
            min={0}
            max={100}
          />
        </FormGroup>
        <Button variant="orange" onClick={handleSend}>REPORT</Button>
      </div>
    </Card>
  )
}

