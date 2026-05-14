/**
 * StatusBar — cost, context, busy indicator, agent badges.
 */
import { getProviderInfo } from '../lib/provider-labels'
import {
  tokenTooltip,
  costTooltip,
  contextTooltip,
  agentTooltip,
} from '../lib/status-tooltips'

export interface StatusBarProps {
  cost?: number
  context?: string
  isBusy?: boolean
  agentCount?: number
  provider?: string
  /** #3858: extra data needed by the explanatory tooltips. */
  contextUsage?: { inputTokens: number; outputTokens: number } | null
  contextWindow?: number | null
  contextPercent?: number | null
}

export function StatusBar({
  cost,
  context,
  isBusy,
  agentCount,
  provider,
  contextUsage,
  contextWindow,
  contextPercent,
}: StatusBarProps) {
  const prov = provider ? getProviderInfo(provider) : null
  const tokenTitle = tokenTooltip(contextUsage ?? null)
  const costTitle = costTooltip(cost ?? null, provider ?? null)
  const contextTitle = contextTooltip({
    inputTokens: contextUsage?.inputTokens ?? 0,
    outputTokens: contextUsage?.outputTokens ?? 0,
    contextWindow: contextWindow ?? null,
    percent: contextPercent ?? null,
  })
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
        title={costTitle}
        aria-label={costTitle}
      >
        {cost != null ? `$${cost.toFixed(4)}` : ' '}
      </span>
      <span
        className="status-context"
        title={context ? contextTitle : tokenTitle}
        aria-label={context ? contextTitle : tokenTitle}
      >
        {context || ' '}
      </span>
      {agentCount != null && agentCount > 0 && (
        <span
          className="agent-badge"
          data-testid="agent-badge"
          title={agentTooltip(agentCount)}
          aria-label={agentTooltip(agentCount)}
        >
          {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
        </span>
      )}
    </div>
  )
}
