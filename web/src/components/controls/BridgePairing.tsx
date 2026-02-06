import { useState, useEffect, useRef } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

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
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">subnet:</span>
        <Input
          value={subnet}
          onChange={e => setSubnet(e.target.value.replace(/^0x/i, ''))}
          disabled={!!isActive}
          className="w-[64px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">timeout:</span>
        <Input
          type="number"
          value={duration}
          onChange={e => setDuration(parseInt(e.target.value) || 60)}
          disabled={!!isActive}
          className="w-[48px]"
        />
        {!isActive ? (
          <Button variant="green" onClick={handleStart}>
            <svg className="size-3" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7.5-4.5z"/></svg>
            Start
          </Button>
        ) : (
          <Button variant="red" onClick={handleStop}>
            <svg className="size-3" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>
            Stop
          </Button>
        )}
      </div>

      {status && status.state !== 'IDLE' && (
        <div className="border border-[var(--border-primary)] rounded p-3 font-mono text-[11px]">
          <div className="text-[var(--text-muted)] mb-2">
            state: <span className="text-[var(--accent-cyan)]">{status.state}</span>
            {status.state === 'HANDSHAKE' && <span className="text-[var(--text-muted)]"> ({status.handshake_round}/6)</span>}
          </div>
          {status.discovered_devices.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {status.discovered_devices.map(d => (
                <div key={d.hw_id} className="flex items-center gap-3">
                  <span className="text-[var(--text-primary)]">{d.hw_id_hex.replace(/^0x/i, '')}</span>
                  <span className="text-[var(--text-muted)]">{DEVICE_TYPES[d.device_type] || `type:${d.device_type}`}</span>
                  {canSelect && (
                    <Button size="xs" variant="blue" onClick={() => handleSelect(d)}>Select</Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {status.error && <div className="text-[var(--accent-red)] mt-1">{status.error}</div>}
        </div>
      )}
    </ControlSection>
  )
}
