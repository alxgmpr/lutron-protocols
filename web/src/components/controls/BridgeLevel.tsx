import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeLevel({ showStatus }: Props) {
  const { post } = useApi()
  const [subnet, setSubnet] = useState('2C90')
  const [targetId, setTargetId] = useState('06FDEFF4')
  const [level, setLevel] = useState(50)

  const sourceId = `0x00${subnet.toUpperCase().padStart(4, '0')}AD`

  const handleSend = async (lvl?: number) => {
    const targetLevel = lvl ?? level
    showStatus(`Setting ${targetId} to ${targetLevel}%...`)
    try {
      const result = await post('/api/level', {
        bridge: sourceId,
        target: '0x' + targetId.replace(/^0x/i, ''),
        level: targetLevel
      })
      if (result.status === 'ok') {
        showStatus(`Set to ${result.level}%`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Bridge Level" storageKey="ctrl-bridge-level">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">subnet:</span>
        <Input
          value={subnet}
          onChange={e => setSubnet(e.target.value.replace(/^0x/i, ''))}
          className="w-[64px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">target:</span>
        <Input
          value={targetId}
          onChange={e => setTargetId(e.target.value.replace(/^0x/i, ''))}
          className="w-[100px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">level:</span>
        <Input
          type="number"
          value={level}
          onChange={e => setLevel(parseInt(e.target.value) || 0)}
          min={0}
          max={100}
          className="w-[48px]"
        />
        <Button variant="blue" onClick={() => handleSend()}>
          <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6h7M7 3l3 3-3 3"/></svg>
          Set
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="red" onClick={() => handleSend(0)}>0%</Button>
        <Button size="sm" variant="blue" onClick={() => handleSend(25)}>25%</Button>
        <Button size="sm" variant="blue" onClick={() => handleSend(50)}>50%</Button>
        <Button size="sm" variant="blue" onClick={() => handleSend(75)}>75%</Button>
        <Button size="sm" variant="green" onClick={() => handleSend(100)}>100%</Button>
      </div>
    </ControlSection>
  )
}
