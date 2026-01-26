import { Button } from '../common/Button'
import type { RelayRule } from '../../types'

interface RelayRuleListProps {
  rules: RelayRule[]
  onEdit: (rule: RelayRule) => void
  onToggle: (ruleId: number) => void
  onDelete: (ruleId: number) => void
}

export function RelayRuleList({ rules, onEdit, onToggle, onDelete }: RelayRuleListProps) {
  if (rules.length === 0) {
    return (
      <div className="relay-rule-list">
        <div className="relay-rule-empty">
          No relay rules configured. Click "+ Add Rule" to create one.
        </div>
      </div>
    )
  }

  return (
    <div className="relay-rule-list">
      {rules.map(rule => (
        <div
          key={rule.id}
          className={`relay-rule-item ${!rule.enabled ? 'disabled' : ''}`}
        >
          <div className="relay-rule-toggle">
            <input
              type="checkbox"
              checked={!!rule.enabled}
              onChange={() => onToggle(rule.id)}
              title={rule.enabled ? 'Disable rule' : 'Enable rule'}
            />
          </div>

          <div className="relay-rule-content">
            <div className="relay-rule-name">{rule.name}</div>
            <div className="relay-rule-mapping">
              {rule.source_device_id} {'->'} {rule.target_device_id}
              {rule.target_bridge_id && ` (via ${rule.target_bridge_id})`}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              {rule.bidirectional && (
                <span className="relay-rule-mode">bidirectional</span>
              )}
              {rule.relay_buttons && (
                <span className="relay-rule-mode">buttons</span>
              )}
              {rule.relay_level && (
                <span className="relay-rule-mode">level</span>
              )}
            </div>
          </div>

          <div className="relay-rule-actions">
            <Button size="sm" onClick={() => onEdit(rule)}>Edit</Button>
            <Button size="sm" variant="red" onClick={() => onDelete(rule.id)}>Delete</Button>
          </div>
        </div>
      ))}
    </div>
  )
}
