import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select } from '../ui/select'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function PicoButtons({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('05851117')
  const [button, setButton] = useState('02')

  const sendButton = async (btnCode: string) => {
    const fullId = deviceId.replace(/^0x/i, '')
    showStatus(`Sending button from ${fullId}...`)
    try {
      const result = await post('/api/send', { device: '0x' + fullId, button: '0x' + btnCode })
      if (result.status === 'ok') {
        showStatus(`Sent ${result.button} from ${result.device}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  return (
    <ControlSection title="Pico Buttons" storageKey="ctrl-pico-buttons">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">pico:</span>
        <Input
          value={deviceId}
          onChange={e => setDeviceId(e.target.value.replace(/^0x/i, ''))}
          className="w-[100px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">btn:</span>
        <Select value={button} onChange={e => setButton(e.target.value)} className="w-[80px]">
          <option value="02">ON</option>
          <option value="03">FAV</option>
          <option value="04">OFF</option>
          <option value="05">RAISE</option>
          <option value="06">LOWER</option>
        </Select>
        <Button variant="green" onClick={() => sendButton(button)}>
          <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6h7M7 3l3 3-3 3"/></svg>
          Send
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="green" onClick={() => sendButton('02')}>ON</Button>
        <Button size="sm" variant="green" onClick={() => sendButton('03')}>FAV</Button>
        <Button size="sm" variant="red" onClick={() => sendButton('04')}>OFF</Button>
        <Button size="sm" variant="blue" onClick={() => sendButton('05')}>
          <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 8l3-4 3 4"/></svg>
          UP
        </Button>
        <Button size="sm" variant="blue" onClick={() => sendButton('06')}>
          <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 4l3 4 3-4"/></svg>
          DN
        </Button>
      </div>
    </ControlSection>
  )
}
