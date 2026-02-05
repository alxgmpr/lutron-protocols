import { useState } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, FormInput } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function ViveControl({ showStatus }: Props) {
  const { postJson } = useApi()
  const [hubId, setHubId] = useState('')
  const [zoneId, setZoneId] = useState('')

  const sendCommand = async (action: 'on' | 'off' | 'raise' | 'lower') => {
    if (!hubId.trim() || !zoneId.trim()) {
      showStatus('Hub ID and Zone ID are required', 'error')
      return
    }
    const fullHubId = '0x' + hubId.replace(/^0x/i, '')
    const zone = parseInt(zoneId, 16)
    if (isNaN(zone) || zone < 1 || zone > 255) {
      showStatus('Invalid zone ID (must be 01-FF hex)', 'error')
      return
    }

    showStatus(`Sending ${action.toUpperCase()} to hub ${fullHubId} zone 0x${zoneId.toUpperCase()}...`)
    try {
      const result = await postJson(`/api/vive/${action}`, {
        hub_id: fullHubId,
        zone_id: zone
      })
      if (result.status === 'ok') {
        showStatus(`${action.toUpperCase()} sent to zone 0x${zoneId.toUpperCase()}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Vive Zone Control" storageKey="ctrl-vive-control">
      <div className="form-row">
        <FormGroup label="Hub ID">
          <FormInput
            value={hubId}
            onChange={v => setHubId(v.replace(/^0x/i, ''))}
            placeholder="AABBCCDD"
            width={80}
          />
        </FormGroup>
        <FormGroup label="Zone (hex)">
          <FormInput
            value={zoneId}
            onChange={v => setZoneId(v.replace(/^0x/i, '').slice(0, 2))}
            placeholder="38"
            width={50}
          />
        </FormGroup>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="green" onClick={() => sendCommand('on')}>
          ON
        </Button>
        <Button variant="red" onClick={() => sendCommand('off')}>
          OFF
        </Button>
        <Button variant="blue" onClick={() => sendCommand('raise')}>
          Raise
        </Button>
        <Button variant="blue" onClick={() => sendCommand('lower')}>
          Lower
        </Button>
      </div>
    </ControlSection>
  )
}
