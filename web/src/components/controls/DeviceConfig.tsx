import { useState } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, FormSelect, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

type ConfigTab = 'fade' | 'led' | 'trim' | 'phase'

const FADE_RATES = ['0.25', '0.75', '2.5', '3', '5', '15']
const LED_MODES = [
  { value: '0', label: 'Both Off' },
  { value: '1', label: 'Both On' },
  { value: '2', label: 'On when load on' },
  { value: '3', label: 'On when load off' },
]

export function DeviceConfig({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
  const [activeTab, setActiveTab] = useState<ConfigTab>('fade')
  const [subnet, setSubnet] = useState('2C90')
  const [targetId, setTargetId] = useState('06FE8006')
  const [fadeOn, setFadeOn] = useState('0.25')
  const [fadeOff, setFadeOff] = useState('0.25')
  const [ledMode, setLedMode] = useState('0')
  const [highTrim, setHighTrim] = useState('100')
  const [lowTrim, setLowTrim] = useState('1')
  const [phase, setPhase] = useState('forward')

  const sourceId = `0x00${subnet.toUpperCase().padStart(4, '0')}AD`
  const target = '0x' + targetId.replace(/^0x/i, '')

  const handleFade = async () => {
    showStatus(`Setting fade rates...`)
    const result = await post('/api/config/fade', { bridge: sourceId, target, fade_on: parseFloat(fadeOn), fade_off: parseFloat(fadeOff) })
    if (result.status === 'ok') showStatus(`Fade: on=${fadeOn}s, off=${fadeOff}s`, 'success')
    else showStatus(`Error: ${result.error}`, 'error')
  }

  const handleLed = async () => {
    showStatus(`Setting LED mode...`)
    const result = await post('/api/config/led', { bridge: sourceId, target, mode: parseInt(ledMode) })
    if (result.status === 'ok') showStatus(`LED mode set`, 'success')
    else showStatus(`Error: ${result.error}`, 'error')
  }

  const handleTrim = async () => {
    showStatus(`Setting trim...`)
    const result = await post('/api/config/trim', { bridge: sourceId, target, high: parseInt(highTrim), low: parseInt(lowTrim), phase })
    if (result.status === 'ok') showStatus(`Trim: ${lowTrim}%-${highTrim}%`, 'success')
    else showStatus(`Error: ${result.error}`, 'error')
  }

  const handlePhase = async () => {
    showStatus(`Setting phase...`)
    const result = await post('/api/config/phase', { bridge: sourceId, target, phase, high: parseInt(highTrim), low: parseInt(lowTrim) })
    if (result.status === 'ok') showStatus(`Phase: ${phase}`, 'success')
    else showStatus(`Error: ${result.error}`, 'error')
  }

  return (
    <ControlSection title="Device Config" storageKey="ctrl-device-config">
      <div className="form-row">
        <FormGroup label="Subnet">
          <AutocompleteInput
            value={subnet}
            onChange={v => setSubnet(v.replace(/^0x/i, ''))}
            suggestions={seen.bridgeSubnets.map(s => s.replace(/^0x/i, ''))}
            width={60}
          />
        </FormGroup>
        <FormGroup label="Target">
          <AutocompleteInput
            value={targetId}
            onChange={v => setTargetId(v.replace(/^0x/i, ''))}
            suggestions={seen.dimmers.map(s => s.replace(/^0x/i, ''))}
            width={90}
          />
        </FormGroup>
      </div>

      <div className="config-tabs">
        {(['fade', 'led', 'trim', 'phase'] as ConfigTab[]).map(tab => (
          <button
            key={tab}
            className={`config-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      <div className="config-tab-content">
        {activeTab === 'fade' && (
          <div className="form-row">
            <FormGroup label="On">
              <FormSelect value={fadeOn} onChange={setFadeOn} width={65}>
                {FADE_RATES.map(r => <option key={r} value={r}>{r}s</option>)}
              </FormSelect>
            </FormGroup>
            <FormGroup label="Off">
              <FormSelect value={fadeOff} onChange={setFadeOff} width={65}>
                {FADE_RATES.map(r => <option key={r} value={r}>{r}s</option>)}
              </FormSelect>
            </FormGroup>
            <Button variant="blue" onClick={handleFade}>Apply</Button>
          </div>
        )}

        {activeTab === 'led' && (
          <div className="form-row">
            <FormGroup label="Mode">
              <FormSelect value={ledMode} onChange={setLedMode} width={140}>
                {LED_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </FormSelect>
            </FormGroup>
            <Button variant="blue" onClick={handleLed}>Apply</Button>
          </div>
        )}

        {activeTab === 'trim' && (
          <div className="form-row">
            <FormGroup label="Low %">
              <input type="number" className="form-input" value={lowTrim} onChange={e => setLowTrim(e.target.value)} min={1} max={50} style={{ width: 50 }} />
            </FormGroup>
            <FormGroup label="High %">
              <input type="number" className="form-input" value={highTrim} onChange={e => setHighTrim(e.target.value)} min={50} max={100} style={{ width: 50 }} />
            </FormGroup>
            <Button variant="blue" onClick={handleTrim}>Apply</Button>
          </div>
        )}

        {activeTab === 'phase' && (
          <div className="form-row">
            <FormGroup label="Phase">
              <FormSelect value={phase} onChange={setPhase} width={90}>
                <option value="forward">Forward</option>
                <option value="reverse">Reverse</option>
              </FormSelect>
            </FormGroup>
            <Button variant="blue" onClick={handlePhase}>Apply</Button>
          </div>
        )}
      </div>
    </ControlSection>
  )
}
