import { useCallback, useMemo, useState } from 'react'
import { Card, Button } from '../common'
import { DeviceGroup } from './DeviceGroup'
import { UnknownDeviceRow } from './UnknownDeviceRow'
import { DeviceDetailModal } from './DeviceDetailModal'
import { useApi } from '../../hooks/useApi'
import type { Device } from '../../types'
import './DeviceList.css'

interface DeviceListProps {
  devices: Record<string, Device>
  onDelete: (id: string) => void
  onClear: () => void
  onClearUnlabeled: () => void
  onRefresh: () => void
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)

  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`

  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`

  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`

  const diffDays = Math.floor(diffHr / 24)
  return `${diffDays}d ago`
}

function extractBridgePairing(device: Device): string | null {
  // First check if we have a pre-extracted bridge_pairing (from STATE_RPT)
  if (device.info?.bridge_pairing) {
    return device.info.bridge_pairing as string
  }
  // Otherwise extract from bridge_id (from LEVEL commands)
  if (device.info?.bridge_id) {
    const idStr = (device.info.bridge_id as string).replace(/^0x/i, '')
    const idNum = parseInt(idStr, 16)
    const pairingId = (idNum >> 8) & 0xFFFF
    return pairingId.toString(16).toUpperCase().padStart(4, '0')
  }
  return null
}

interface SelectedGroup {
  label: string
  devices: Array<[string, Device]>
  primaryDevice: Device
}

export function DeviceList({
  devices,
  onDelete,
  onClear,
  onClearUnlabeled,
  onRefresh,
  showStatus
}: DeviceListProps) {
  const { post, postJson } = useApi()
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null)
  const [selectedGroup, setSelectedGroup] = useState<SelectedGroup | null>(null)
  const [bridgeFilter, setBridgeFilter] = useState<string>('all')

  const replayButton = useCallback(async (deviceId: string, button: number) => {
    showStatus(`Sending button 0x${button.toString(16).toUpperCase()}...`)
    try {
      const result = await postJson('/api/send', { device: '0x' + deviceId, button })
      if (result.status === 'ok') {
        showStatus('Button sent!', 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch {
      showStatus('Failed to send', 'error')
    }
  }, [postJson, showStatus])

  const replayBridge = useCallback(async (sourceId: string, targetId: string, level: number) => {
    showStatus(`Bridge command ${level}%...`)
    try {
      const result = await postJson('/api/level', {
        bridge: '0x' + sourceId,
        target: '0x' + targetId,
        level
      })
      if (result.status === 'ok') {
        showStatus('Level sent!', 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch {
      showStatus('Failed to send', 'error')
    }
  }, [postJson, showStatus])

  const fakeState = useCallback(async (deviceId: string, level: number) => {
    showStatus(`Faking state ${level}% for ${deviceId}...`)
    try {
      const result = await post('/api/state', { device: '0x' + deviceId, level })
      if (result.status === 'ok') {
        showStatus('Fake state sent!', 'success')
      } else {
        showStatus(`Error: ${result.error}`, 'error')
      }
    } catch {
      showStatus('Failed to send', 'error')
    }
  }, [post, showStatus])

  const getEffectiveType = useCallback((device: Device): string => {
    const userType = device.device_type || 'auto'
    if (userType !== 'auto') return userType

    const category = device.info?.category || ''
    if (category === 'pico') return 'pico-5btn'
    if (category === 'scene_pico') return 'pico-scene'
    if (category === 'bridge_controlled' || category === 'bridge') return 'dimmer'
    if (category === 'dimmer' || category === 'dimmer_passive') return 'dimmer'
    return 'auto'
  }, [])

  // Quick action handler for on/off buttons in list view
  const handleQuickAction = useCallback(async (deviceId: string, action: 'on' | 'off') => {
    const device = devices[deviceId]
    if (!device) return

    const effectiveType = getEffectiveType(device)
    const category = device.info?.category || ''

    // For picos, send button press
    if (effectiveType.startsWith('pico') || category === 'pico' || category === 'scene_pico') {
      const button = action === 'on' ? 0x02 : 0x04
      await replayButton(deviceId, button)
    }
    // For bridge-controlled dimmers, send level command
    else if (device.info?.bridge_id && device.info?.factory_id) {
      const level = action === 'on' ? 100 : 0
      await replayBridge(
        device.info.bridge_id as string,
        device.info.factory_id as string,
        level
      )
    }
    // For passive dimmers, fake the state
    else if (category === 'dimmer_passive' || category === 'dimmer') {
      const level = action === 'on' ? 100 : 0
      await fakeState(deviceId, level)
    }
  }, [devices, getEffectiveType, replayButton, replayBridge, fakeState])

  const { labeled, unlabeled, existingLabels, totalLabeled, totalUnlabeled, bridgePairings } = useMemo(() => {
    const deviceList = Object.entries(devices)

    const sortByLastSeen = (a: [string, Device], b: [string, Device]) => {
      const aTime = new Date(a[1].last_seen || 0).getTime()
      const bTime = new Date(b[1].last_seen || 0).getTime()
      return bTime - aTime
    }

    const labeledDevices: Array<[string, Device]> = []
    const unlabeledDevices: Array<[string, Device]> = []
    const labels = new Set<string>()
    const pairings = new Set<string>()

    deviceList.forEach(([id, device]) => {
      // Collect bridge pairings
      const pairing = extractBridgePairing(device)
      if (pairing) pairings.add(pairing)

      if (device.label) {
        labeledDevices.push([id, device])
        labels.add(device.label)
      } else {
        unlabeledDevices.push([id, device])
      }
    })

    labeledDevices.sort(sortByLastSeen)
    unlabeledDevices.sort(sortByLastSeen)

    // Group labeled devices by label
    const grouped: Record<string, Array<[string, Device]>> = {}
    labeledDevices.forEach(([id, device]) => {
      const label = device.label!
      if (!grouped[label]) grouped[label] = []
      grouped[label].push([id, device])
    })

    const sortedGroups = Object.entries(grouped).sort((a, b) => {
      const aMaxTime = Math.max(...a[1].map(([, d]) => new Date(d.last_seen || 0).getTime()))
      const bMaxTime = Math.max(...b[1].map(([, d]) => new Date(d.last_seen || 0).getTime()))
      return bMaxTime - aMaxTime
    })

    return {
      labeled: sortedGroups,
      unlabeled: unlabeledDevices,
      existingLabels: Array.from(labels).sort(),
      totalLabeled: labeledDevices.length,
      totalUnlabeled: unlabeledDevices.length,
      bridgePairings: Array.from(pairings).sort()
    }
  }, [devices])

  // Filter labeled groups by bridge pairing
  const filteredLabeled = useMemo(() => {
    if (bridgeFilter === 'all') return labeled
    if (bridgeFilter === 'none') {
      return labeled.filter(([, groupDevices]) => {
        return !groupDevices.some(([, d]) => extractBridgePairing(d))
      })
    }
    // Filter by specific bridge pairing
    return labeled.filter(([, groupDevices]) => {
      return groupDevices.some(([, d]) => extractBridgePairing(d) === bridgeFilter)
    })
  }, [labeled, bridgeFilter])

  // Filter unlabeled devices by bridge pairing
  const filteredUnlabeled = useMemo(() => {
    if (bridgeFilter === 'all') return unlabeled
    if (bridgeFilter === 'none') {
      return unlabeled.filter(([, d]) => !extractBridgePairing(d))
    }
    return unlabeled.filter(([, d]) => extractBridgePairing(d) === bridgeFilter)
  }, [unlabeled, bridgeFilter])

  const handleModalSave = useCallback(async (label: string, deviceType: string, model: string) => {
    const targetDevice = selectedDevice || selectedGroup?.primaryDevice
    if (!targetDevice) return

    try {
      if (selectedGroup) {
        for (const [id] of selectedGroup.devices) {
          if (label) await postJson(`/api/devices/${id}/label`, { label })
          if (deviceType) await postJson(`/api/devices/${id}/type`, { device_type: deviceType })
          if (model) await postJson(`/api/devices/${id}/model`, { model })
        }
      } else {
        if (label) await postJson(`/api/devices/${targetDevice.id}/label`, { label })
        if (deviceType) await postJson(`/api/devices/${targetDevice.id}/type`, { device_type: deviceType })
        if (model) await postJson(`/api/devices/${targetDevice.id}/model`, { model })
      }
      onRefresh()
      showStatus(`Device configured: ${label || targetDevice.id}`, 'success')
      setSelectedDevice(null)
      setSelectedGroup(null)
    } catch {
      showStatus('Failed to save device', 'error')
    }
  }, [selectedDevice, selectedGroup, postJson, onRefresh, showStatus])

  const handleModalDelete = useCallback((deviceId: string) => {
    onDelete(deviceId)
    if (selectedGroup) {
      const remaining = selectedGroup.devices.filter(([id]) => id !== deviceId)
      if (remaining.length === 0) {
        setSelectedGroup(null)
      } else {
        setSelectedGroup({
          ...selectedGroup,
          devices: remaining,
          primaryDevice: remaining[0][1]
        })
      }
    } else {
      setSelectedDevice(null)
    }
  }, [selectedGroup, onDelete])

  const handleGroupClick = useCallback((label: string, groupDevices: Array<[string, Device]>) => {
    setSelectedGroup({
      label,
      devices: groupDevices,
      primaryDevice: groupDevices[0][1]
    })
  }, [])

  const hasUnlabeled = filteredUnlabeled.length > 0
  const hasLabeled = filteredLabeled.length > 0
  const totalFiltered = filteredLabeled.reduce((sum, [, devs]) => sum + devs.length, 0) + filteredUnlabeled.length
  const totalDevices = totalLabeled + totalUnlabeled

  const activeDevice = selectedDevice || selectedGroup?.primaryDevice
  const activeGroupDevices = selectedGroup?.devices

  return (
    <>
      <Card
        title="Discovered Devices"
        variant="device"
        className="device-list-card"
        badge={totalDevices > 0 ? `${totalFiltered}/${totalDevices}` : undefined}
        actions={
          <>
            {unlabeled.length > 0 && (
              <Button size="sm" variant="orange" onClick={onClearUnlabeled}>
                Clear Unknown
              </Button>
            )}
            <Button size="sm" variant="red" onClick={onClear}>Clear All</Button>
          </>
        }
      >
        {/* Bridge Filter */}
        {bridgePairings.length > 0 && (
          <div className="device-filter-bar">
            <label className="device-filter-label">Bridge:</label>
            <select
              className="device-filter-select"
              value={bridgeFilter}
              onChange={e => setBridgeFilter(e.target.value)}
            >
              <option value="all">All Devices</option>
              <option value="none">No Bridge (Picos)</option>
              {bridgePairings.map(pairing => (
                <option key={pairing} value={pairing}>Bridge {pairing}</option>
              ))}
            </select>
          </div>
        )}

        <div className="device-list-container">
          {totalDevices === 0 ? (
            <div className="device-empty">No devices discovered yet. RX is listening...</div>
          ) : !hasLabeled && !hasUnlabeled ? (
            <div className="device-empty">No devices match filter</div>
          ) : (
            <>
              {hasLabeled && (
                <div className="device-section device-section-known">
                  <div className="device-section-header">
                    <span className="device-section-icon">+</span>
                    <span className="device-section-title">Known Devices</span>
                    <span className="device-section-count">{filteredLabeled.length}</span>
                  </div>
                  {filteredLabeled.map(([label, groupDevices]) => (
                    <DeviceGroup
                      key={label}
                      label={label}
                      devices={groupDevices}
                      onClick={() => handleGroupClick(label, groupDevices)}
                      onQuickAction={handleQuickAction}
                      formatTime={formatRelativeTime}
                    />
                  ))}
                </div>
              )}

              {hasUnlabeled && (
                <div className="device-section device-section-unknown">
                  <div className="device-section-header device-section-header-unknown">
                    <span className="device-section-icon">?</span>
                    <span className="device-section-title">Unknown Devices</span>
                    <span className="device-section-count">{filteredUnlabeled.length}</span>
                  </div>
                  {filteredUnlabeled.map(([id, device]) => (
                    <UnknownDeviceRow
                      key={id}
                      device={device}
                      onClick={() => setSelectedDevice(device)}
                      formatTime={formatRelativeTime}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {activeDevice && (
        <DeviceDetailModal
          device={activeDevice}
          groupDevices={activeGroupDevices}
          existingLabels={existingLabels}
          onClose={() => { setSelectedDevice(null); setSelectedGroup(null); }}
          onSave={handleModalSave}
          onDelete={handleModalDelete}
          onReplayButton={replayButton}
          onReplayBridge={replayBridge}
          onFakeState={fakeState}
          getEffectiveType={getEffectiveType}
        />
      )}
    </>
  )
}
