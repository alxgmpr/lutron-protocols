import { useState } from 'react'
import { Card, Button, FormGroup, FormInput, FormSelect, QuickButtons } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function PicoButtons({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('0x05851117')
  const [button, setButton] = useState('0x02')
  const [customButton, setCustomButton] = useState('')

  const sendButton = async (btnCode: string) => {
    showStatus(`Sending ${btnCode} from ${deviceId}...`)
    try {
      const result = await post('/api/send', { device: deviceId, button: btnCode })
      if (result.status === 'ok') {
        showStatus(`Sent ${result.button} from ${result.device}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const quickSend = (code: number) => {
    sendButton('0x' + code.toString(16).padStart(2, '0'))
  }

  return (
    <Card title="Pico Button Press" badge="PICO → DEVICE" variant="pico">
      <div className="form-row">
        <p className="help-text">
          Send Pico remote button presses to any devices that have paired to this Pico. Choose a predefined button or specify a custom code to emulate different Pico remote actions.
        </p>
        <FormGroup label="Pico ID">
          <FormInput value={deviceId} onChange={setDeviceId} width={120} prefix="0x" />
        </FormGroup>
        <FormGroup label="Button">
          <FormSelect value={button} onChange={setButton}>
            <optgroup label="5-Button Pico">
              <option value="0x02">ON (0x02)</option>
              <option value="0x03">FAVORITE (0x03)</option>
              <option value="0x04">OFF (0x04)</option>
              <option value="0x05">RAISE (0x05)</option>
              <option value="0x06">LOWER (0x06)</option>
            </optgroup>
            <optgroup label="Scene Pico">
              <option value="0x08">BRIGHT (0x08)</option>
              <option value="0x09">ENTERTAIN (0x09)</option>
              <option value="0x0A">RELAX (0x0A)</option>
              <option value="0x0B">SCENE OFF (0x0B)</option>
            </optgroup>
          </FormSelect>
        </FormGroup>
        <FormGroup label="Custom">
          <FormInput value={customButton} onChange={setCustomButton} placeholder="00" width={60} prefix="0x" />
        </FormGroup>
        <Button variant="primary" onClick={() => sendButton(button)}>SEND</Button>
        <Button variant="orange" onClick={() => customButton && sendButton(customButton)}>CUSTOM</Button>
      </div>

      <QuickButtons>
        <Button size="sm" variant="primary" onClick={() => quickSend(0x02)}>ON</Button>
        <Button size="sm" variant="primary" onClick={() => quickSend(0x03)}>FAV</Button>
        <Button size="sm" variant="red" onClick={() => quickSend(0x04)}>OFF</Button>
        <Button size="sm" variant="blue" onClick={() => quickSend(0x05)}>▲</Button>
        <Button size="sm" variant="blue" onClick={() => quickSend(0x06)}>▼</Button>
      </QuickButtons>
      <QuickButtons className="mt-2">
        <Button size="sm" variant="orange" onClick={() => quickSend(0x08)}>BRIGHT</Button>
        <Button size="sm" variant="orange" onClick={() => quickSend(0x09)}>ENTER</Button>
        <Button size="sm" variant="orange" onClick={() => quickSend(0x0A)}>RELAX</Button>
        <Button size="sm" variant="red" onClick={() => quickSend(0x0B)}>SC OFF</Button>
      </QuickButtons>
    </Card>
  )
}

