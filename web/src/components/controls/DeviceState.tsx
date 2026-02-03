import { useState } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, FormInput, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function DeviceState({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
  const [deviceId, setDeviceId] = useState('8F902C08')
  const [level, setLevel] = useState(50)

  const handleSend = async () => {
    showStatus(`Reporting ${deviceId} at ${level}%...`)
    try {
      const result = await post('/api/state', {
        device: '0x' + deviceId.replace(/^0x/i, ''),
        level
      })
      if (result.status === 'ok') {
        showStatus(`Reported at ${result.level}%`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Device State" storageKey="ctrl-device-state">
      <div className="form-row">
        <FormGroup label="Device">
          <AutocompleteInput
            value={deviceId}
            onChange={v => setDeviceId(v.replace(/^0x/i, ''))}
            suggestions={seen.dimmers.map(s => s.replace(/^0x/i, ''))}
            width={90}
          />
        </FormGroup>
        <FormGroup label="%">
          <FormInput
            type="number"
            value={level}
            onChange={v => setLevel(parseInt(v) || 0)}
            width={45}
            min={0}
            max={100}
          />
        </FormGroup>
        <Button variant="orange" onClick={handleSend}>Report</Button>
      </div>
    </ControlSection>
  )
}
