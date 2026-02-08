import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function SaveFavorite({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('05851117')
  const [customHex, setCustomHex] = useState('')

  const handleSave = async (btnCode: string) => {
    showStatus(`Saving favorite 0x${btnCode} on ${deviceId}...`)
    try {
      const result = await post('/api/save-favorite', {
        device: '0x' + deviceId.replace(/^0x/i, ''),
        button: '0x' + btnCode,
        hold: 6
      })
      if (result.status === 'ok') {
        showStatus(`Saved favorite on ${result.device}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const saveCustom = () => {
    const hex = customHex.replace(/^0x/i, '').trim()
    if (hex) handleSave(hex)
  }

  return (
    <ControlSection title="Save Favorite" storageKey="ctrl-save-favorite">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">device:</span>
        <Input
          value={deviceId}
          onChange={e => setDeviceId(e.target.value.replace(/^0x/i, ''))}
          className="w-[100px]"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="purple" onClick={() => handleSave('03')}>FAV <span className="opacity-50">03</span></Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('08')}>BRIGHT <span className="opacity-50">08</span></Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('09')}>ENTER <span className="opacity-50">09</span></Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('0A')}>RELAX <span className="opacity-50">0A</span></Button>
      </div>
      <div className="flex items-center gap-3 border-t border-[var(--border-primary)] pt-2">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">hex:</span>
        <Input
          value={customHex}
          onChange={e => setCustomHex(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && saveCustom()}
          placeholder="e.g. 0B"
          className="w-[70px]"
        />
        <Button size="sm" variant="default" onClick={saveCustom}>Save</Button>
      </div>
    </ControlSection>
  )
}
