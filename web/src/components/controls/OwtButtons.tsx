import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select } from '../ui/select'
import { useApi } from '../../hooks/useApi'
import { OWT_TYPES, getOwtButtons, getOwtRemoteTypes } from '../../owt-types'
import type { OwtButton } from '../../owt-types'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

const ARROW_UP = (
  <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 8l3-4 3 4"/></svg>
)
const ARROW_DOWN = (
  <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 4l3 4 3-4"/></svg>
)

export function OwtButtons({ showStatus }: Props) {
  const { post, postJson } = useApi()
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('owt-btn-device') || '05851117')
  const [owtType, setOwtType] = useState(() => localStorage.getItem('owt-btn-type') || 'pico-5btn')
  const [customHex, setCustomHex] = useState('')

  const handleDeviceChange = (value: string) => {
    const clean = value.replace(/^0x/i, '')
    setDeviceId(clean)
    localStorage.setItem('owt-btn-device', clean)
  }

  const handleTypeChange = (value: string) => {
    setOwtType(value)
    localStorage.setItem('owt-btn-type', value)
  }

  const sendButton = async (btnCode: number) => {
    const hex = btnCode.toString(16).padStart(2, '0').toUpperCase()
    const fullId = deviceId.replace(/^0x/i, '')
    showStatus(`Sending 0x${hex} from ${fullId}...`)
    try {
      const result = await post('/api/send', { device: '0x' + fullId, button: '0x' + hex })
      if (result.status === 'ok') {
        showStatus(`Sent 0x${hex} from ${result.device}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const sendHold = async (btnCode: number) => {
    const hex = btnCode.toString(16).padStart(2, '0').toUpperCase()
    const fullId = deviceId.replace(/^0x/i, '')
    showStatus(`Hold 0x${hex} from ${fullId}...`)
    try {
      const result = await postJson('/api/hold', { device: '0x' + fullId, button: '0x' + hex, duration: 2000 })
      if (result.status === 'ok') {
        showStatus(`Hold 0x${hex} complete`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const sendSave = async (btnCode: number) => {
    const hex = btnCode.toString(16).padStart(2, '0').toUpperCase()
    const fullId = deviceId.replace(/^0x/i, '')
    showStatus(`Saving 0x${hex} on ${fullId}...`)
    try {
      const result = await post('/api/save-favorite', { device: '0x' + fullId, button: '0x' + hex, hold: 6 })
      if (result.status === 'ok') {
        showStatus(`Saved on ${result.device}`, 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch (e) {
      showStatus(`Error: ${e}`, 'error')
    }
  }

  const sendCustom = () => {
    const hex = customHex.replace(/^0x/i, '').trim()
    if (hex) sendButton(parseInt(hex, 16))
  }

  const buttons = getOwtButtons(owtType)
  const remoteTypes = getOwtRemoteTypes()

  const renderButton = (btn: OwtButton) => {
    const hex = btn.code.toString(16).padStart(2, '0').toUpperCase()
    return (
      <div key={btn.code} className="flex items-center gap-0.5">
        <Button size="sm" variant={btn.variant} onClick={() => sendButton(btn.code)}>
          {btn.icon === 'up' && ARROW_UP}
          {btn.icon === 'down' && ARROW_DOWN}
          {btn.label} <span className="opacity-50">{hex}</span>
        </Button>
        {btn.canHold && (
          <Button size="sm" variant="default" onClick={() => sendHold(btn.code)} title="Hold (dim)">
            H
          </Button>
        )}
        {btn.canSave && (
          <Button size="sm" variant="default" onClick={() => sendSave(btn.code)} title="Save favorite">
            S
          </Button>
        )}
      </div>
    )
  }

  return (
    <ControlSection title="OWT Buttons" storageKey="ctrl-owt-buttons">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">device:</span>
        <Input
          value={deviceId}
          onChange={e => handleDeviceChange(e.target.value)}
          className="w-[100px]"
        />
        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">type:</span>
        <Select value={owtType} onChange={e => handleTypeChange(e.target.value)} className="w-[130px]">
          {remoteTypes.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </Select>
      </div>
      {buttons.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {buttons.map(renderButton)}
        </div>
      )}
      {OWT_TYPES[owtType]?.category === 'sensor' && (
        <div className="text-[11px] text-[var(--text-muted)] italic">Sensor — button codes TBD from captures</div>
      )}
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
