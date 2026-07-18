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
  /** #6769: percent of the meter ceiling the conversation fills (occupancy-driven). */
  contextPercent?: number | null
  /**
   * #6769: window occupancy in tokens from the provider's SNAPSHOT (SDK
   * getContextUsage() / byok final-round prompt). Drives the `used / total`
   * meter label. Absent = no occupancy signal — the meter hides entirely
   * (honest dash state); it is NEVER derived from the billing input/output
   * counts below, which sum across agent-loop rounds and over-read fill.
   *
   * NOTE the two denominators are deliberately different: the label's
   * `total` is the RAW `contextWindow`, while `contextPercent` is metered
   * against the effective ceiling (the SDK's real autoCompactThreshold, or
   * the reserve-adjusted window — see store-core `contextMeterCeiling`).
   * A percent recomputed from the label therefore reads slightly LOWER than
   * the displayed `contextPercent`. That's intentional: the label answers
   * "how big is the window?", the percent answers "how much usable space is
   * left before auto-compact?".
   */
  contextTokens?: number
  /**
   * #6769: true when the snapshot is byok's final-round estimate rather than
   * the SDK's authoritative context-usage API — the tooltip flags it.
   */
  contextEstimated?: boolean
  /** #4205: raw input tokens billed for the most-recent turn (tooltip breakdown). */
  inputTokens?: number
  /** #4205: raw output tokens billed for the most-recent turn (tooltip breakdown). */
  outputTokens?: number
  /**
   * #5065: model context window in tokens. Combined with the occupancy
   * (`contextTokens`) to render the `used / total tokens` meter alongside
   * the percent text. Hidden entirely when missing so the meter doesn't
   * show an empty bar when no session/model is active.
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
  cost, context, contextPercent, contextTokens, contextEstimated,
  inputTokens, outputTokens, contextWindow,
  isBusy, agentCount, provider, model, costBadgeMode,
}: StatusBarProps) {
  const prov = provider ? getProviderInfo(provider) : null
  // #4204 Copilot review: compute each chip's tooltip once so the
  // `title` + `aria-label` mirror pair can't drift if the formatter
  // ever takes a code path with side effects.
  const costTip = costTooltip({ cost, provider })
  // #6769: occupancy-driven tooltip; the last-turn billing in/out counts ride
  // along as a clearly-labelled secondary breakdown.
  const contextTip = contextTooltip({
    percent: contextPercent ?? null,
    contextSummary: context,
    inputTokens,
    outputTokens,
    estimated: contextEstimated,
  })
  const agentTip = agentCountTooltip(agentCount)

  // #5065/#6769: compute the `used / total tokens` label + bar ONLY when the
  // provider reported an occupancy snapshot (`contextTokens`) AND the window
  // is known. There is deliberately NO fallback to input+output — those are
  // per-turn billing counts summed across agent-loop rounds and would
  // over-read fill ≈N× on an N-round turn (the #6816 review finding).
  // Providers with no snapshot show no meter at all (honest dash state).
  const usedTokens = contextTokens ?? 0
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
