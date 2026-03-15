/**
 * StatusBar — model, cost, context, busy indicator, agent badges.
 */

export interface StatusBarProps {
  model?: string
  cost?: number
  context?: string
  isBusy?: boolean
  agentCount?: number
}

export function StatusBar({ model, cost, context, isBusy, agentCount }: StatusBarProps) {
  return (
    <div className="status-bar" data-testid="status-bar">
      {isBusy && (
        <span className="busy-indicator" data-testid="busy-indicator" />
      )}
      {model && <span className="status-model">{model}</span>}
      <span className="status-cost">{cost != null ? `$${cost.toFixed(4)}` : '\u00A0'}</span>
      <span className="status-context">{context || '\u00A0'}</span>
      {agentCount != null && agentCount > 0 && (
        <span className="agent-badge" data-testid="agent-badge">
          {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
        </span>
      )}
    </div>
  )
}
