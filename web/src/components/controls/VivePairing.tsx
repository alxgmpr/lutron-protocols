import { useState, useEffect, useRef } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, FormInput } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

interface ViveDevice {
  device_id: string
  device_type: string
  rssi: number | null
  last_seen: number
}

export function VivePairing({ showStatus }: Props) {
  const { postJson } = useApi()
  const [hubId, setHubId] = useState('')
  const [zoneId, setZoneId] = useState('')
  const [isActive, setIsActive] = useState(false)
  const [discoveredDevices, setDiscoveredDevices] = useState<ViveDevice[]>([])
  const [elapsedTime, setElapsedTime] = useState(0)
  const timerRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)

  // Timer for elapsed time display
  useEffect(() => {
    if (isActive) {
      startTimeRef.current = Date.now()
      timerRef.current = window.setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }, 1000)
      return () => {
        if (timerRef.current) clearInterval(timerRef.current)
      }
    } else {
      setElapsedTime(0)
    }
  }, [isActive])

  const handleStart = async () => {
    if (!hubId.trim() || !zoneId.trim()) {
      showStatus('Hub ID and Zone ID are required', 'error')
      return
    }
    const fullHubId = '0x' + hubId.replace(/^0x/i, '')
    const zoneNum = parseInt(zoneId, 16)
    if (isNaN(zoneNum) || zoneNum < 1 || zoneNum > 255) {
      showStatus('Invalid zone ID (must be 01-FF hex)', 'error')
      return
    }
    showStatus(`Starting Vive pairing with hub ${fullHubId}, zone 0x${zoneId.toUpperCase()}...`)
    try {
      const result = await postJson('/api/vive/start', { hub_id: fullHubId, zone_id: zoneNum })
      if (result.status === 'ok') {
        setIsActive(true)
        setDiscoveredDevices([])
        showStatus('Vive pairing active - devices should flash', 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const handleStop = async () => {
    showStatus('Stopping Vive pairing...')
    try {
      await postJson('/api/vive/stop', {})
      setIsActive(false)
      showStatus('Vive pairing stopped', 'success')
    } catch (e) {
      showStatus(`Error stopping: ${e}`, 'error')
    }
  }

  const handleSendBurst = async () => {
    const fullHubId = '0x' + hubId.replace(/^0x/i, '')
    showStatus('Sending beacon burst...')
    try {
      await postJson('/api/vive/beacon', { hub_id: fullHubId, count: 9 })
      showStatus('Beacon burst sent', 'success')
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const handleAccept = async (deviceId: string) => {
    const fullHubId = '0x' + hubId.replace(/^0x/i, '')
    const zoneNum = parseInt(zoneId, 16)
    if (isNaN(zoneNum) || zoneNum < 0 || zoneNum > 255) {
      showStatus('Invalid zone ID (must be 00-FF hex)', 'error')
      return
    }
    showStatus(`Accepting device ${deviceId} to zone 0x${zoneId.toUpperCase()}...`)
    try {
      await postJson('/api/vive/accept', {
        hub_id: fullHubId,
        device_id: deviceId,
        zone_id: zoneNum
      })
      showStatus(`Accept sent: ${deviceId} → zone 0x${zoneId.toUpperCase()}`, 'success')
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  }

  return (
    <ControlSection title="Vive Pairing" storageKey="ctrl-vive-pairing">
      <div className="form-row">
        <FormGroup label="Hub ID">
          <FormInput
            value={hubId}
            onChange={v => setHubId(v.replace(/^0x/i, ''))}
            placeholder="AABBCCDD"
            width={80}
            disabled={isActive}
          />
        </FormGroup>
        {!isActive ? (
          <Button variant="green" onClick={handleStart}>Start</Button>
        ) : (
          <Button variant="red" onClick={handleStop}>Stop</Button>
        )}
      </div>

      {/* Zone selection */}
      <div className="form-row">
        <FormGroup label="Zone ID (hex)">
          <FormInput
            value={zoneId}
            onChange={v => setZoneId(v.replace(/^0x/i, '').slice(0, 2))}
            placeholder="38"
            width={50}
          />
        </FormGroup>
      </div>

      {isActive && (
        <div className="advanced-panel">
          <div className="advanced-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Pairing Active</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{formatTime(elapsedTime)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Beacons sent every 30s. Hold device button 5-10s to pair.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="blue" onClick={handleSendBurst}>
              Send Burst Now
            </Button>
          </div>
        </div>
      )}

      {/* Manual device accept section */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
          Manual Accept (enter device ID from B8 packet):
        </div>
        <ManualAccept onAccept={handleAccept} />
      </div>

      {discoveredDevices.length > 0 && (
        <div className="advanced-panel" style={{ marginTop: 8 }}>
          <div className="advanced-title">Discovered Devices</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {discoveredDevices.map(d => (
              <div key={d.device_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                <span style={{ fontFamily: 'monospace' }}>{d.device_id}</span>
                <span style={{ color: 'var(--text-muted)' }}>{d.device_type}</span>
                {d.rssi && <span style={{ color: 'var(--text-muted)' }}>{d.rssi}dBm</span>}
                <Button size="sm" variant="green" onClick={() => handleAccept(d.device_id)}>
                  Accept
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </ControlSection>
  )
}

// Sub-component for manual device accept
function ManualAccept({ onAccept }: { onAccept: (id: string) => void }) {
  const [deviceId, setDeviceId] = useState('')

  const handleSubmit = () => {
    if (deviceId.trim()) {
      const fullId = '0x' + deviceId.replace(/^0x/i, '')
      onAccept(fullId)
    }
  }

  return (
    <div className="form-row">
      <FormInput
        value={deviceId}
        onChange={setDeviceId}
        placeholder="021AD0C3"
        width={80}
      />
      <Button size="sm" variant="green" onClick={handleSubmit} disabled={!deviceId.trim()}>
        Accept
      </Button>
    </div>
  )
}
