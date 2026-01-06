import { useState, useEffect, useRef } from 'react'
import { Card, Button, FormGroup, FormInput } from '../common'
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
  timestamp: string
}

interface PairingStatus {
  state: string
  subnet: string
  bridge_zone_ad: string
  bridge_zone_af: string
  discovered_devices: DiscoveredDevice[]
  selected_device: string | null
  assigned_load_id: string | null
  handshake_round: number
  error: string | null
}

type PairingState = 'IDLE' | 'BEACON' | 'AWAIT_B0' | 'CONFIG' | 'STATE_RPT' | 'HANDSHAKE' | 'COMPLETE' | 'ERROR'

const STATE_LABELS: Record<PairingState, string> = {
  'IDLE': 'Ready',
  'BEACON': 'Broadcasting...',
  'AWAIT_B0': 'Waiting for devices...',
  'CONFIG': 'Configuring...',
  'STATE_RPT': 'Finalizing...',
  'HANDSHAKE': 'Handshaking...',
  'COMPLETE': 'Complete',
  'ERROR': 'Error'
}

const DEVICE_TYPE_NAMES: Record<number, string> = {
  0x04: 'Dimmer',
  0x01: 'Switch',
  0x02: 'Fan',
  0x00: 'Unknown'
}

export function BridgePairing({ showStatus }: Props) {
  const { post, get } = useApi()
  const [subnet, setSubnet] = useState('0x2C90')
  const [duration, setDuration] = useState(60)
  const [zoneSuffix, setZoneSuffix] = useState('0x80')
  const [pairingStatus, setPairingStatus] = useState<PairingStatus | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const pollIntervalRef = useRef<number | null>(null)

  // Poll for status updates while pairing is active
  useEffect(() => {
    if (isPolling) {
      const poll = async () => {
        try {
          const status = await get<PairingStatus>('/api/bridge/pair/status')
          setPairingStatus(status)

          // Stop polling if complete or error
          if (status.state === 'COMPLETE' || status.state === 'ERROR' || status.state === 'IDLE') {
            if (status.state === 'COMPLETE') {
              showStatus('Pairing complete!', 'success')
            } else if (status.state === 'ERROR') {
              showStatus(`Error: ${status.error}`, 'error')
            }
            setIsPolling(false)
          }
        } catch (e) {
          console.error('Poll error:', e)
        }
      }

      poll()
      pollIntervalRef.current = window.setInterval(poll, 1000)

      return () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
      }
    }
  }, [isPolling, get, showStatus])

  const handleStartPairing = async () => {
    showStatus('Starting bridge pairing...')
    try {
      const result = await post('/api/bridge/pair', { subnet, duration: duration.toString() })
      if (result.status === 'ok') {
        showStatus(`Beaconing on subnet ${subnet}...`)
        setIsPolling(true)
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const handleStopPairing = async () => {
    try {
      await post('/api/bridge/pair/stop', {})
      showStatus('Pairing stopped')
      setIsPolling(false)
      setPairingStatus(null)
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const handleSelectDevice = async (device: DiscoveredDevice) => {
    showStatus(`Selecting ${device.hw_id_hex}...`)
    try {
      const result = await post('/api/bridge/pair/select', {
        hw_id: device.hw_id_hex,
        zone_suffix: zoneSuffix
      })
      if (result.status === 'ok') {
        showStatus(`Configuring ${device.hw_id_hex}...`)
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const state = pairingStatus?.state as PairingState || 'IDLE'
  const isActive = state !== 'IDLE' && state !== 'COMPLETE' && state !== 'ERROR'
  const canStart = state === 'IDLE' || state === 'COMPLETE' || state === 'ERROR'
  const canSelect = state === 'AWAIT_B0' && (pairingStatus?.discovered_devices?.length ?? 0) > 0

  return (
    <Card title="Bridge Pairing" badge="BRIDGE → DIMMER" variant="pairing">
      <p className="help-text">
        Pair dimmers to ESP32 as a bridge. Sends beacons to make dimmers discoverable.
      </p>

      <div className="form-row">
        <FormGroup label="Subnet">
          <FormInput
            value={subnet}
            onChange={setSubnet}
            width={80}
            disabled={isActive}
          />
        </FormGroup>
        <FormGroup label="Timeout (s)">
          <FormInput
            type="number"
            value={duration}
            onChange={v => setDuration(parseInt(v) || 60)}
            width={60}
            min={10}
            max={120}
            disabled={isActive}
          />
        </FormGroup>
        <FormGroup label="Zone Suffix">
          <FormInput
            value={zoneSuffix}
            onChange={setZoneSuffix}
            width={60}
            disabled={isActive}
          />
        </FormGroup>
        {canStart ? (
          <Button variant="green" onClick={handleStartPairing}>START</Button>
        ) : (
          <Button variant="red" onClick={handleStopPairing}>STOP</Button>
        )}
      </div>

      {pairingStatus && (
        <div className="advanced-panel">
          <div className="pairing-status">
            <div className="status-header">
              <span className={`status-badge status-${state.toLowerCase()}`}>
                {STATE_LABELS[state]}
              </span>
              {state === 'HANDSHAKE' && (
                <span className="handshake-progress">
                  Round {pairingStatus.handshake_round}/6
                </span>
              )}
            </div>

            {pairingStatus.bridge_zone_ad && (
              <div className="zone-info">
                Zones: {pairingStatus.bridge_zone_ad}, {pairingStatus.bridge_zone_af}
              </div>
            )}

            {pairingStatus.discovered_devices.length > 0 && (
              <div className="discovered-devices">
                <div className="advanced-title">Discovered Devices</div>
                {pairingStatus.discovered_devices.map(device => (
                  <div key={device.hw_id} className="device-row">
                    <span className="device-id">{device.hw_id_hex}</span>
                    <span className="device-type">
                      {DEVICE_TYPE_NAMES[device.device_type] || `Type ${device.device_type}`}
                    </span>
                    {device.rssi && <span className="device-rssi">RSSI: {device.rssi}</span>}
                    {canSelect && (
                      <Button
                        variant="blue"
                        size="sm"
                        onClick={() => handleSelectDevice(device)}
                      >
                        SELECT
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {pairingStatus.selected_device && (
              <div className="selected-device">
                Selected: {pairingStatus.selected_device}
                {pairingStatus.assigned_load_id && (
                  <span> → {pairingStatus.assigned_load_id}</span>
                )}
              </div>
            )}

            {pairingStatus.error && (
              <div className="pairing-error">{pairingStatus.error}</div>
            )}
          </div>
        </div>
      )}

      <style>{`
        .pairing-status {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .status-header {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .status-badge {
          padding: 4px 10px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .status-idle { background: var(--bg-tertiary); color: var(--text-muted); }
        .status-beacon, .status-await_b0 { background: var(--accent-blue); color: white; }
        .status-config, .status-state_rpt { background: var(--accent-purple); color: white; }
        .status-handshake { background: var(--accent-orange); color: white; }
        .status-complete { background: var(--accent-green); color: white; }
        .status-error { background: var(--accent-red); color: white; }

        .handshake-progress {
          font-size: 12px;
          color: var(--text-secondary);
          font-family: 'JetBrains Mono', monospace;
        }

        .zone-info {
          font-size: 11px;
          color: var(--text-muted);
          font-family: 'JetBrains Mono', monospace;
        }

        .discovered-devices {
          margin-top: 8px;
        }

        .device-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px;
          background: var(--bg-secondary);
          border-radius: 4px;
          margin-top: 6px;
        }

        .device-id {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          font-weight: 600;
          color: var(--accent-cyan);
        }

        .device-type {
          font-size: 11px;
          color: var(--text-secondary);
        }

        .device-rssi {
          font-size: 11px;
          color: var(--text-muted);
          font-family: 'JetBrains Mono', monospace;
          margin-left: auto;
        }

        .selected-device {
          font-size: 12px;
          color: var(--accent-green);
          font-family: 'JetBrains Mono', monospace;
        }

        .pairing-error {
          font-size: 12px;
          color: var(--accent-red);
          padding: 8px;
          background: rgba(255, 82, 82, 0.1);
          border-radius: 4px;
        }
      `}</style>
    </Card>
  )
}
