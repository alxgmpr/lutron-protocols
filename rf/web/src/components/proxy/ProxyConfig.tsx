import { useState, useEffect, useCallback } from 'react'
import { useApi } from '../../hooks/useApi'
import { Card } from '../common/Card'
import { ProxyRuleList } from './ProxyRuleList'
import { ProxyRuleEditor } from './ProxyRuleEditor'
import { VirtualDeviceList } from './VirtualDeviceList'
import type { ProxyRule, VirtualDevice, Device } from '../../types'
import './ProxyConfig.css'

interface ProxyConfigProps {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
  devices: Record<string, Device>
}

export function ProxyConfig({ showStatus, devices }: ProxyConfigProps) {
  const { get, postJson, del } = useApi()

  const [rules, setRules] = useState<ProxyRule[]>([])
  const [virtualDevices, setVirtualDevices] = useState<VirtualDevice[]>([])
  const [editingRule, setEditingRule] = useState<ProxyRule | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const loadRules = useCallback(async () => {
    try {
      const data = await get<ProxyRule[]>('/api/proxy/rules')
      setRules(data)
    } catch (e) {
      console.error('Failed to load proxy rules:', e)
    }
  }, [get])

  const loadVirtualDevices = useCallback(async () => {
    try {
      const data = await get<VirtualDevice[]>('/api/virtual-devices')
      setVirtualDevices(data)
    } catch (e) {
      console.error('Failed to load virtual devices:', e)
    }
  }, [get])

  useEffect(() => {
    loadRules()
    loadVirtualDevices()
  }, [loadRules, loadVirtualDevices])

  const handleToggleRule = async (ruleId: number) => {
    try {
      await postJson(`/api/proxy/rules/${ruleId}/toggle`, {})
      loadRules()
    } catch (e) {
      showStatus('Failed to toggle rule', 'error')
    }
  }

  const handleDeleteRule = async (ruleId: number) => {
    if (!confirm('Delete this proxy rule?')) return
    try {
      await del(`/api/proxy/rules/${ruleId}`)
      loadRules()
      showStatus('Rule deleted', 'success')
    } catch (e) {
      showStatus('Failed to delete rule', 'error')
    }
  }

  const handleSaveRule = async (rule: Partial<ProxyRule>) => {
    try {
      if (editingRule && editingRule.id) {
        await postJson(`/api/proxy/rules/${editingRule.id}`, rule)
        showStatus('Rule updated', 'success')
      } else {
        await postJson('/api/proxy/rules', rule)
        showStatus('Rule created', 'success')
      }
      setEditingRule(null)
      setIsCreating(false)
      loadRules()
    } catch (e) {
      showStatus('Failed to save rule', 'error')
    }
  }

  const handleCreateVirtualDevice = async (device: { name: string; device_type: string; subnet?: string }) => {
    try {
      await postJson('/api/virtual-devices', device)
      loadVirtualDevices()
      showStatus('Virtual device created', 'success')
    } catch (e) {
      showStatus('Failed to create virtual device', 'error')
    }
  }

  const handleDeleteVirtualDevice = async (deviceId: string) => {
    if (!confirm('Delete this virtual device?')) return
    try {
      await del(`/api/virtual-devices/${deviceId}`)
      loadVirtualDevices()
      showStatus('Virtual device deleted', 'success')
    } catch (e) {
      showStatus('Failed to delete virtual device', 'error')
    }
  }

  // Combine real devices with virtual devices for selection
  const allDevices: Record<string, Device> = {
    ...devices,
    ...Object.fromEntries(
      virtualDevices.map(vd => [vd.id, {
        id: vd.id,
        label: vd.name,
        type: vd.device_type,
        device_type: vd.device_type,
        first_seen: vd.created_at || new Date().toISOString(),
        last_seen: vd.last_command_at || new Date().toISOString(),
        count: 0,
        info: { virtual: true, subnet: vd.subnet }
      } as Device])
    )
  }

  return (
    <div className="proxy-config">
      <Card title="How Proxy Works" variant="bridge">
        <div className="help-text">
          <p><strong>Use case:</strong> Forward commands from RA3 to real Caseta dimmers.</p>
          <ol style={{ marginTop: '0.5rem', paddingLeft: '1.25rem' }}>
            <li>In RA3, configure a lamp dimmer with a "fake" device ID (e.g., <code>0x06FE8006</code>)</li>
            <li>Create a proxy rule below mapping that ID to your real Caseta dimmer</li>
            <li>When RA3 sends commands to the fake ID, this proxy forwards them to your real dimmer</li>
          </ol>
        </div>
      </Card>

      <Card
        title="Proxy Rules"
        variant="pico"
        actions={
          <button className="btn btn-sm" onClick={() => { setIsCreating(true); setEditingRule({} as ProxyRule) }}>
            + Add Rule
          </button>
        }
      >
        <ProxyRuleList
          rules={rules}
          onEdit={(rule) => { setIsCreating(false); setEditingRule(rule) }}
          onToggle={handleToggleRule}
          onDelete={handleDeleteRule}
        />
      </Card>

      <Card title="Virtual Devices (Optional)" variant="device">
        <p className="help-text" style={{ marginBottom: '0.75rem' }}>
          Create virtual devices to track state for fake IDs. Not required for basic forwarding.
        </p>
        <VirtualDeviceList
          devices={virtualDevices}
          onCreate={handleCreateVirtualDevice}
          onDelete={handleDeleteVirtualDevice}
        />
      </Card>

      {(editingRule || isCreating) && (
        <ProxyRuleEditor
          rule={editingRule}
          devices={allDevices}
          onSave={handleSaveRule}
          onClose={() => { setEditingRule(null); setIsCreating(false) }}
        />
      )}
    </div>
  )
}
