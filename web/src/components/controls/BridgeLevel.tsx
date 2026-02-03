import { useState } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, FormInput, QuickButtons, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeLevel({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
  const [subnet, setSubnet] = useState('2C90')
  const [targetId, setTargetId] = useState('06FDEFF4')
  const [level, setLevel] = useState(50)

  const sourceId = `0x00${subnet.toUpperCase().padStart(4, '0')}AD`

  const handleSend = async (lvl?: number) => {
    const targetLevel = lvl ?? level
    showStatus(`Setting ${targetId} to ${targetLevel}%...`)
    try {
      const result = await post('/api/level', {
        bridge: sourceId,
        target: '0x' + targetId.replace(/^0x/i, ''),
        level: targetLevel
      })
      if (result.status === 'ok') {
        showStatus(`Set to ${result.level}%`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Bridge Level" storageKey="ctrl-bridge-level">
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
        <FormGroup label="%">
          <FormInput
            type="number"
            value={level}
            onChange={v => setLevel(parseInt(v) || 0)}
            width={45}
            min={0}
            max={100}
          />
        </FormGroup>
        <Button variant="blue" onClick={() => handleSend()}>Set</Button>
      </div>
      <QuickButtons>
        <Button size="sm" variant="red" onClick={() => handleSend(0)}>0%</Button>
        <Button size="sm" variant="blue" onClick={() => handleSend(25)}>25%</Button>
        <Button size="sm" variant="blue" onClick={() => handleSend(50)}>50%</Button>
        <Button size="sm" variant="blue" onClick={() => handleSend(75)}>75%</Button>
        <Button size="sm" variant="primary" onClick={() => handleSend(100)}>100%</Button>
      </QuickButtons>
    </ControlSection>
  )
}
