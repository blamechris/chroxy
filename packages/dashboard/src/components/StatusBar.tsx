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

// #4204 Copilot review: explicit non-breaking-space escape so the
// placeholder isn't a literal NBSP character in the source (easy to
// miss / get auto-reformatted).
const NBSP = '\u00A0'

export function StatusBar({ cost, context, contextPercent, isBusy, agentCount, provider }: StatusBarProps) {
  const prov = provider ? getProviderInfo(provider) : null
  // #4204 Copilot review: compute each chip's tooltip once so the
  // `title` + `aria-label` mirror pair can't drift if the formatter
  // ever takes a code path with side effects.
  const costTip = costTooltip({ cost, provider })
  const contextTip = contextTooltip({ percent: contextPercent ?? null, contextSummary: context })
  const agentTip = agentCountTooltip(agentCount)
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
          aria-label={prov.tooltip}
          data-testid="status-provider"
        >
          {prov.short}
        </span>
      )}
      <span
        className="status-cost"
        title={costTip}
        aria-label={costTip}
      >
        {cost != null ? `$${cost.toFixed(4)}` : NBSP}
      </span>
      <span
        className="status-context"
        title={contextTip}
        aria-label={contextTip}
      >
        {context || NBSP}
      </span>
      {agentCount != null && agentCount > 0 && (
        <span
          className="agent-badge"
          data-testid="agent-badge"
          title={agentTip}
          aria-label={agentTip}
        >
          {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
        </span>
      )}
    </div>
  )
}
