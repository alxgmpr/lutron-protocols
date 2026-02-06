import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeBeacon({ showStatus }: Props) {
  const { postJson } = useApi()

  const [subnet, setSubnet] = useState('2C90')
  const [beaconActive, setBeaconActive] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleToggleBeacon = async () => {
    setLoading(true)
    try {
      if (!beaconActive) {
        const result = await postJson('/api/pairing/start', { subnet: `0x${subnet}` })
        if (result.status === 'ok') {
          setBeaconActive(true)
          showStatus('Pairing beacon started - hold OFF on device 10s to pair', 'success')
        } else {
          showStatus(`Error: ${result.error}`, 'error')
        }
      } else {
        const result = await postJson('/api/pairing/stop', { subnet: `0x${subnet}` })
        if (result.status === 'ok') {
          setBeaconActive(false)
          showStatus('Pairing beacon stopped', 'success')
        } else {
          showStatus(`Error: ${result.error}`, 'error')
        }
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ControlSection title="Device Pairing" storageKey="ctrl-bridge-beacon">
      <div className="text-[11px] font-mono text-[var(--text-muted)] leading-snug">
        Auto-pair devices to ESP32 as bridge. Toggle beacon on, then hold OFF on device for 10 seconds. Device will be detected and configured automatically.
      </div>

      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">subnet:</span>
        <Input value={subnet} onChange={e => setSubnet(e.target.value)} className="w-[64px]" />
        <div className="flex-1" />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">beacon:</span>
        <button
          className={`relative h-[20px] w-[36px] rounded-full border transition-all duration-200 cursor-pointer shrink-0 ${beaconActive ? 'bg-[var(--accent-green)] border-[var(--accent-green)]' : 'bg-[var(--bg-tertiary)] border-[var(--border-primary)]'} ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
          onClick={handleToggleBeacon}
          disabled={loading}
        >
          <div className={`absolute top-[2px] size-3.5 rounded-full transition-all duration-200 ${beaconActive ? 'left-[17px] bg-white' : 'left-[2px] bg-[var(--text-secondary)]'} ${loading ? 'animate-pulse' : ''}`} />
        </button>
        <span className={`text-[11px] font-mono font-semibold ${beaconActive ? 'text-[var(--accent-green)]' : 'text-[var(--text-muted)]'}`}>
          {beaconActive ? 'ON' : 'OFF'}
        </span>
      </div>

      {beaconActive && (
        <div className="text-[11px] font-mono text-[var(--accent-green)]">
          beaconing active - hold OFF on device 10s to auto-pair
        </div>
      )}
    </ControlSection>
  )
}
