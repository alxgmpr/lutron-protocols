import { useState } from 'react'
import { Card, FormGroup, FormInput } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeBeacon({ showStatus }: Props) {
  const { postJson } = useApi()
  const [bridgeId, setBridgeId] = useState('0xAF902C01')
  const [beaconActive, setBeaconActive] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleToggle = async () => {
    const newState = !beaconActive
    setLoading(true)

    try {
      // When turning ON, first set the device ID
      if (newState) {
        const deviceResult = await postJson('/api/beacon/device', {
          device_id: bridgeId
        })
        if (deviceResult.status !== 'ok') {
          showStatus(`Error setting device: ${deviceResult.error}`, 'error')
          setLoading(false)
          return
        }
      }

      const result = await postJson('/api/switch/beacon_mode', {
        state: newState
      })

      if (result.status === 'ok') {
        setBeaconActive(newState)
        showStatus(newState ? 'Beacon mode ON' : 'Beacon mode OFF', 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card title="Bridge Beacon Mode" badge="BRIDGE PAIRING" variant="bridge">
      <p className="help-text">
        Toggle beacon mode to put devices in pairing state. Devices within range will flash
        indicating they're ready to pair. Hold OFF on dimmer for 10 seconds to pair.
      </p>
      <div className="form-row">
        <FormGroup label="Bridge ID">
          <FormInput value={bridgeId} onChange={setBridgeId} width={120} prefix="0x" />
        </FormGroup>
        <div className="beacon-toggle-container">
          <label className="beacon-toggle-label">Beacon</label>
          <button
            className={`beacon-toggle ${beaconActive ? 'active' : ''} ${loading ? 'loading' : ''}`}
            onClick={handleToggle}
            disabled={loading}
          >
            <span className="toggle-track">
              <span className="toggle-thumb" />
            </span>
            <span className="toggle-text">{beaconActive ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      </div>
    </Card>
  )
}
