import { Button } from '../common/Button'
import type { ProxyRule } from '../../types'

interface ProxyRuleListProps {
  rules: ProxyRule[]
  onEdit: (rule: ProxyRule) => void
  onToggle: (ruleId: number) => void
  onDelete: (ruleId: number) => void
}

export function ProxyRuleList({ rules, onEdit, onToggle, onDelete }: ProxyRuleListProps) {
  if (rules.length === 0) {
    return (
      <div className="proxy-rule-list">
        <div className="proxy-rule-empty">
          No proxy rules configured. Click "+ Add Rule" to create one.
        </div>
      </div>
    )
  }

  return (
    <div className="proxy-rule-list">
      {rules.map(rule => (
        <div
          key={rule.id}
          className={`proxy-rule-item ${!rule.enabled ? 'disabled' : ''}`}
        >
          <div className="proxy-rule-toggle">
            <input
              type="checkbox"
              checked={!!rule.enabled}
              onChange={() => onToggle(rule.id)}
              title={rule.enabled ? 'Disable rule' : 'Enable rule'}
            />
          </div>

          <div className="proxy-rule-content">
            <div className="proxy-rule-name">{rule.name}</div>
            <div className="proxy-rule-mapping">
              {rule.source_device_id} ({rule.source_type}) {'->'} {rule.target_device_id} ({rule.target_type})
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <span className="proxy-rule-mode">{rule.mode}</span>
              {rule.button_map && Object.keys(rule.button_map).length > 0 && (
                <span className="proxy-rule-mode">
                  {Object.keys(rule.button_map).length} button mappings
                </span>
              )}
            </div>
          </div>

          <div className="proxy-rule-actions">
            <Button size="sm" onClick={() => onEdit(rule)}>Edit</Button>
            <Button size="sm" variant="red" onClick={() => onDelete(rule.id)}>Delete</Button>
          </div>
        </div>
      ))}
    </div>
  )
}
