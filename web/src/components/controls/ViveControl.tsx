import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function ViveControl({ showStatus }: Props) {
  const { postJson } = useApi()
  const [hubId, setHubId] = useState('')
  const [zoneId, setZoneId] = useState('')
  const [level, setLevel] = useState(50)

  const getParams = () => {
    if (!hubId.trim() || !zoneId.trim()) {
      showStatus('Hub ID and Zone ID are required', 'error')
      return null
    }
    const fullHubId = '0x' + hubId.replace(/^0x/i, '')
    const zone = parseInt(zoneId, 16)
    if (isNaN(zone) || zone < 1 || zone > 255) {
      showStatus('Invalid zone ID (must be 01-FF hex)', 'error')
      return null
    }
    return { hub_id: fullHubId, zone_id: zone }
  }

  const sendCommand = async (action: 'on' | 'off' | 'raise' | 'lower') => {
    const params = getParams()
    if (!params) return

    showStatus(`Sending ${action.toUpperCase()} to hub ${params.hub_id} zone 0x${zoneId.toUpperCase()}...`)
    try {
      const result = await postJson(`/api/vive/${action}`, params)
      if (result.status === 'ok') {
        showStatus(`${action.toUpperCase()} sent to zone 0x${zoneId.toUpperCase()}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const sendLevel = async (lvl?: number) => {
    const params = getParams()
    if (!params) return
    const targetLevel = lvl ?? level

    showStatus(`Setting zone 0x${zoneId.toUpperCase()} to ${targetLevel}%...`)
    try {
      const result = await postJson('/api/vive/level', { ...params, level: targetLevel })
      if (result.status === 'ok') {
        showStatus(`Set zone 0x${zoneId.toUpperCase()} to ${targetLevel}%`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Vive Zone Control" storageKey="ctrl-vive-control">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">hub:</span>
        <Input
          value={hubId}
          onChange={e => setHubId(e.target.value.replace(/^0x/i, ''))}
          placeholder="AABBCCDD"
          className="w-[100px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">zone:</span>
        <Input
          value={zoneId}
          onChange={e => setZoneId(e.target.value.replace(/^0x/i, '').slice(0, 2))}
          placeholder="38"
          className="w-[48px]"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="green" onClick={() => sendCommand('on')}>ON</Button>
        <Button size="sm" variant="red" onClick={() => sendCommand('off')}>OFF</Button>
        <Button size="sm" variant="blue" onClick={() => sendCommand('raise')}>
          <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 8l3-4 3 4"/></svg>
          Raise
        </Button>
        <Button size="sm" variant="blue" onClick={() => sendCommand('lower')}>
          <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 4l3 4 3-4"/></svg>
          Lower
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">level:</span>
        <Input
          type="number"
          value={level}
          onChange={e => setLevel(parseInt(e.target.value) || 0)}
          min={0}
          max={100}
          className="w-[48px]"
        />
        <Button size="sm" variant="blue" onClick={() => sendLevel()}>
          <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6h7M7 3l3 3-3 3"/></svg>
          Set
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="red" onClick={() => sendLevel(0)}>0%</Button>
        <Button size="sm" variant="blue" onClick={() => sendLevel(25)}>25%</Button>
        <Button size="sm" variant="blue" onClick={() => sendLevel(50)}>50%</Button>
        <Button size="sm" variant="blue" onClick={() => sendLevel(75)}>75%</Button>
        <Button size="sm" variant="green" onClick={() => sendLevel(100)}>100%</Button>
      </div>
    </ControlSection>
  )
}
