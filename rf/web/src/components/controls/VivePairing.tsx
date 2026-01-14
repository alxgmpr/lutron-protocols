import { useState } from 'react'
import { Card, FormGroup, FormInput, Button } from '../common'
import { useApi } from '../../hooks/useApi'
import './ControlPanel.css'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function VivePairing({ showStatus }: Props) {
  const { postJson } = useApi()

  const [subnet, setSubnet] = useState('2C90')
  const [packetType, setPacketType] = useState('92')
  const [protocol, setProtocol] = useState('21')
  const [format, setFormat] = useState('0C')
  const [mode, setMode] = useState('02')

  const [active, setActive] = useState(false)
  const [sweepMode, setSweepMode] = useState(false)
  const [loading, setLoading] = useState(false)

  const parseHex = (s: string) => parseInt(s, 16) || 0

  const handleManual = async () => {
    setLoading(true)
    try {
      const result = await postJson('/api/vive/manual', {
        subnet: `0x${subnet}`,
        packet_type: parseHex(packetType),
        protocol: parseHex(protocol),
        format: parseHex(format),
        mode: parseHex(mode)
      })
      if (result.status === 'ok') {
        setActive(true)
        setSweepMode(false)
        showStatus(`Manual mode: type=${result.packet_type} proto=${result.protocol}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleSweep = async () => {
    setLoading(true)
    try {
      const result = await postJson('/api/vive/sweep', {
        subnet: `0x${subnet}`
      })
      if (result.status === 'ok') {
        setActive(true)
        setSweepMode(true)
        showStatus('Sweep mode started - watch for RMJS flash', 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleStop = async () => {
    setLoading(true)
    try {
      const result = await postJson('/api/vive/stop', {})
      if (result.status === 'ok') {
        setActive(false)
        setSweepMode(false)
        showStatus('Vive pairing stopped', 'success')
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
    <Card title="Vive Pairing" variant="experiment" collapsible defaultCollapsed>
      <p className="help-text">
        Beacon experiment for RMJS PowPaks. Manual mode lets you set specific values, sweep mode cycles through all variations.
      </p>

      <div className="form-row">
        <FormGroup label="Subnet">
          <FormInput value={subnet} onChange={setSubnet} width={60} disabled={active} />
        </FormGroup>
        <FormGroup label="Type">
          <FormInput value={packetType} onChange={setPacketType} width={40} disabled={active} />
        </FormGroup>
        <FormGroup label="Proto">
          <FormInput value={protocol} onChange={setProtocol} width={40} disabled={active} />
        </FormGroup>
        <FormGroup label="Fmt">
          <FormInput value={format} onChange={setFormat} width={40} disabled={active} />
        </FormGroup>
        <FormGroup label="Mode">
          <FormInput value={mode} onChange={setMode} width={40} disabled={active} />
        </FormGroup>
      </div>

      <div className="form-row">
        {active ? (
          <Button variant="red" onClick={handleStop} disabled={loading}>Stop</Button>
        ) : (
          <>
            <Button variant="green" onClick={handleManual} disabled={loading}>Manual</Button>
            <Button variant="blue" onClick={handleSweep} disabled={loading}>Sweep</Button>
          </>
        )}
      </div>

      {active && (
        <div className="advanced-panel">
          <div className="vive-status">
            <span className={`status-badge ${sweepMode ? 'status-sweep' : 'status-manual'}`}>
              {sweepMode ? 'Sweep Active' : 'Manual Active'}
            </span>
            <p className="info-line" style={{ marginTop: '8px', borderTop: 'none', paddingTop: 0 }}>
              {sweepMode
                ? 'Cycling through packet types 0x90-0x9F with various protocol/format bytes (~2.5s each).'
                : `Sending: type=0x${packetType} proto=0x${protocol} fmt=0x${format} mode=0x${mode}`}
            </p>
            <p className="info-line" style={{ borderTop: 'none', paddingTop: 0, color: 'var(--text-muted)' }}>
              Watch the RMJS for any flash response.
            </p>
          </div>
        </div>
      )}

      <div className="vive-presets">
        <span className="presets-label">Presets:</span>
        <button
          className="preset-btn"
          disabled={active}
          onClick={() => { setPacketType('92'); setProtocol('21'); setFormat('0C'); setMode('02'); }}
        >
          0x92 Active
        </button>
        <button
          className="preset-btn"
          disabled={active}
          onClick={() => { setPacketType('93'); setProtocol('21'); setFormat('08'); setMode('01'); }}
        >
          0x93 Initial
        </button>
        <button
          className="preset-btn"
          disabled={active}
          onClick={() => { setPacketType('91'); setProtocol('21'); setFormat('0C'); setMode('02'); }}
        >
          0x91 Active
        </button>
      </div>

      <style>{`
        .vive-status {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .status-badge {
          padding: 4px 10px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          width: fit-content;
        }
        .status-manual {
          background: var(--accent-green);
          color: white;
        }
        .status-sweep {
          background: var(--accent-orange);
          color: white;
        }
        .vive-presets {
          margin-top: 12px;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .presets-label {
          font-size: 11px;
          color: var(--text-muted);
        }
        .preset-btn {
          padding: 4px 8px;
          font-size: 10px;
          font-family: 'JetBrains Mono', monospace;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-primary);
          border-radius: 3px;
          color: var(--text-secondary);
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .preset-btn:hover:not(:disabled) {
          background: var(--bg-elevated);
          border-color: var(--border-accent);
          color: var(--text-primary);
        }
        .preset-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </Card>
  )
}
