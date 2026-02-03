import { useState } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, AutocompleteInput } from '../common'
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
  const [targetId, setTargetId] = useState('06F4587E')

  const handleUnpair = async () => {
    const cleanSubnet = bridgeSubnet.replace(/^0x/i, '').toUpperCase().padStart(4, '0')
    const zone1 = `0x00${cleanSubnet}AD`
    const zone2 = `0x00${cleanSubnet}AF`

    showStatus(`Unpairing ${targetId}...`)
    try {
      const result = await post('/api/unpair', {
        bridge: zone1,
        target: '0x' + targetId.replace(/^0x/i, ''),
        zone2: zone2
      })
      if (result.status === 'ok') {
        showStatus(`Unpaired ${targetId}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Bridge Unpair" storageKey="ctrl-bridge-unpair">
      <div className="form-row">
        <FormGroup label="Subnet">
          <AutocompleteInput
            value={bridgeSubnet}
            onChange={v => setBridgeSubnet(v.replace(/^0x/i, ''))}
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
        <Button variant="red" onClick={handleUnpair}>Unpair</Button>
      </div>
    </ControlSection>
  )
}
