/**
 * StatusBar — cost, context, busy indicator, agent badges.
 */
import { getProviderInfo } from '../lib/provider-labels'
import {
  costTooltip,
  contextTooltip,
  agentCountTooltip,
} from '../lib/status-tooltips'

export interface StatusBarProps {
  cost?: number
  context?: string
  /** #3858: percent of model window the last turn used (drives contextTooltip). */
  contextPercent?: number | null
  isBusy?: boolean
  agentCount?: number
  provider?: string
}

export function StatusBar({ cost, context, contextPercent, isBusy, agentCount, provider }: StatusBarProps) {
  const prov = provider ? getProviderInfo(provider) : null
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
      <span
        className="status-cost"
        title={costTooltip({ cost, provider })}
        aria-label={costTooltip({ cost, provider })}
      >
        {cost != null ? `$${cost.toFixed(4)}` : ' '}
      </span>
      <span
        className="status-context"
        title={contextTooltip({ percent: contextPercent ?? null, contextSummary: context })}
        aria-label={contextTooltip({ percent: contextPercent ?? null, contextSummary: context })}
      >
        {context || ' '}
      </span>
      {agentCount != null && agentCount > 0 && (
        <span
          className="agent-badge"
          data-testid="agent-badge"
          title={agentCountTooltip(agentCount)}
          aria-label={agentCountTooltip(agentCount)}
        >
          {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
        </span>
      )}
    </div>
  )
}
