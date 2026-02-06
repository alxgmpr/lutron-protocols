import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function PicoButtons({ showStatus }: Props) {
  const { post } = useApi()
  const [deviceId, setDeviceId] = useState('05851117')
  const [customHex, setCustomHex] = useState('')

  const sendButton = async (btnCode: string) => {
    const fullId = deviceId.replace(/^0x/i, '')
    showStatus(`Sending 0x${btnCode} from ${fullId}...`)
    try {
      const result = await post('/api/send', { device: '0x' + fullId, button: '0x' + btnCode })
      if (result.status === 'ok') {
        showStatus(`Sent 0x${btnCode} from ${result.device}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const sendCustom = () => {
    const hex = customHex.replace(/^0x/i, '').trim()
    if (hex) sendButton(hex)
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
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="green" onClick={() => sendButton('02')}>ON <span className="opacity-50">02</span></Button>
        <Button size="sm" variant="green" onClick={() => sendButton('03')}>FAV <span className="opacity-50">03</span></Button>
        <Button size="sm" variant="red" onClick={() => sendButton('04')}>OFF <span className="opacity-50">04</span></Button>
        <Button size="sm" variant="blue" onClick={() => sendButton('05')}>
          <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 8l3-4 3 4"/></svg>
          UP <span className="opacity-50">05</span>
        </Button>
        <Button size="sm" variant="blue" onClick={() => sendButton('06')}>
          <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 4l3 4 3-4"/></svg>
          DN <span className="opacity-50">06</span>
        </Button>
      </div>
      <div className="flex items-center gap-3 border-t border-[var(--border-primary)] pt-2">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">hex:</span>
        <Input
          value={customHex}
          onChange={e => setCustomHex(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendCustom()}
          placeholder="e.g. 0B"
          className="w-[70px]"
        />
        <Button size="sm" variant="default" onClick={sendCustom}>Send</Button>
      </div>
    </ControlSection>
  )
}
