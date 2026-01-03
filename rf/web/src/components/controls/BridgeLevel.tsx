import { useState } from 'react'
import { Card, Button, FormGroup, FormInput, QuickButtons } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeLevel({ showStatus }: Props) {
  const { post } = useApi()
  const [bridgeId, setBridgeId] = useState('0xAF902C00')
  const [targetId, setTargetId] = useState('0x06FDEFF4')
  const [level, setLevel] = useState(50)

  const handleSend = async (lvl?: number) => {
    const targetLevel = lvl ?? level
    showStatus(`Setting ${targetId} to ${targetLevel}%...`)
    try {
      const result = await post('/api/level', {
        source: bridgeId,
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
    <Card title="Bridge Level Control" badge="BRIDGE → DEVICE" variant="bridge">
      <div className="form-row">
        <FormGroup label="Bridge ID">
          <FormInput value={bridgeId} onChange={setBridgeId} width={120} />
        </FormGroup>
        <FormGroup label="Target ID">
          <FormInput value={targetId} onChange={setTargetId} width={120} />
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

