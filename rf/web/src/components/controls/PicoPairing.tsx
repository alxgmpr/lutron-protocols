import { useState } from 'react'
import { Card, Button, FormGroup, FormInput, FormSelect } from '../common'
import { useApi } from '../../hooks/useApi'
import { PAIRING_PRESETS } from '../../types'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function PicoPairing({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('0xCC110001')
  const [preset, setPreset] = useState('5btn')
  const [duration, setDuration] = useState(4)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [pktType, setPktType] = useState('B9')
  const [byte10, setByte10] = useState('0x04')
  const [byte30, setByte30] = useState('0x03')
  const [byte31, setByte31] = useState('0x00')
  const [byte37, setByte37] = useState('0x02')
  const [byte38, setByte38] = useState('0x06')

  const handlePresetChange = (newPreset: string) => {
    setPreset(newPreset)
    const p = PAIRING_PRESETS[newPreset] || PAIRING_PRESETS['5btn']
    setPktType(p.pkt)
    setByte10(p.b10)
    setByte30(p.b30)
    setByte31(p.b31)
    setByte37(p.b37)
    setByte38(p.b38)
    setShowAdvanced(newPreset === 'custom')
  }

  const handlePair = async () => {
    showStatus(`Pairing ${deviceId} for ${duration}s...`)
    try {
      const result = await post('/api/pair-pico', {
        device: deviceId,
        preset,
        duration,
        pkt_type: pktType,
        byte10, byte30, byte31, byte37, byte38
      })
      if (result.status === 'ok') {
        showStatus(`Paired ${deviceId} | ${preset} | ${duration}s`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const currentPreset = PAIRING_PRESETS[preset] || PAIRING_PRESETS['5btn']

  return (
    <Card title="Pico Pairing" variant="pairing" collapsible>
      <p className="help-text">
        Pair a virtual Pico to dimmers/switches. Put target in pairing mode first.
      </p>

      <FormGroup label="Preset">
        <FormSelect value={preset} onChange={handlePresetChange}>
          <option value="5btn">5-Button Pico</option>
          <option value="2btn">2-Button Paddle</option>
          <option value="4btn-rl">4-Button Raise/Lower</option>
          <option value="4btn-scene-custom">4-Button Scene Custom</option>
          <option value="4btn-scene-std">4-Button Scene Standard</option>
          <option value="custom">Custom</option>
        </FormSelect>
      </FormGroup>

      <div className="form-row" style={{ marginTop: 8 }}>
        <FormGroup label="Pico ID">
          <FormInput value={deviceId} onChange={setDeviceId} width={110} />
        </FormGroup>
        <FormGroup label="Seconds">
          <FormInput
            type="number"
            value={duration}
            onChange={v => setDuration(parseInt(v) || 4)}
            width={50}
            min={3}
            max={30}
          />
        </FormGroup>
        <Button variant="purple" onClick={handlePair}>Pair</Button>
      </div>

      {showAdvanced && (
        <div className="advanced-panel">
          <div className="advanced-title">Advanced</div>
          <div className="form-row">
            <FormGroup label="Pkt">
              <FormSelect value={pktType} onChange={setPktType} width={60}>
                <option value="B9">B9</option>
                <option value="BA">BA</option>
              </FormSelect>
            </FormGroup>
            <FormGroup label="b10">
              <FormInput value={byte10} onChange={setByte10} width={45} />
            </FormGroup>
            <FormGroup label="b30">
              <FormInput value={byte30} onChange={setByte30} width={45} />
            </FormGroup>
            <FormGroup label="b31">
              <FormInput value={byte31} onChange={setByte31} width={45} />
            </FormGroup>
            <FormGroup label="b37">
              <FormInput value={byte37} onChange={setByte37} width={45} />
            </FormGroup>
            <FormGroup label="b38">
              <FormInput value={byte38} onChange={setByte38} width={45} />
            </FormGroup>
          </div>
        </div>
      )}

      <div className="info-line">
        {currentPreset.desc}
      </div>
    </Card>
  )
}
