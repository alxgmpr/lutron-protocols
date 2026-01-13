import { useState } from 'react'
import { Card, Button, FormGroup, FormInput, QuickButtons, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

function subnetToSourceId(subnet: string): string {
  const clean = subnet.replace(/^0x/i, '').toUpperCase().padStart(4, '0')
  return `0x00${clean}AD`
}

export function BridgeLevel({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
  const [subnet, setSubnet] = useState('2C90')
  const [targetId, setTargetId] = useState('0x06FDEFF4')
  const [level, setLevel] = useState(50)

  const sourceId = subnetToSourceId(subnet)

  const handleSend = async (lvl?: number) => {
    const targetLevel = lvl ?? level
    showStatus(`Setting ${targetId} to ${targetLevel}%...`)
    try {
      const result = await post('/api/level', {
        source: sourceId,
        target: targetId,
        level: targetLevel
      })
      if (result.status === 'ok') {
        showStatus(`Set ${result.target} to ${result.level}%`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <Card title="Bridge Level" variant="bridge" collapsible defaultCollapsed>
      <p className="help-text">Set dimmer level via bridge protocol.</p>

      <div className="form-row">
        <FormGroup label="Subnet">
          <AutocompleteInput value={subnet} onChange={setSubnet} suggestions={seen.bridgeSubnets} width={70} />
        </FormGroup>
        <FormGroup label="Target">
          <AutocompleteInput value={targetId} onChange={setTargetId} suggestions={seen.dimmers} width={110} />
        </FormGroup>
        <FormGroup label="Level">
          <FormInput
            type="number"
            value={level}
            onChange={v => setLevel(parseInt(v) || 0)}
            width={50}
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
    </Card>
  )
}
