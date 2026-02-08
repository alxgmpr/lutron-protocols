import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { PicoButtons } from './PicoButtons'
import { PicoPairing } from './PicoPairing'
import { SaveFavorite } from './SaveFavorite'
import { ResetPico } from './ResetPico'
import { PicoLevel } from './PicoLevel'
import { BridgeLevel } from './BridgeLevel'
import { BridgeBeacon } from './BridgeBeacon'
import { DeviceConfig } from './DeviceConfig'
import { DeviceState } from './DeviceState'
import { BridgeUnpair } from './BridgeUnpair'
import { VivePairing } from './VivePairing'
import { ViveControl } from './ViveControl'

interface ControlTabsProps {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

export function ControlTabs({ showStatus }: ControlTabsProps) {
  const [tab, setTab] = useState(() => localStorage.getItem('cca-ctrl-tab') || 'pico')

  const handleTabChange = (value: string) => {
    setTab(value)
    localStorage.setItem('cca-ctrl-tab', value)
  }

  return (
    <Tabs value={tab} onValueChange={handleTabChange} className="flex h-full flex-col gap-0">
      <TabsList className="sticky top-0 z-10 flex w-full shrink-0 rounded-none border-b border-[var(--border-primary)] bg-[var(--bg-primary)] p-0">
        <TabsTrigger value="pico" className="flex-1 rounded-none border-0 px-4 py-2 text-[11px] data-[state=active]:bg-[var(--bg-tertiary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:shadow-none">
          Pico
        </TabsTrigger>
        <TabsTrigger value="bridge" className="flex-1 rounded-none border-0 px-4 py-2 text-[11px] data-[state=active]:bg-[var(--bg-tertiary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:shadow-none">
          Bridge
        </TabsTrigger>
        <TabsTrigger value="vive" className="flex-1 rounded-none border-0 px-4 py-2 text-[11px] data-[state=active]:bg-[var(--bg-tertiary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:shadow-none">
          Vive
        </TabsTrigger>
      </TabsList>

      <div className="flex-1 overflow-y-auto">
        <TabsContent value="pico" className="mt-0">
          <PicoLevel showStatus={showStatus} />
          <PicoButtons showStatus={showStatus} />
          <PicoPairing showStatus={showStatus} />
          <SaveFavorite showStatus={showStatus} />
          <ResetPico showStatus={showStatus} />
        </TabsContent>

        <TabsContent value="bridge" className="mt-0">
          <BridgeLevel showStatus={showStatus} />
          <BridgeBeacon showStatus={showStatus} />
          <DeviceConfig showStatus={showStatus} />
          <DeviceState showStatus={showStatus} />
          <BridgeUnpair showStatus={showStatus} />
        </TabsContent>

        <TabsContent value="vive" className="mt-0">
          <VivePairing showStatus={showStatus} />
          <ViveControl showStatus={showStatus} />
        </TabsContent>
      </div>
    </Tabs>
  )
}
