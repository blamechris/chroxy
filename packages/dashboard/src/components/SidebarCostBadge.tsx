/**
 * SidebarCostBadge — the configurable header cost/info badge (#5184, epic #5170).
 *
 * The header badge used to be hard-wired to "<provider-short> $<cost>"
 * (e.g. "SDK $0.2903"). Users liked the badge but wanted control over WHAT
 * it shows, so the content is now driven by a `mode` chosen in Settings and
 * persisted via the connection store (see `costBadgeMode`).
 *
 * Modes:
 *   - `provider-model`  (DEFAULT) — "Claude Code (SDK) · Sonnet 4.6"
 *   - `cost`            — the dollar cost ("$0.2903"), the legacy behaviour
 *   - `tokens`          — total input+output tokens for the turn ("30.0k tokens")
 *   - `context-pct`     — percent of the model context window used ("45%")
 *   - `session-type`    — the SDK/CLI/TUI/BYOK session-type tag ("SDK")
 *
 * Pure / presentational: every input arrives via props so the badge is
 * trivially testable and free of store coupling. The host (StatusBar) reads
 * the mode + data from the store and forwards them.
 */
import { formatTokensCompact, getProviderInfo } from '@chroxy/store-core'

/**
 * Display modes for the header cost badge. Exported (with the matching
 * runtime guard below) so the store rehydrate path and the Settings select
 * can share a single source of truth — a new mode added to the union but
 * not to `COST_BADGE_MODES` is a TS error, mirroring the `VoiceInputMode`
 * pattern in store-core.
 */
export type CostBadgeMode =
  | 'provider-model'
  | 'cost'
  | 'tokens'
  | 'context-pct'
  | 'session-type'

/** Default mode — what a fresh install / unset localStorage shows. */
export const DEFAULT_COST_BADGE_MODE: CostBadgeMode = 'provider-model'

/**
 * Exhaustive list of modes. The `Record<CostBadgeMode, true>` keying makes
 * forgetting to list a new union member a compile error.
 */
const COST_BADGE_MODE_MAP: Record<CostBadgeMode, true> = {
  'provider-model': true,
  cost: true,
  tokens: true,
  'context-pct': true,
  'session-type': true,
}

export const COST_BADGE_MODES = Object.keys(COST_BADGE_MODE_MAP) as CostBadgeMode[]

/** Runtime guard — narrows an arbitrary string to a valid mode. */
export function isCostBadgeMode(value: unknown): value is CostBadgeMode {
  return typeof value === 'string' && value in COST_BADGE_MODE_MAP
}

/** Human-readable labels for the Settings select. */
export const COST_BADGE_MODE_LABELS: Record<CostBadgeMode, string> = {
  'provider-model': 'Provider / model',
  cost: 'Cost ($)',
  tokens: 'Token count',
  'context-pct': '% of context used',
  'session-type': 'Session type',
}

const NBSP = ' '

export interface SidebarCostBadgeProps {
  /** Which piece of info to render. Defaults to `provider-model`. */
  mode?: CostBadgeMode
  /** Total session cost in USD (drives `cost` mode). */
  cost?: number | null
  /** Provider id, e.g. `claude-sdk` (drives `provider-model` + `session-type`). */
  provider?: string | null
  /** Human-readable model label, e.g. `Sonnet 4.6` (drives `provider-model`). */
  model?: string | null
  /** Raw input tokens for the turn (drives `tokens`). */
  inputTokens?: number | null
  /** Raw output tokens for the turn (drives `tokens`). */
  outputTokens?: number | null
  /** Percent of the model context window used (drives `context-pct`). */
  contextPercent?: number | null
  /** Tooltip text — host computes the same tooltip it always did. */
  title?: string
  /** Extra class names appended to the base `cost-badge`. */
  className?: string
}

/**
 * Compute the badge text for a given mode. Returns NBSP when the requested
 * datum is missing so the badge keeps its footprint (no layout shift) the
 * same way the legacy `status-cost` span did.
 */
export function formatCostBadgeContent(props: SidebarCostBadgeProps): string {
  const {
    mode = DEFAULT_COST_BADGE_MODE,
    cost,
    provider,
    model,
    inputTokens,
    outputTokens,
    contextPercent,
  } = props

  switch (mode) {
    case 'cost':
      return cost != null && Number.isFinite(cost) ? `$${cost.toFixed(4)}` : NBSP
    case 'tokens': {
      const total = (inputTokens ?? 0) + (outputTokens ?? 0)
      return total > 0 ? `${formatTokensCompact(total)} tokens` : NBSP
    }
    case 'context-pct':
      return contextPercent != null && Number.isFinite(contextPercent)
        ? `${Math.round(contextPercent)}%`
        : NBSP
    case 'session-type':
      return provider ? getProviderInfo(provider).short : NBSP
    case 'provider-model':
    default: {
      if (!provider) return model || NBSP
      const label = getProviderInfo(provider).label
      // "Claude Code (SDK) · Sonnet 4.6" — drop the separator + model when
      // we have no model label yet (idle session before the first turn).
      return model ? `${label} · ${model}` : label
    }
  }
}

export function SidebarCostBadge(props: SidebarCostBadgeProps) {
  const { title, className } = props
  const mode = props.mode ?? DEFAULT_COST_BADGE_MODE
  const content = formatCostBadgeContent(props)
  const cls = className ? `cost-badge ${className}` : 'cost-badge'

  return (
    <span
      className={cls}
      data-testid="sidebar-cost-badge"
      data-cost-badge-mode={mode}
      title={title}
      aria-label={title}
    >
      {content}
    </span>
  )
}
