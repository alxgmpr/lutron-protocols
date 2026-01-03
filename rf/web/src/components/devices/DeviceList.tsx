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
  onSetType: (id: string, type: string) => void
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
  onSetType,
  onRefresh,
  showStatus
}: DeviceListProps) {
  const { post, postJson } = useApi()
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null)
  const [selectedGroup, setSelectedGroup] = useState<SelectedGroup | null>(null)

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
        source: '0x' + sourceId,
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

  const { labeled, unlabeled, existingLabels, totalLabeled, totalUnlabeled } = useMemo(() => {
    const deviceList = Object.entries(devices)

    const sortByLastSeen = (a: [string, Device], b: [string, Device]) => {
      const aTime = new Date(a[1].last_seen || 0).getTime()
      const bTime = new Date(b[1].last_seen || 0).getTime()
      return bTime - aTime
    }

    const labeledDevices: Array<[string, Device]> = []
    const unlabeledDevices: Array<[string, Device]> = []
    const labels = new Set<string>()

    deviceList.forEach(([id, device]) => {
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
      totalUnlabeled: unlabeledDevices.length
    }
  }, [devices])

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

  const hasUnlabeled = unlabeled.length > 0
  const hasLabeled = labeled.length > 0
  const totalDevices = totalLabeled + totalUnlabeled

  const activeDevice = selectedDevice || selectedGroup?.primaryDevice
  const activeGroupDevices = selectedGroup?.devices

  return (
    <>
      <Card
        title="Discovered Devices"
        variant="device"
        className="device-list-card"
        badge={totalDevices > 0 ? `${totalDevices}` : undefined}
        actions={
          <>
            <Button size="sm" onClick={onRefresh}>Refresh</Button>
            {hasUnlabeled && (
              <Button size="sm" variant="orange" onClick={onClearUnlabeled}>
                Clear Unknown
              </Button>
            )}
            <Button size="sm" variant="red" onClick={onClear}>Clear All</Button>
          </>
        }
      >
        <div className="device-list-container">
          {totalDevices === 0 ? (
            <div className="device-empty">No devices discovered yet. RX is listening...</div>
          ) : (
            <>
              {hasLabeled && (
                <div className="device-section device-section-known">
                  <div className="device-section-header">
                    <span className="device-section-icon">✓</span>
                    <span className="device-section-title">Known Devices</span>
                    <span className="device-section-count">{totalLabeled}</span>
                  </div>
                  {labeled.map(([label, groupDevices]) => (
                    <DeviceGroup
                      key={label}
                      label={label}
                      devices={groupDevices}
                      onSetType={onSetType}
                      onClick={() => handleGroupClick(label, groupDevices)}
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
                    <span className="device-section-count">{totalUnlabeled}</span>
                  </div>
                  {unlabeled.map(([id, device]) => (
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
