import { useState } from 'react'
import { Card, Button, FormGroup, AutocompleteInput } from '../common'
import { useDevices } from '../../context/DeviceContext'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeUnpair({ showStatus }: Props) {
  const { post } = useApi()
  const { seen } = useDevices()
  const [bridgeSubnet, setBridgeSubnet] = useState('2C90')
  const [targetId, setTargetId] = useState('0x06F4587E')

  // Compute zone IDs from subnet
  const cleanSubnet = bridgeSubnet.replace(/^0x/i, '').toUpperCase().padStart(4, '0')
  const zone1 = `0x00${cleanSubnet}AD`
  const zone2 = `0x00${cleanSubnet}AF`

  const handleUnpair = async () => {
    showStatus(`Unpairing ${targetId} from bridge ${cleanSubnet}...`)
    try {
      const params = {
        bridge: zone1,
        target: targetId,
        zone2: zone2
      }
      const result = await post('/api/unpair', params)
      if (result.status === 'ok') {
        showStatus(`Unpair: ${bridgeSubnet} -> ${result.target}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <Card title="Bridge Unpair" badge="REMOVE" variant="device" collapsible defaultCollapsed>
      <p className="help-text">
        Remove a device from bridge network. Sends two-phase unpair (prepare + unpair flood).
      </p>
      <div className="form-row">
        <FormGroup label="Subnet" hint={`Zones: ${zone1.slice(2)}, ${zone2.slice(2)}`}>
          <AutocompleteInput
            value={bridgeSubnet}
            onChange={setBridgeSubnet}
            suggestions={seen.bridgeSubnets}
            width={70}
            placeholder="2C90"
          />
        </FormGroup>
        <FormGroup label="Target Device">
          <AutocompleteInput
            value={targetId}
            onChange={setTargetId}
            suggestions={seen.dimmers}
            width={120}
            prefix="0x"
          />
        </FormGroup>
        <Button variant="red" onClick={handleUnpair}>UNPAIR</Button>
      </div>
    </Card>
  )
}
