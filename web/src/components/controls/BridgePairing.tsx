import { useState, useEffect, useRef } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, FormInput } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

interface DiscoveredDevice {
  hw_id: number
  hw_id_hex: string
  device_type: number
  rssi: number | null
}

interface PairingStatus {
  state: string
  discovered_devices: DiscoveredDevice[]
  selected_device: string | null
  handshake_round: number
  error: string | null
}

const DEVICE_TYPES: Record<number, string> = {
  0x04: 'Dimmer', 0x01: 'Switch', 0x02: 'Fan'
}

export function BridgePairing({ showStatus }: Props) {
  const { post, get } = useApi()
  const [subnet, setSubnet] = useState('2C90')
  const [duration, setDuration] = useState(60)
  const [status, setStatus] = useState<PairingStatus | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const pollRef = useRef<number | null>(null)

  useEffect(() => {
    if (isPolling) {
      const poll = async () => {
        try {
          const s = await get<PairingStatus>('/api/bridge/pair/status')
          setStatus(s)
          if (s.state === 'COMPLETE' || s.state === 'ERROR' || s.state === 'IDLE') {
            if (s.state === 'COMPLETE') showStatus('Pairing complete!', 'success')
            else if (s.state === 'ERROR') showStatus(`Error: ${s.error}`, 'error')
            setIsPolling(false)
          }
        } catch (e) {
          console.error('Poll error:', e)
        }
      }
      poll()
      pollRef.current = window.setInterval(poll, 1000)
      return () => { if (pollRef.current) clearInterval(pollRef.current) }
    }
  }, [isPolling, get, showStatus])

  const handleStart = async () => {
    showStatus('Starting bridge pairing...')
    try {
      const result = await post('/api/bridge/pair', {
        subnet: '0x' + subnet.replace(/^0x/i, ''),
        duration: duration.toString()
      })
      if (result.status === 'ok') {
        showStatus(`Beaconing on ${subnet}...`)
        setIsPolling(true)
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const handleStop = async () => {
    await post('/api/bridge/pair/stop', {})
    showStatus('Stopped')
    setIsPolling(false)
    setStatus(null)
  }

  const handleSelect = async (device: DiscoveredDevice) => {
    showStatus(`Selecting ${device.hw_id_hex}...`)
    await post('/api/bridge/pair/select', { hw_id: device.hw_id_hex, zone_suffix: '0x80' })
  }

  const isActive = status && !['IDLE', 'COMPLETE', 'ERROR'].includes(status.state)
  const canSelect = status?.state === 'AWAIT_B0' && (status?.discovered_devices?.length ?? 0) > 0

  return (
    <ControlSection title="Bridge Pairing" storageKey="ctrl-bridge-pairing">
      <div className="form-row">
        <FormGroup label="Subnet">
          <FormInput
            value={subnet}
            onChange={v => setSubnet(v.replace(/^0x/i, ''))}
            width={60}
            disabled={!!isActive}
          />
        </FormGroup>
        <FormGroup label="Timeout">
          <FormInput
            type="number"
            value={duration}
            onChange={v => setDuration(parseInt(v) || 60)}
            width={45}
            disabled={!!isActive}
          />
        </FormGroup>
        {!isActive ? (
          <Button variant="green" onClick={handleStart}>Start</Button>
        ) : (
          <Button variant="red" onClick={handleStop}>Stop</Button>
        )}
      </div>

      {status && status.state !== 'IDLE' && (
        <div className="advanced-panel">
          <div className="advanced-title">
            {status.state} {status.state === 'HANDSHAKE' && `(${status.handshake_round}/6)`}
          </div>
          {status.discovered_devices.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {status.discovered_devices.map(d => (
                <div key={d.hw_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                  <span style={{ fontFamily: 'monospace' }}>{d.hw_id_hex.replace(/^0x/i, '')}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{DEVICE_TYPES[d.device_type] || 'Unknown'}</span>
                  {canSelect && (
                    <Button size="sm" variant="blue" onClick={() => handleSelect(d)}>Select</Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {status.error && <div style={{ color: 'var(--accent-red)', fontSize: 11 }}>{status.error}</div>}
        </div>
      )}
    </ControlSection>
  )
}
