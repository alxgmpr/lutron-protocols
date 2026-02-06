import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function BridgeUnpair({ showStatus }: Props) {
  const { post } = useApi()
  const [bridgeSubnet, setBridgeSubnet] = useState('2C90')
  const [targetId, setTargetId] = useState('06F4587E')

  const handleUnpair = async () => {
    const cleanSubnet = bridgeSubnet.replace(/^0x/i, '').toUpperCase().padStart(4, '0')
    const zone1 = `0x00${cleanSubnet}AD`
    const zone2 = `0x00${cleanSubnet}AF`

    showStatus(`Unpairing ${targetId}...`)
    try {
      const result = await post('/api/unpair', {
        bridge: zone1,
        target: '0x' + targetId.replace(/^0x/i, ''),
        zone2: zone2
      })
      if (result.status === 'ok') {
        showStatus(`Unpaired ${targetId}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Bridge Unpair" storageKey="ctrl-bridge-unpair">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">subnet:</span>
        <Input
          value={bridgeSubnet}
          onChange={e => setBridgeSubnet(e.target.value.replace(/^0x/i, ''))}
          className="w-[64px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">target:</span>
        <Input
          value={targetId}
          onChange={e => setTargetId(e.target.value.replace(/^0x/i, ''))}
          className="w-[100px]"
        />
        <Button variant="red" onClick={handleUnpair}>
          <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
          Unpair
        </Button>
      </div>
    </ControlSection>
  )
}
