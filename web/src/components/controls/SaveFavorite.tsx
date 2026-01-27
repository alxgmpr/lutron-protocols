import { useState } from 'react'
import { Card, Button, FormGroup, FormInput, FormSelect, QuickButtons } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

const BUTTON_NAMES: Record<number, string> = {
  0x03: 'FAVORITE', 0x08: 'BRIGHT', 0x09: 'ENTERTAIN', 0x0A: 'RELAX', 0x0B: 'OFF'
}

export function SaveFavorite({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('0x05851117')
  const [button, setButton] = useState('0x03')
  const [holdSeconds, setHoldSeconds] = useState(6)

  const handleSave = async (btnOverride?: string) => {
    const btnCode = btnOverride || button
    const btnNum = parseInt(btnCode)
    const btnName = BUTTON_NAMES[btnNum] || btnCode
    showStatus(`Saving ${btnName} on ${deviceId} (holding ${holdSeconds}s)...`)
    try {
      const result = await post('/api/save-favorite', {
        device: deviceId,
        button: btnCode,
        hold: holdSeconds
      })
      if (result.status === 'ok') {
        showStatus(`Saved ${btnName} on ${result.device}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <Card title="Save Favorite" variant="pico" collapsible defaultCollapsed>
      <p className="help-text">
        Set dimmer to desired level, then hold button to save.
      </p>

      <div className="form-row">
        <FormGroup label="Pico ID">
          <FormInput value={deviceId} onChange={setDeviceId} width={110} />
        </FormGroup>
        <FormGroup label="Button">
          <FormSelect value={button} onChange={setButton} width={90}>
            <option value="0x03">FAV</option>
            <option value="0x08">BRIGHT</option>
            <option value="0x09">ENTERTAIN</option>
            <option value="0x0A">RELAX</option>
            <option value="0x0B">OFF</option>
          </FormSelect>
        </FormGroup>
        <FormGroup label="Hold">
          <FormInput
            type="number"
            value={holdSeconds}
            onChange={v => setHoldSeconds(parseInt(v) || 6)}
            width={45}
            min={3}
            max={15}
          />
        </FormGroup>
        <Button variant="purple" onClick={() => handleSave()}>Save</Button>
      </div>

      <QuickButtons>
        <Button size="sm" variant="purple" onClick={() => handleSave('0x03')}>FAV</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('0x08')}>BRIGHT</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('0x09')}>ENTER</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('0x0A')}>RELAX</Button>
      </QuickButtons>
    </Card>
  )
}
