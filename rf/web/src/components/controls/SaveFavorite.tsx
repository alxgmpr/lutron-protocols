import { useState } from 'react'
import { Card, Button, FormGroup, FormInput, FormSelect, QuickButtons, QuickButtonDivider } from '../common'
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
    <Card title="Save Favorite / Scene" badge="HOLD TO SAVE" variant="pico">
      <p className="help-text">
        First set dimmer to desired level, then press save. Holds button ~6s to trigger save mode. Dimmers who have paired to this device will update their saved value to this level.
      </p>
      <div className="form-row">
        <FormGroup label="Pico ID">
          <FormInput value={deviceId} onChange={setDeviceId} width={120} prefix="0x" />
        </FormGroup>
        <FormGroup label="Button">
          <FormSelect value={button} onChange={setButton}>
            <optgroup label="5-Button Pico">
              <option value="0x03">FAVORITE (0x03)</option>
            </optgroup>
            <optgroup label="Scene Pico">
              <option value="0x08">BRIGHT (0x08)</option>
              <option value="0x09">ENTERTAIN (0x09)</option>
              <option value="0x0A">RELAX (0x0A)</option>
              <option value="0x0B">SCENE OFF (0x0B)</option>
            </optgroup>
          </FormSelect>
        </FormGroup>
        <FormGroup label="Hold (sec)">
          <FormInput 
            type="number" 
            value={holdSeconds} 
            onChange={v => setHoldSeconds(parseInt(v) || 6)}
            width={60}
            min={3}
            max={15}
          />
        </FormGroup>
        <Button variant="purple" onClick={() => handleSave()}>SAVE</Button>
      </div>

      <QuickButtons>
        <Button size="sm" variant="purple" onClick={() => handleSave('0x03')}>SAVE FAV</Button>
        <QuickButtonDivider />
        <Button size="sm" variant="orange" onClick={() => handleSave('0x08')}>BRIGHT</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('0x09')}>ENTER</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('0x0A')}>RELAX</Button>
        <Button size="sm" variant="red" onClick={() => handleSave('0x0B')}>OFF</Button>
      </QuickButtons>
    </Card>
  )
}



