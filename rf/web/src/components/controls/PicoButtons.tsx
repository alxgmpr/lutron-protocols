import { useState } from 'react'
import { Card, Button, FormGroup, FormSelect, QuickButtons, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function PicoButtons({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
  const [deviceId, setDeviceId] = useState('0x05851117')
  const [button, setButton] = useState('0x02')

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
    <Card title="Pico Button Press" variant="pico" collapsible defaultCollapsed>
      <p className="help-text">
        Send button presses from a virtual Pico to paired devices.
      </p>

      <div className="form-row">
        <FormGroup label="Pico ID">
          <AutocompleteInput value={deviceId} onChange={setDeviceId} suggestions={seen.picos} width={110} />
        </FormGroup>
        <FormGroup label="Button">
          <FormSelect value={button} onChange={setButton} width={100}>
            <optgroup label="5-Button">
              <option value="0x02">ON</option>
              <option value="0x03">FAV</option>
              <option value="0x04">OFF</option>
              <option value="0x05">RAISE</option>
              <option value="0x06">LOWER</option>
            </optgroup>
            <optgroup label="Scene">
              <option value="0x08">BRIGHT</option>
              <option value="0x09">ENTERTAIN</option>
              <option value="0x0A">RELAX</option>
              <option value="0x0B">OFF</option>
            </optgroup>
          </FormSelect>
        </FormGroup>
        <Button variant="primary" onClick={() => sendButton(button)}>Send</Button>
      </div>

      <QuickButtons>
        <Button size="sm" variant="primary" onClick={() => quickSend(0x02)}>ON</Button>
        <Button size="sm" variant="primary" onClick={() => quickSend(0x03)}>FAV</Button>
        <Button size="sm" variant="red" onClick={() => quickSend(0x04)}>OFF</Button>
        <Button size="sm" variant="blue" onClick={() => quickSend(0x05)}>UP</Button>
        <Button size="sm" variant="blue" onClick={() => quickSend(0x06)}>DN</Button>
      </QuickButtons>
    </Card>
  )
}
