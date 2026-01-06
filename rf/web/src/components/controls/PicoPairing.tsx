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
    <Card title="Pico Pairing" badge="PICO → DEVICE" variant="pairing">
      <div className="form-row">
        <FormGroup label="Pico ID">
          <FormInput value={deviceId} onChange={setDeviceId} width={120} prefix="0x" />
        </FormGroup>
        <FormGroup label="Preset" flex="auto">
          <FormSelect value={preset} onChange={handlePresetChange}>
            <option value="5btn">5-Button Pico (B9, FAV works)</option>
            <option value="2btn">2-Button Paddle (B9)</option>
            <option value="4btn-rl">4-Button Raise/Lower (B9)</option>
            <option value="4btn-scene-custom">4-Button Scene Custom (B9)</option>
            <option value="4btn-scene-std">4-Button Scene Standard (BA/BB)</option>
            <option value="custom">Custom (Advanced)</option>
          </FormSelect>
        </FormGroup>
        <FormGroup label="Duration">
          <FormInput 
            type="number" 
            value={duration} 
            onChange={v => setDuration(parseInt(v) || 4)} 
            width={60}
            min={3}
            max={30}
          />
        </FormGroup>
        <Button variant="purple" onClick={handlePair}>PAIR</Button>
      </div>

      {showAdvanced && (
        <div className="advanced-panel">
          <div className="advanced-title">Advanced Parameters</div>
          <div className="form-row">
            <FormGroup label="Pkt Type">
              <FormSelect value={pktType} onChange={setPktType} width={70}>
                <option value="B9">B9</option>
                <option value="BA">BA</option>
              </FormSelect>
            </FormGroup>
            <FormGroup label="Byte 10">
              <FormInput value={byte10} onChange={setByte10} width={50} />
            </FormGroup>
            <FormGroup label="Byte 30">
              <FormInput value={byte30} onChange={setByte30} width={50} />
            </FormGroup>
            <FormGroup label="Byte 31">
              <FormInput value={byte31} onChange={setByte31} width={50} />
            </FormGroup>
            <FormGroup label="Byte 37">
              <FormInput value={byte37} onChange={setByte37} width={50} />
            </FormGroup>
            <FormGroup label="Byte 38">
              <FormInput value={byte38} onChange={setByte38} width={50} />
            </FormGroup>
          </div>
        </div>
      )}

      <div className="info-line">
        {currentPreset.pkt} | byte10={currentPreset.b10} | byte30={currentPreset.b30} | {currentPreset.desc}
      </div>
    </Card>
  )
}



