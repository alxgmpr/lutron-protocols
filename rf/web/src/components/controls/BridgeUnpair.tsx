import { useState } from 'react'
import { Card, Button, FormGroup, FormInput } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeUnpair({ showStatus }: Props) {
  const { post } = useApi()
  const [bridgeId, setBridgeId] = useState('0x002C90AD')
  const [targetId, setTargetId] = useState('0x06F4587E')

  const handleUnpair = async () => {
    showStatus(`Unpairing ${targetId} from bridge ${bridgeId}...`)
    try {
      const result = await post('/api/unpair', {
        bridge: bridgeId,
        target: targetId
      })
      if (result.status === 'ok') {
        showStatus(`Unpair sent: ${result.bridge} -> ${result.target}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <Card title="Bridge Unpair Device" badge="REMOVE" variant="device">
      <p className="help-text">Send bridge-style unpair command to remove a device from the network. Captured from Caseta bridge removing devices.</p>
      <div className="form-row">
        <FormGroup label="Bridge ID">
          <FormInput value={bridgeId} onChange={setBridgeId} width={120} prefix="0x" />
        </FormGroup>
        <FormGroup label="Target Device">
          <FormInput value={targetId} onChange={setTargetId} width={120} prefix="0x" />
        </FormGroup>
        <Button variant="red" onClick={handleUnpair}>UNPAIR</Button>
      </div>
    </Card>
  )
}
