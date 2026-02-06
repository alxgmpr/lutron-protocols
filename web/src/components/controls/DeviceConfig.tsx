import { useState } from 'react'
import { ControlSection } from './ControlSection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select } from '../ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { useApi } from '../../hooks/useApi'

interface Props {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

const FADE_RATES = ['0.25', '0.75', '2.5', '3', '5', '15']
const LED_MODES = [
  { value: '0', label: 'Both Off' },
  { value: '1', label: 'Both On' },
  { value: '2', label: 'On when load on' },
  { value: '3', label: 'On when load off' },
]

export function DeviceConfig({ showStatus }: Props) {
  const { postJson } = useApi()
  const [subnet, setSubnet] = useState('2C90')
  const [targetId, setTargetId] = useState('06FDEFF4')
  const [fadeOn, setFadeOn] = useState('0.25')
  const [fadeOff, setFadeOff] = useState('0.25')
  const [ledMode, setLedMode] = useState('0')
  const [highTrim, setHighTrim] = useState('100')
  const [lowTrim, setLowTrim] = useState('1')
  const [phase, setPhase] = useState('forward')

  const sourceId = `0x00${subnet.toUpperCase().padStart(4, '0')}AD`
  const target = '0x' + targetId.replace(/^0x/i, '')

  const handleFade = async () => {
    showStatus(`Setting fade rates...`)
    const result = await postJson('/api/config/fade', { bridge: sourceId, target, fade_on: parseFloat(fadeOn), fade_off: parseFloat(fadeOff) })
    if (result.status === 'ok') showStatus(`Fade: on=${fadeOn}s, off=${fadeOff}s`, 'success')
    else showStatus(`Error: ${result.error}`, 'error')
  }

  const handleLed = async () => {
    showStatus(`Setting LED mode...`)
    const result = await postJson('/api/config/led', { bridge: sourceId, target, mode: parseInt(ledMode) })
    if (result.status === 'ok') showStatus(`LED mode set`, 'success')
    else showStatus(`Error: ${result.error}`, 'error')
  }

  const handleTrim = async () => {
    showStatus(`Setting trim...`)
    const result = await postJson('/api/config/trim', { bridge: sourceId, target, high: parseInt(highTrim), low: parseInt(lowTrim), phase })
    if (result.status === 'ok') showStatus(`Trim: ${lowTrim}%-${highTrim}%`, 'success')
    else showStatus(`Error: ${result.error}`, 'error')
  }

  const handlePhase = async () => {
    showStatus(`Setting phase...`)
    const result = await postJson('/api/config/phase', { bridge: sourceId, target, phase, high: parseInt(highTrim), low: parseInt(lowTrim) })
    if (result.status === 'ok') showStatus(`Phase: ${phase}`, 'success')
    else showStatus(`Error: ${result.error}`, 'error')
  }

  return (
    <ControlSection title="Device Config" storageKey="ctrl-device-config">
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
      </div>

      <Tabs defaultValue="fade" className="gap-0">
        <TabsList className="h-auto w-full rounded bg-[var(--bg-tertiary)] p-[2px]">
          {(['fade', 'led', 'trim', 'phase'] as const).map(tab => (
            <TabsTrigger
              key={tab}
              value={tab}
              className="flex-1 rounded-sm border-0 px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)] data-[state=active]:bg-[var(--accent-blue)] data-[state=active]:text-white data-[state=active]:shadow-none"
            >
              {tab}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="fade" className="mt-3">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">on:</span>
            <Select value={fadeOn} onChange={e => setFadeOn(e.target.value)} className="w-[72px]">
              {FADE_RATES.map(r => <option key={r} value={r}>{r}s</option>)}
            </Select>
            <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">off:</span>
            <Select value={fadeOff} onChange={e => setFadeOff(e.target.value)} className="w-[72px]">
              {FADE_RATES.map(r => <option key={r} value={r}>{r}s</option>)}
            </Select>
            <Button variant="blue" onClick={handleFade}>
              <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6h7M7 3l3 3-3 3"/></svg>
              Apply
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="led" className="mt-3">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">mode:</span>
            <Select value={ledMode} onChange={e => setLedMode(e.target.value)} className="w-[150px]">
              {LED_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
            <Button variant="blue" onClick={handleLed}>
              <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6h7M7 3l3 3-3 3"/></svg>
              Apply
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="trim" className="mt-3">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">low:</span>
            <Input type="number" value={lowTrim} onChange={e => setLowTrim(e.target.value)} min={1} max={50} className="w-[52px]" />
            <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">high:</span>
            <Input type="number" value={highTrim} onChange={e => setHighTrim(e.target.value)} min={50} max={100} className="w-[52px]" />
            <Button variant="blue" onClick={handleTrim}>
              <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6h7M7 3l3 3-3 3"/></svg>
              Apply
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="phase" className="mt-3">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">phase:</span>
            <Select value={phase} onChange={e => setPhase(e.target.value)} className="w-[96px]">
              <option value="forward">forward</option>
              <option value="reverse">reverse</option>
            </Select>
            <Button variant="blue" onClick={handlePhase}>
              <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2.5 6h7M7 3l3 3-3 3"/></svg>
              Apply
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </ControlSection>
  )
}
