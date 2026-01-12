import { useState } from 'react'
import { Card, Button, FormGroup, FormInput, QuickButtons, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

// Convert 4-char subnet to full bridge zone ID
// Pattern: subnet "2C90" -> source "0x002C90AD"
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
    <Card title="Bridge Level" badge="BRIDGE -> DEVICE" variant="bridge" collapsible defaultCollapsed>
      <p className="help-text">Set a dimmer's level via bridge protocol. Enter the bridge subnet (middle 4 hex digits from any bridge zone ID).</p>
      <div className="form-row">
        <FormGroup label="Subnet" hint={`Source: ${sourceId}`}>
          <AutocompleteInput value={subnet} onChange={setSubnet} suggestions={seen.bridgeSubnets} width={70} />
        </FormGroup>
        <FormGroup label="Target Device">
          <AutocompleteInput value={targetId} onChange={setTargetId} suggestions={seen.dimmers} width={120} prefix="0x" />
        </FormGroup>
        <FormGroup label="Level">
          <FormInput
            type="number"
            value={level}
            onChange={v => setLevel(parseInt(v) || 0)}
            width={60}
            min={0}
            max={100}
          />
        </FormGroup>
        <Button variant="blue" onClick={() => handleSend()}>SET</Button>
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

