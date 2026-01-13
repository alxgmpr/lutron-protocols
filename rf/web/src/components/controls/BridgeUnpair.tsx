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
    <Card title="Bridge Unpair" variant="device" collapsible defaultCollapsed>
      <p className="help-text">
        Remove a device from bridge network.
      </p>

      <div className="form-row">
        <FormGroup label="Subnet">
          <AutocompleteInput
            value={bridgeSubnet}
            onChange={setBridgeSubnet}
            suggestions={seen.bridgeSubnets}
            width={70}
          />
        </FormGroup>
        <FormGroup label="Target">
          <AutocompleteInput
            value={targetId}
            onChange={setTargetId}
            suggestions={seen.dimmers}
            width={110}
          />
        </FormGroup>
        <Button variant="red" onClick={handleUnpair}>Unpair</Button>
      </div>
    </Card>
  )
}
