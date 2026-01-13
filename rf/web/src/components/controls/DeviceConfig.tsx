import { useState } from 'react'
import { Card, Button, FormGroup, FormSelect, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

type ConfigTab = 'fade' | 'led' | 'trim' | 'phase'

// Fade rate options (seconds)
const FADE_RATES = [
  { value: '0.25', label: '0.25s' },
  { value: '0.75', label: '0.75s' },
  { value: '2.5', label: '2.5s' },
  { value: '3', label: '3s' },
  { value: '5', label: '5s' },
  { value: '15', label: '15s' },
]

// LED mode options
const LED_MODES = [
  { value: '0', label: 'Both Off' },
  { value: '1', label: 'Both On' },
  { value: '2', label: 'On when load on' },
  { value: '3', label: 'On when load off' },
]

// Phase mode options
const PHASE_MODES = [
  { value: 'forward', label: 'Forward' },
  { value: 'reverse', label: 'Reverse' },
]

// Convert 4-char subnet to full bridge zone ID
function subnetToSourceId(subnet: string): string {
  const clean = subnet.replace(/^0x/i, '').toUpperCase().padStart(4, '0')
  return `0x00${clean}AD`
}

export function DeviceConfig({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
  const [activeTab, setActiveTab] = useState<ConfigTab>('fade')

  // Common fields
  const [subnet, setSubnet] = useState('2C90')
  const [targetId, setTargetId] = useState('0x06FE8006')

  // Fade config
  const [fadeOn, setFadeOn] = useState('0.25')
  const [fadeOff, setFadeOff] = useState('0.25')

  // LED config
  const [ledMode, setLedMode] = useState('0')

  // Trim config
  const [highTrim, setHighTrim] = useState('100')
  const [lowTrim, setLowTrim] = useState('1')

  // Phase config
  const [phase, setPhase] = useState('forward')

  const sourceId = subnetToSourceId(subnet)

  const handleFadeConfig = async () => {
    showStatus(`Setting fade rates for ${targetId}...`)
    try {
      const result = await post('/api/config/fade', {
        bridge: sourceId,
        target: targetId,
        fade_on: parseFloat(fadeOn),
        fade_off: parseFloat(fadeOff)
      })
      if (result.status === 'ok') {
        showStatus(`Fade: on=${result.fade_on}s, off=${result.fade_off}s`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const handleLedConfig = async () => {
    showStatus(`Setting LED mode for ${targetId}...`)
    try {
      const result = await post('/api/config/led', {
        bridge: sourceId,
        target: targetId,
        mode: parseInt(ledMode)
      })
      if (result.status === 'ok') {
        showStatus(`LED mode: ${result.mode_name}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const handleTrimConfig = async () => {
    showStatus(`Setting trim for ${targetId}...`)
    try {
      const result = await post('/api/config/trim', {
        bridge: sourceId,
        target: targetId,
        high: parseInt(highTrim),
        low: parseInt(lowTrim),
        phase: phase
      })
      if (result.status === 'ok') {
        showStatus(`Trim: low=${result.low_trim}%, high=${result.high_trim}%`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const handlePhaseConfig = async () => {
    showStatus(`Setting phase for ${targetId}...`)
    try {
      const result = await post('/api/config/phase', {
        bridge: sourceId,
        target: targetId,
        phase: phase,
        high: parseInt(highTrim),
        low: parseInt(lowTrim)
      })
      if (result.status === 'ok') {
        showStatus(`Phase: ${result.phase}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <Card title="Device Config" variant="bridge" collapsible defaultCollapsed>
      <div className="form-row">
        <FormGroup label="Subnet">
          <AutocompleteInput value={subnet} onChange={setSubnet} suggestions={seen.bridgeSubnets} width={70} />
        </FormGroup>
        <FormGroup label="Target">
          <AutocompleteInput value={targetId} onChange={setTargetId} suggestions={seen.dimmers} width={110} />
        </FormGroup>
      </div>

      {/* Tab navigation */}
      <div className="config-tabs">
        <button
          className={`config-tab ${activeTab === 'fade' ? 'active' : ''}`}
          onClick={() => setActiveTab('fade')}
        >
          Fade
        </button>
        <button
          className={`config-tab ${activeTab === 'led' ? 'active' : ''}`}
          onClick={() => setActiveTab('led')}
        >
          LED
        </button>
        <button
          className={`config-tab ${activeTab === 'trim' ? 'active' : ''}`}
          onClick={() => setActiveTab('trim')}
        >
          Trim
        </button>
        <button
          className={`config-tab ${activeTab === 'phase' ? 'active' : ''}`}
          onClick={() => setActiveTab('phase')}
        >
          Phase
        </button>
      </div>

      {/* Tab content */}
      <div className="config-tab-content">
        {activeTab === 'fade' && (
          <div className="config-panel">
            <p className="help-text">Set fade-on and fade-off transition times.</p>
            <div className="form-row">
              <FormGroup label="Fade On">
                <FormSelect value={fadeOn} onChange={setFadeOn} width={80}>
                  {FADE_RATES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </FormSelect>
              </FormGroup>
              <FormGroup label="Fade Off">
                <FormSelect value={fadeOff} onChange={setFadeOff} width={80}>
                  {FADE_RATES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </FormSelect>
              </FormGroup>
              <Button variant="blue" onClick={handleFadeConfig}>Apply</Button>
            </div>
          </div>
        )}

        {activeTab === 'led' && (
          <div className="config-panel">
            <p className="help-text">Configure the status LED behavior on the device.</p>
            <div className="form-row">
              <FormGroup label="LED Mode">
                <FormSelect value={ledMode} onChange={setLedMode} width={150}>
                  {LED_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </FormSelect>
              </FormGroup>
              <Button variant="blue" onClick={handleLedConfig}>Apply</Button>
            </div>
          </div>
        )}

        {activeTab === 'trim' && (
          <div className="config-panel">
            <p className="help-text">Set low-end and high-end brightness trim levels (1-100%).</p>
            <div className="form-row">
              <FormGroup label="Low Trim %">
                <input
                  type="number"
                  className="form-input"
                  value={lowTrim}
                  onChange={e => setLowTrim(e.target.value)}
                  min={1}
                  max={50}
                  style={{ width: 60 }}
                />
              </FormGroup>
              <FormGroup label="High Trim %">
                <input
                  type="number"
                  className="form-input"
                  value={highTrim}
                  onChange={e => setHighTrim(e.target.value)}
                  min={50}
                  max={100}
                  style={{ width: 60 }}
                />
              </FormGroup>
              <Button variant="blue" onClick={handleTrimConfig}>Apply</Button>
            </div>
          </div>
        )}

        {activeTab === 'phase' && (
          <div className="config-panel">
            <p className="help-text">Set dimming phase mode (forward or reverse).</p>
            <div className="form-row">
              <FormGroup label="Phase Mode">
                <FormSelect value={phase} onChange={setPhase} width={100}>
                  {PHASE_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </FormSelect>
              </FormGroup>
              <Button variant="blue" onClick={handlePhaseConfig}>Apply</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
