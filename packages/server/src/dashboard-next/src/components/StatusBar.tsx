/**
 * StatusBar — model, cost, context, busy indicator, agent badges.
 */

export interface StatusBarProps {
  model?: string
  cost?: number
  context?: string
  isBusy?: boolean
  agentCount?: number
  provider?: string
}

function providerLabel(provider: string): { short: string; tooltip: string; type: 'sdk' | 'cli' } {
  const isSdk = provider.includes('sdk')
  return {
    short: isSdk ? 'SDK' : 'CLI',
    tooltip: isSdk
      ? 'Anthropic API — billed per token via ANTHROPIC_API_KEY'
      : 'Claude Code CLI — uses your claude.ai subscription',
    type: isSdk ? 'sdk' : 'cli',
  }
}

export function StatusBar({ model, cost, context, isBusy, agentCount, provider }: StatusBarProps) {
  const prov = provider ? providerLabel(provider) : null
  return (
    <div className="status-bar" data-testid="status-bar">
      {isBusy && (
        <span className="busy-indicator" data-testid="busy-indicator" />
      )}
      {prov && (
        <span
          className="status-provider"
          data-provider={prov.type}
          title={prov.tooltip}
          data-testid="status-provider"
        >
          {prov.short}
        </span>
      )}
      {model && <span className="status-model">{model}</span>}
      {cost != null && (
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
