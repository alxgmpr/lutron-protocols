import { useState, useEffect, useCallback } from 'react'
import { useApi } from '../../hooks/useApi'
import { Card } from '../common/Card'
import { RelayRuleList } from './RelayRuleList'
import { RelayRuleEditor } from './RelayRuleEditor'
import type { RelayRule, RelayStats, Device } from '../../types'
import './RelayConfig.css'

interface RelayConfigProps {
  showStatus: (message: string, type?: 'success' | 'error' | '') => void
  devices: Record<string, Device>
}

export function RelayConfig({ showStatus, devices }: RelayConfigProps) {
  const { get, postJson, del } = useApi()

  const [rules, setRules] = useState<RelayRule[]>([])
  const [stats, setStats] = useState<RelayStats | null>(null)
  const [editingRule, setEditingRule] = useState<RelayRule | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const loadRules = useCallback(async () => {
    try {
      const data = await get<RelayRule[]>('/api/relay/rules')
      setRules(data)
    } catch (e) {
      console.error('Failed to load relay rules:', e)
    }
  }, [get])

  const loadStats = useCallback(async () => {
    try {
      const data = await get<RelayStats>('/api/relay/stats')
      setStats(data)
    } catch (e) {
      // Stats endpoint might not be available
      console.debug('Failed to load relay stats:', e)
    }
  }, [get])

  useEffect(() => {
    loadRules()
    loadStats()
    // Refresh stats every 5 seconds
    const interval = setInterval(loadStats, 5000)
    return () => clearInterval(interval)
  }, [loadRules, loadStats])

  const handleToggleRule = async (ruleId: number) => {
    try {
      await postJson(`/api/relay/rules/${ruleId}/toggle`, {})
      loadRules()
    } catch (e) {
      showStatus('Failed to toggle rule', 'error')
    }
  }

  const handleDeleteRule = async (ruleId: number) => {
    if (!confirm('Delete this relay rule?')) return
    try {
      await del(`/api/relay/rules/${ruleId}`)
      loadRules()
      showStatus('Rule deleted', 'success')
    } catch (e) {
      showStatus('Failed to delete rule', 'error')
    }
  }

  const handleSaveRule = async (rule: Partial<RelayRule>) => {
    try {
      if (editingRule && editingRule.id) {
        await postJson(`/api/relay/rules/${editingRule.id}`, rule, 'PUT')
        showStatus('Rule updated', 'success')
      } else {
        await postJson('/api/relay/rules', rule)
        showStatus('Rule created', 'success')
      }
      setEditingRule(null)
      setIsCreating(false)
      loadRules()
    } catch (e) {
      showStatus('Failed to save rule', 'error')
    }
  }

  const handleReload = async () => {
    try {
      await postJson('/api/relay/reload', {})
      showStatus('Relay rules reloaded', 'success')
    } catch (e) {
      showStatus('Failed to reload rules', 'error')
    }
  }

  return (
    <div className="relay-config">
      <Card title="Low-Latency Packet Relay" variant="bridge">
        <div className="help-text">
          <p><strong>What it does:</strong> Direct packet-level forwarding with ~10-20ms latency.</p>

          <div style={{
            background: 'var(--bg-tertiary)',
            padding: '0.75rem',
            borderRadius: '4px',
            marginTop: '0.75rem',
            fontSize: '0.85rem'
          }}>
            <strong>Setup for Bridge to Real Dimmer:</strong>
            <ol style={{ marginTop: '0.5rem', paddingLeft: '1.25rem', marginBottom: 0 }}>
              <li>In your bridge app, create a "virtual" dimmer with any ID (e.g., <code>CC110001</code>)</li>
              <li>Create a relay rule: Source = <code>CC110001</code>, Target = real dimmer ID</li>
              <li>Enable <strong>Bidirectional</strong> so the dimmer's responses get relayed back</li>
            </ol>
          </div>
        </div>
      </Card>

      {stats && (
        <Card title="Relay Statistics" variant="device">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem' }}>
            <div className="stat-box">
              <div className="stat-value">{stats.packets_received}</div>
              <div className="stat-label">Received</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{stats.packets_relayed}</div>
              <div className="stat-label">Relayed</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{stats.packets_dropped}</div>
              <div className="stat-label">Dropped</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{stats.avg_relay_latency_ms.toFixed(1)}ms</div>
              <div className="stat-label">Avg Latency</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{stats.active_rules}</div>
              <div className="stat-label">Active Rules</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{stats.pending_acks}</div>
              <div className="stat-label">Pending ACKs</div>
            </div>
          </div>
        </Card>
      )}

      <Card
        title="Relay Rules"
        variant="pico"
        actions={
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-sm" onClick={handleReload}>
              Reload
            </button>
            <button className="btn btn-sm" onClick={() => { setIsCreating(true); setEditingRule({} as RelayRule) }}>
              + Add Rule
            </button>
          </div>
        }
      >
        <RelayRuleList
          rules={rules}
          onEdit={(rule) => { setIsCreating(false); setEditingRule(rule) }}
          onToggle={handleToggleRule}
          onDelete={handleDeleteRule}
        />
      </Card>

      {(editingRule || isCreating) && (
        <RelayRuleEditor
          rule={editingRule}
          devices={devices}
          onSave={handleSaveRule}
          onClose={() => { setEditingRule(null); setIsCreating(false) }}
        />
      )}
    </div>
  )
}
