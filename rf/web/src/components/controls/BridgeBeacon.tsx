import { useState, useEffect, useRef } from 'react'
import { Card, FormGroup, FormInput, Button } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeBeacon({ showStatus }: Props) {
  const { postJson } = useApi()

  // Subnet-based inputs (simpler than full bridge ID)
  const [subnet, setSubnet] = useState('2C90')
  const [factoryId, setFactoryId] = useState('0707DF6A')
  const [zoneSuffix, setZoneSuffix] = useState('8F')

  const [beaconActive, setBeaconActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const beaconActiveRef = useRef(beaconActive)

  // Keep ref in sync
  useEffect(() => {
    beaconActiveRef.current = beaconActive
  }, [beaconActive])

  // Computed zone ID for display
  const computedZone = `06${subnet}${zoneSuffix}`

  const startBeacon = async () => {
    try {
      const result = await postJson('/api/pairing/start', {
        subnet: `0x${subnet}`
      })
      if (result.status !== 'ok') {
        showStatus(`Error: ${result.error}`, 'error')
        return false
      }
      return true
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
      return false
    }
  }

  const stopBeacon = async () => {
    try {
      const result = await postJson('/api/pairing/stop', {
        subnet: `0x${subnet}`
      })
      if (result.status !== 'ok') {
        showStatus(`Error: ${result.error}`, 'error')
        return false
      }
      return true
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
      return false
    }
  }

  const handleToggleBeacon = async () => {
    setLoading(true)
    try {
      if (!beaconActive) {
        const ok = await startBeacon()
        if (ok) {
          setBeaconActive(true)
          showStatus('Pairing beacon started - devices should flash', 'success')
        }
      } else {
        const ok = await stopBeacon()
        if (ok) {
          setBeaconActive(false)
          showStatus('Pairing beacon stopped', 'success')
        }
      }
    } finally {
      setLoading(false)
    }
  }

  const handlePairDevice = async () => {
    setLoading(true)
    try {
      // Briefly stop beacon during assignment
      const wasActive = beaconActiveRef.current
      if (wasActive) {
        await stopBeacon()
      }

      const result = await postJson('/api/pairing/pair', {
        subnet: `0x${subnet}`,
        factory_id: `0x${factoryId}`,
        zone_suffix: `0x${zoneSuffix}`
      })

      if (result.status === 'ok') {
        setBeaconActive(false)
        showStatus(`Paired! Device should respond to zone 0x${computedZone}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
        // Resume beacon if it was active
        if (wasActive) {
          await startBeacon()
          setBeaconActive(true)
        }
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleSendAssignment = async () => {
    setLoading(true)
    try {
      // Briefly pause beacon during assignment
      const wasActive = beaconActiveRef.current
      if (wasActive) {
        await stopBeacon()
      }

      const result = await postJson('/api/pairing/assign', {
        subnet: `0x${subnet}`,
        factory_id: `0x${factoryId}`,
        zone_suffix: `0x${zoneSuffix}`
      })

      if (result.status === 'ok') {
        showStatus('Assignment packets sent', 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }

      // Resume beacon if it was active
      if (wasActive) {
        await startBeacon()
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card title="Bridge Pairing" badge="EXPERIMENTAL" variant="bridge">
      <p className="help-text">
        Pair devices to our ESP32 as a bridge. Toggle beacon on, hold OFF on device for 10 seconds,
        then click Pair Device. Zone: 0x{computedZone}
      </p>

      <div className="form-row">
        <FormGroup label="Subnet" hint="e.g. 2C90">
          <FormInput value={subnet} onChange={setSubnet} width={80} />
        </FormGroup>
        <FormGroup label="Factory ID" hint="from device label">
          <FormInput value={factoryId} onChange={setFactoryId} width={100} />
        </FormGroup>
        <FormGroup label="Zone" hint={`-> 0x${computedZone}`}>
          <FormInput value={zoneSuffix} onChange={setZoneSuffix} width={60} />
        </FormGroup>
      </div>

      <div className="form-row" style={{ marginTop: '12px', alignItems: 'center' }}>
        <div className="beacon-toggle-container">
          <span className="beacon-toggle-label">Pairing Beacon</span>
          <button
            className={`beacon-toggle ${beaconActive ? 'active' : ''} ${loading ? 'loading' : ''}`}
            onClick={handleToggleBeacon}
            disabled={loading}
          >
            <div className="toggle-track">
              <div className="toggle-thumb" />
            </div>
            <span className="toggle-text">{beaconActive ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      </div>

      <div className="form-row" style={{ marginTop: '12px' }}>
        <Button
          variant="primary"
          onClick={handlePairDevice}
          disabled={loading}
          title="Complete sequence: beacon + assignment + stop"
        >
          Pair Device
        </Button>
        <Button
          variant="blue"
          onClick={handleSendAssignment}
          disabled={loading}
          title="Send B0 assignment packets only"
        >
          Send Assignment
        </Button>
      </div>

      {beaconActive && (
        <p className="status-text active" style={{ marginTop: '12px', color: 'var(--accent-green)' }}>
          Beaconing active - hold OFF on device for 10 seconds, then click Pair Device
        </p>
      )}
    </Card>
  )
}


