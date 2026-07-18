/**
 * StatusBar — cost, context, busy indicator, agent badges.
 */
import { formatTokensCompact } from '@chroxy/store-core'
import { getProviderInfo } from '../lib/provider-labels'
import {
  costTooltip,
  contextTooltip,
  agentCountTooltip,
} from '../lib/status-tooltips'
import { SidebarCostBadge, type CostBadgeMode } from './SidebarCostBadge'

export interface StatusBarProps {
  cost?: number
  context?: string
  /** #6769: percent of the window the conversation fills (drives contextTooltip + meter). */
  contextPercent?: number | null
  /**
   * #6769: cumulative window occupancy in tokens (input + output + cache_read +
   * cache_creation). Drives the `used / total` meter label so it matches the
   * cache-aware percent. Falls back to `inputTokens + outputTokens` when not
   * supplied (older callers / providers with no cache fields).
   */
  contextTokens?: number
  /**
   * #6769: cached history tokens currently in the window (cache_read +
   * cache_creation). Threaded to the tooltip so the hover breakdown can
   * explain that most of the fill is cached conversation history.
   */
  cachedTokens?: number
  /** #4205: raw (uncached) input tokens for the most-recent turn (tooltip breakdown). */
  inputTokens?: number
  /** #4205: raw output tokens for the most-recent turn (drives the tooltip breakdown). */
  outputTokens?: number
  /**
   * #5065: model context window in tokens. Combined with the cumulative
   * occupancy (`contextTokens`) to render the `used / total tokens` meter
   * alongside the percent text. Hidden entirely when missing so the meter
   * doesn't show an empty bar when no session/model is active.
   */
  contextWindow?: number
  isBusy?: boolean
  agentCount?: number
  provider?: string
  /**
   * #5184: human-readable model label (e.g. `Sonnet 4.6`) for the
   * `provider-model` badge mode. Optional — when absent the badge shows the
   * provider label alone.
   */
  model?: string
  /**
   * #5184: cost-badge display mode chosen in Settings. When provided the
   * cost slot renders the configurable `SidebarCostBadge` instead of the
   * legacy `$X.XXXX` span. Left undefined by callers that don't wire the
   * setting (and by the existing test suite) so the legacy behaviour stays
   * the render fallback. The live app always passes the store value, whose
   * own default is `cost` (#5203).
   */
  costBadgeMode?: CostBadgeMode
}

// #4204 Copilot review: explicit non-breaking-space escape so the
// placeholder isn't a literal NBSP character in the source (easy to
// miss / get auto-reformatted).
const NBSP = '\u00A0'

/**
 * #5065: thresholds for the header context meter — kept in sync with the
 * FooterBar pair (`FOOTER_COMPACT_SUGGEST_THRESHOLD` / `FOOTER_OVER_BUDGET_THRESHOLD`)
 * so the two surfaces flip colour at the same point. Re-declared here
 * rather than imported to avoid a back-edge dependency from the header
 * component into the footer component.
 */
export const STATUS_COMPACT_SUGGEST_THRESHOLD = 80
export const STATUS_OVER_BUDGET_THRESHOLD = 100

export function StatusBar({
  cost, context, contextPercent, contextTokens, cachedTokens,
  inputTokens, outputTokens, contextWindow,
  isBusy, agentCount, provider, model, costBadgeMode,
}: StatusBarProps) {
  const prov = provider ? getProviderInfo(provider) : null
  // #4204 Copilot review: compute each chip's tooltip once so the
  // `title` + `aria-label` mirror pair can't drift if the formatter
  // ever takes a code path with side effects.
  const costTip = costTooltip({ cost, provider })
  // #6769: pass the cumulative occupancy + cached-history split so the context
  // chip's tooltip explains cumulative fill (not the pre-#6769 per-turn
  // input/output that read near-empty under prompt caching).
  const contextTip = contextTooltip({
    percent: contextPercent ?? null,
    contextSummary: context,
    inputTokens,
    outputTokens,
    cachedTokens,
  })
  const agentTip = agentCountTooltip(agentCount)

  // #5065/#6769: compute the `used / total tokens` label + bar when we have
  // BOTH the token counts AND the model's context window. `usedTokens` is the
  // cumulative window occupancy (`contextTokens`); it falls back to
  // input + output for older callers / providers with no cache fields. Without
  // the window we'd be guessing, and the existing context chip text already
  // covers the no-window case (it falls back to the raw count without a meter).
  // Render is gated on `usedTokens > 0` so an idle session — no turns yet —
  // doesn't show an empty `0 / 1M` bar.
  const usedTokens = contextTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0))
  const showMeter = usedTokens > 0
    && contextWindow != null
    && contextWindow > 0
    && contextPercent != null
  const meterPercent = contextPercent ?? 0
  // Cap fill at 100% — a bar wider than its container is just visual
  // noise. The numeric label is what tells the user "you're over".
  const meterFillWidth = Math.min(meterPercent, 100)
  const meterClass = meterPercent >= STATUS_OVER_BUDGET_THRESHOLD
    ? ' high over-budget'
    : meterPercent >= STATUS_COMPACT_SUGGEST_THRESHOLD
      ? ' high'
      : meterPercent >= 50
        ? ' medium'
        : ''

  return (
    // #5203: two groups — LEFT is the session identity (type badge + model
    // name), RIGHT is the metrics (configurable cost badge + token meter).
    // `.status-bar` spans the full second-row width and space-betweens them.
    <div className="status-bar" data-testid="status-bar">
    <div className="status-bar-group status-bar-left">
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
      {model && (
        <span className="status-model" data-testid="status-model" title={model}>
          {model}
        </span>
      )}
    </div>
    <div className="status-bar-group status-bar-right">
      {/* #5731 (a11y): the busy spinner was motion-only. role=img + aria-label
          gives it an accessible name on focus/hover WITHOUT a role=status live
          region (which would announce on every turn — the #4873 spam the status
          dots already dropped role=status to avoid). */}
      {isBusy && (
        <span className="busy-indicator" data-testid="busy-indicator" role="img" aria-label="Agent working" />
      )}
      {costBadgeMode ? (
        // #5184: configurable badge. The display mode comes from Settings
        // (store-backed, default `cost` since #5203); the host still owns the
        // tooltip so the hover breakdown is unchanged. `className` adds
        // `status-cost` so existing layout/selectors keep working.
        <SidebarCostBadge
          mode={costBadgeMode}
          cost={cost}
          provider={provider}
          model={model}
          inputTokens={inputTokens}
          outputTokens={outputTokens}
          contextPercent={contextPercent}
          title={costTip}
          className="status-cost"
        />
      ) : (
        <span
          className="status-cost"
          title={costTip}
          aria-label={costTip}
        >
          {cost != null ? `$${cost.toFixed(4)}` : NBSP}
        </span>
      )}
      {showMeter ? (
        // #5179: stack the fill bar BENEATH the `used / total tokens`
        // label rather than inline to its left. The label reads first
        // (it's the at-a-glance number); the bar is a secondary, visual
        // reinforcement that aligns to the label's left edge and spans
        // the label width. `status-context-meter--stacked` flips the
        // flex direction to column so the two children stack.
        <span
          className="status-context-meter status-context-meter--stacked"
          data-testid="status-context-meter"
          title={contextTip}
          aria-label={contextTip}
        >
          <span
            className="status-context-label"
            data-testid="status-context-label"
          >
            {formatTokensCompact(usedTokens)}
            {' / '}
            {formatTokensCompact(contextWindow)}
            {' tokens'}
          </span>
          <span
            className={`status-context-bar${meterClass}`}
            role="progressbar"
            aria-label="Context window usage"
            aria-valuenow={Math.min(Math.round(meterPercent), 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className="status-context-fill"
              style={{ width: `${meterFillWidth}%` }}
            />
          </span>
        </span>
      ) : (
        <span
          className="status-context"
          title={contextTip}
          aria-label={contextTip}
        >
          {context || NBSP}
        </span>
      )}
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
    </div>
  )
}
