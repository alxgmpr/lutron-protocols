import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select } from '../ui/select'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function SaveFavorite({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('05851117')
  const [button, setButton] = useState('03')

  const handleSave = async (btnOverride?: string) => {
    const btnCode = btnOverride || button
    showStatus(`Saving favorite on ${deviceId}...`)
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

  return (
    <ControlSection title="Save Favorite" storageKey="ctrl-save-favorite">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">pico:</span>
        <Input
          value={deviceId}
          onChange={e => setDeviceId(e.target.value.replace(/^0x/i, ''))}
          className="w-[100px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">btn:</span>
        <Select value={button} onChange={e => setButton(e.target.value)} className="w-[100px]">
          <option value="03">FAV</option>
          <option value="08">BRIGHT</option>
          <option value="09">ENTERTAIN</option>
          <option value="0A">RELAX</option>
        </Select>
        <Button variant="purple" onClick={() => handleSave()}>
          <svg className="size-3" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1l1.5 3.1H11L8.2 6.3l1 3.2L6 7.5 2.8 9.5l1-3.2L1 4.1h3.5z"/></svg>
          Save
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="purple" onClick={() => handleSave('03')}>FAV</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('08')}>BRIGHT</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('09')}>ENTER</Button>
        <Button size="sm" variant="orange" onClick={() => handleSave('0A')}>RELAX</Button>
      </div>
    </ControlSection>
  )
}
