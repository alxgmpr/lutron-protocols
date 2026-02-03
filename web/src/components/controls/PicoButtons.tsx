import { useState } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, FormSelect, QuickButtons, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function PicoButtons({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
  const [deviceId, setDeviceId] = useState('05851117')
  const [button, setButton] = useState('02')

  const sendButton = async (btnCode: string) => {
    const fullId = deviceId.replace(/^0x/i, '')
    showStatus(`Sending button from ${fullId}...`)
    try {
      const result = await post('/api/send', { device: '0x' + fullId, button: '0x' + btnCode })
      if (result.status === 'ok') {
        showStatus(`Sent ${result.button} from ${result.device}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Pico Buttons" storageKey="ctrl-pico-buttons">
      <div className="form-row">
        <FormGroup label="Pico ID">
          <AutocompleteInput
            value={deviceId}
            onChange={v => setDeviceId(v.replace(/^0x/i, ''))}
            suggestions={seen.picos.map(s => s.replace(/^0x/i, ''))}
            width={90}
          />
        </FormGroup>
        <FormGroup label="Button">
          <FormSelect value={button} onChange={setButton} width={100}>
            <option value="02">ON</option>
            <option value="03">FAV</option>
            <option value="04">OFF</option>
            <option value="05">RAISE</option>
            <option value="06">LOWER</option>
          </FormSelect>
        </FormGroup>
        <Button variant="primary" onClick={() => sendButton(button)}>Send</Button>
      </div>
      <QuickButtons>
        <Button size="sm" variant="primary" onClick={() => sendButton('02')}>ON</Button>
        <Button size="sm" variant="primary" onClick={() => sendButton('03')}>FAV</Button>
        <Button size="sm" variant="red" onClick={() => sendButton('04')}>OFF</Button>
        <Button size="sm" variant="blue" onClick={() => sendButton('05')}>UP</Button>
        <Button size="sm" variant="blue" onClick={() => sendButton('06')}>DN</Button>
      </QuickButtons>
    </ControlSection>
  )
}
