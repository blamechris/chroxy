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
      {cost != null && cost > 0 && (
        <span className="status-cost">${cost.toFixed(4)}</span>
      )}
      {context && <span className="status-context">{context}</span>}
      {agentCount != null && agentCount > 0 && (
        <span className="agent-badge" data-testid="agent-badge">
          {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
        </span>
      )}
    </div>
  )
}
