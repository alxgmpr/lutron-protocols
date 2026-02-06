import { useState, useEffect, useRef } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

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
      showStatus(`Accept sent: ${deviceId} -> zone 0x${zoneId.toUpperCase()}`, 'success')
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
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">hub:</span>
        <Input
          value={hubId}
          onChange={e => setHubId(e.target.value.replace(/^0x/i, ''))}
          placeholder="AABBCCDD"
          disabled={isActive}
          className="w-[100px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">zone:</span>
        <Input
          value={zoneId}
          onChange={e => setZoneId(e.target.value.replace(/^0x/i, '').slice(0, 2))}
          placeholder="38"
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

      {isActive && (
        <div className="border border-[var(--border-primary)] rounded p-3 font-mono text-[11px]">
          <div className="flex justify-between items-center text-[var(--text-muted)] mb-2">
            <span>status: <span className="text-[var(--accent-green)]">ACTIVE</span></span>
            <span>{formatTime(elapsedTime)}</span>
          </div>
          <div className="text-[var(--text-muted)] mb-2">
            beacons every 30s. hold device button 5-10s to pair.
          </div>
          <Button size="sm" variant="blue" onClick={handleSendBurst}>
            <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="6" cy="6" r="1.5"/><path d="M3.5 3.5a3.5 3.5 0 0 0 0 5M8.5 3.5a3.5 3.5 0 0 1 0 5"/></svg>
            Burst Now
          </Button>
        </div>
      )}

      <div className="border-t border-[var(--border-primary)] pt-2">
        <div className="text-[11px] font-mono text-[var(--text-muted)] mb-2">
          manual accept (device ID from B8 packet):
        </div>
        <ManualAccept onAccept={handleAccept} />
      </div>

      {discoveredDevices.length > 0 && (
        <div className="border border-[var(--border-primary)] rounded p-3 font-mono text-[11px]">
          <div className="text-[var(--text-muted)] mb-2">discovered:</div>
          <div className="flex flex-col gap-1.5">
            {discoveredDevices.map(d => (
              <div key={d.device_id} className="flex items-center gap-3">
                <span className="text-[var(--text-primary)]">{d.device_id}</span>
                <span className="text-[var(--text-muted)]">{d.device_type}</span>
                {d.rssi && <span className="text-[var(--text-muted)]">{d.rssi}dBm</span>}
                <Button size="xs" variant="green" onClick={() => handleAccept(d.device_id)}>
                  <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6l2.5 3 5-6"/></svg>
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

function ManualAccept({ onAccept }: { onAccept: (id: string) => void }) {
  const [deviceId, setDeviceId] = useState('')

  const handleSubmit = () => {
    if (deviceId.trim()) {
      const fullId = '0x' + deviceId.replace(/^0x/i, '')
      onAccept(fullId)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Input
        value={deviceId}
        onChange={e => setDeviceId(e.target.value)}
        placeholder="021AD0C3"
        className="w-[100px]"
      />
      <Button size="sm" variant="green" onClick={handleSubmit} disabled={!deviceId.trim()}>
        <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6l2.5 3 5-6"/></svg>
        Accept
      </Button>
    </div>
  )
}
