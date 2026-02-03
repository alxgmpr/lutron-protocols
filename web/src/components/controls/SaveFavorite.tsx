import { useState } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, FormInput, FormSelect, QuickButtons } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function SaveFavorite({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('05851117')
  const [button, setButton] = useState('03')

  const handleSave = async (btnOverride?: string) => {
    const btnCode = btnOverride || button
    showStatus(`Saving favorite on ${deviceId}...`)
    try {
      const result = await post('/api/save-favorite', {
        device: '0x' + deviceId.replace(/^0x/i, ''),
        button: '0x' + btnCode,
        hold: 6
      })
      if (result.status === 'ok') {
        showStatus(`Saved favorite on ${result.device}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Save Favorite" storageKey="ctrl-save-favorite">
      <div className="form-row">
        <FormGroup label="Pico ID">
          <FormInput
            value={deviceId}
            onChange={v => setDeviceId(v.replace(/^0x/i, ''))}
            width={90}
          />
        </FormGroup>
        <FormGroup label="Button">
          <FormSelect value={button} onChange={setButton} width={90}>
            <option value="03">FAV</option>
            <option value="08">BRIGHT</option>
            <option value="09">ENTERTAIN</option>
            <option value="0A">RELAX</option>
          </FormSelect>
        </FormGroup>
        <Button variant="purple" onClick={() => handleSave()}>Save</Button>
      </div>
      <QuickButtons>
        <Button size="sm" variant="purple" onClick={() => handleSave('03')}>FAV</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('08')}>BRIGHT</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('09')}>ENTER</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('0A')}>RELAX</Button>
      </QuickButtons>
    </ControlSection>
  )
}
