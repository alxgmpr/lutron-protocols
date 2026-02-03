import { useState } from 'react'
import { ControlSection } from './ControlsPanel'
import { Button, FormGroup, FormInput } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

// Known zones from pairing capture (2026-01-28)
const KNOWN_ZONES = [
  { id: 0x38, name: 'Room 1', device: '020AE675', type: 'Relay/PowerPack' },
  { id: 0x47, name: 'Room 2', device: '09626657', type: '0-10V Dimmer' },
  { id: 0x4b, name: 'Room 3', device: '021AD0C3', type: 'Simple Relay' },
]

export function ViveControl({ showStatus }: Props) {
  const { postJson } = useApi()
  const [hubId, setHubId] = useState('YYYYYYYY')
  const [zoneId, setZoneId] = useState('4b')
  const [customZone, setCustomZone] = useState(false)

  const sendCommand = async (action: 'on' | 'off' | 'raise' | 'lower') => {
    const fullHubId = '0x' + hubId.replace(/^0x/i, '')
    const zone = parseInt(zoneId, 16)

    showStatus(`Sending ${action.toUpperCase()} to zone 0x${zoneId}...`)
    try {
      const result = await postJson(`/api/vive/${action}`, {
        hub_id: fullHubId,
        zone_id: zone
      })
      if (result.status === 'ok') {
        showStatus(`${action.toUpperCase()} sent to zone 0x${zoneId}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const selectZone = (id: number) => {
    setZoneId(id.toString(16))
    setCustomZone(false)
  }

  return (
    <ControlSection title="Vive Zone Control" storageKey="ctrl-vive-control">
      <div className="form-row">
        <FormGroup label="Hub ID">
          <FormInput
            value={hubId}
            onChange={v => setHubId(v.replace(/^0x/i, ''))}
            placeholder="YYYYYYYY"
            width={80}
          />
        </FormGroup>
      </div>

      {/* Zone selection */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
          Select Zone:
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {KNOWN_ZONES.map(z => (
            <button
              key={z.id}
              onClick={() => selectZone(z.id)}
              className={`zone-btn ${parseInt(zoneId, 16) === z.id && !customZone ? 'active' : ''}`}
              title={`${z.device} (${z.type})`}
            >
              0x{z.id.toString(16).toUpperCase()}
            </button>
          ))}
          <button
            onClick={() => setCustomZone(true)}
            className={`zone-btn ${customZone ? 'active' : ''}`}
          >
            Custom
          </button>
        </div>
      </div>

      {/* Custom zone input */}
      {customZone && (
        <div className="form-row" style={{ marginBottom: 12 }}>
          <FormGroup label="Zone ID (hex)">
            <FormInput
              value={zoneId}
              onChange={v => setZoneId(v.replace(/^0x/i, ''))}
              placeholder="4b"
              width={50}
            />
          </FormGroup>
        </div>
      )}

      {/* Control buttons */}
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

      {/* Zone info */}
      {!customZone && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          {KNOWN_ZONES.find(z => z.id === parseInt(zoneId, 16))?.type || 'Unknown'} -
          Device {KNOWN_ZONES.find(z => z.id === parseInt(zoneId, 16))?.device || '?'}
        </div>
      )}

      <style>{`
        .zone-btn {
          padding: 4px 8px;
          font-size: 11px;
          font-family: monospace;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 4px;
          cursor: pointer;
          color: var(--text);
        }
        .zone-btn:hover {
          background: var(--bg-tertiary);
        }
        .zone-btn.active {
          background: var(--accent);
          color: white;
          border-color: var(--accent);
        }
      `}</style>
    </ControlSection>
  )
}
