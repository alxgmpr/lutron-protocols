import { useState } from 'react'
import { Card, Button, FormGroup, FormInput, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function DeviceState({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
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
    <Card title="Device State" variant="device" collapsible defaultCollapsed>
      <p className="help-text">
        Report device level to the bridge.
      </p>

      <div className="form-row">
        <FormGroup label="Device ID">
          <AutocompleteInput value={deviceId} onChange={setDeviceId} suggestions={seen.dimmers} width={110} />
        </FormGroup>
        <FormGroup label="Level">
          <FormInput
            type="number"
            value={level}
            onChange={v => setLevel(parseInt(v) || 0)}
            width={50}
            min={0}
            max={100}
          />
        </FormGroup>
        <Button variant="orange" onClick={handleSend}>Report</Button>
      </div>
    </Card>
  )
}
