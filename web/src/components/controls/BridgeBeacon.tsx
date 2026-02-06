import { useState, useEffect, useRef } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeBeacon({ showStatus }: Props) {
  const { postJson } = useApi()

  const [subnet, setSubnet] = useState('2C90')
  const [factoryId, setFactoryId] = useState('0707DF6A')
  const [zoneSuffix, setZoneSuffix] = useState('8F')

  const [beaconActive, setBeaconActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const beaconActiveRef = useRef(beaconActive)

  useEffect(() => {
    beaconActiveRef.current = beaconActive
  }, [beaconActive])

  const computedZone = `06${subnet}${zoneSuffix}`

  const startBeacon = async () => {
    try {
      const result = await postJson('/api/pairing/start', { subnet: `0x${subnet}` })
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
      const result = await postJson('/api/pairing/stop', { subnet: `0x${subnet}` })
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
        showStatus(`Paired! Zone: 0x${computedZone}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
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
    <ControlSection title="Bridge Beacon" storageKey="ctrl-bridge-beacon">
      <div className="text-[11px] font-mono text-[var(--text-muted)] leading-snug">
        Pair devices to ESP32 as bridge. Toggle beacon, hold OFF on device 10s, then pair.
      </div>

      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">subnet:</span>
        <Input value={subnet} onChange={e => setSubnet(e.target.value)} className="w-[64px]" />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">factory:</span>
        <Input value={factoryId} onChange={e => setFactoryId(e.target.value)} className="w-[100px]" />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">zone:</span>
        <Input value={zoneSuffix} onChange={e => setZoneSuffix(e.target.value)} className="w-[48px]" />
      </div>

      <div className="flex items-center gap-3">
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
        <div className="flex-1" />
        <Button variant="green" onClick={handlePairDevice} disabled={loading}>
          <svg className="size-3" viewBox="0 0 12 12" fill="currentColor"><path d="M7 1L3 7h3l-1 4 4-6H6z"/></svg>
          Pair
        </Button>
        <Button variant="blue" onClick={handleSendAssignment} disabled={loading}>
          <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6h7M7 3l3 3-3 3"/></svg>
          Assign
        </Button>
      </div>

      {beaconActive && (
        <div className="text-[11px] font-mono text-[var(--accent-green)]">
          beaconing active - hold OFF on device 10s, then click Pair
        </div>
      )}
    </ControlSection>
  )
}
