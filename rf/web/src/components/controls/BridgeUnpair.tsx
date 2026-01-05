import { useState } from 'react'
import { Card, Button, FormGroup, FormInput } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeUnpair({ showStatus }: Props) {
  const { post } = useApi()
  const [zone1, setZone1] = useState('0x002C90AD')
  const [zone2, setZone2] = useState('0x002C90AF')
  const [targetId, setTargetId] = useState('0x06F4587E')
  const [dualMode, setDualMode] = useState(true)

  const handleUnpair = async () => {
    const mode = dualMode && zone2 ? 'dual' : 'single'
    showStatus(`Unpairing ${targetId} (${mode} zone mode)...`)
    try {
      const params: Record<string, string> = {
        bridge: zone1,
        target: targetId
      }
      if (dualMode && zone2) {
        params.zone2 = zone2
      }
      const result = await post('/api/unpair', params)
      if (result.status === 'ok') {
        if (result.mode === 'dual') {
          showStatus(`Unpair (dual): ${result.zone1} + ${result.zone2} -> ${result.target}`, 'success')
        } else {
          showStatus(`Unpair: ${result.bridge} -> ${result.target}`, 'success')
        }
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <Card title="Bridge Unpair Device" badge="REMOVE" variant="device">
      <p className="help-text">
        Remove a device from bridge network. Dual-zone mode sends interleaved packets from both zones (like real bridge).
      </p>
      <div className="form-row">
        <FormGroup label="Zone 1">
          <FormInput value={zone1} onChange={setZone1} width={120} prefix="0x" />
        </FormGroup>
        <FormGroup label="Zone 2">
          <FormInput
            value={zone2}
            onChange={setZone2}
            width={120}
            prefix="0x"
            disabled={!dualMode}
          />
        </FormGroup>
        <FormGroup label="Dual">
          <input
            type="checkbox"
            checked={dualMode}
            onChange={e => setDualMode(e.target.checked)}
            style={{ width: 20, height: 20, cursor: 'pointer' }}
          />
        </FormGroup>
      </div>
      <div className="form-row">
        <FormGroup label="Target Device">
          <FormInput value={targetId} onChange={setTargetId} width={120} prefix="0x" />
        </FormGroup>
        <Button variant="red" onClick={handleUnpair}>UNPAIR</Button>
      </div>
    </Card>
  )
}
