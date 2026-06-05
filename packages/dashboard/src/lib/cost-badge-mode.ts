/**
 * Cost-badge display mode — the union, default, runtime guard, labels, and
 * content formatter for the configurable header badge (#5184, epic #5170).
 *
 * Lives in `lib/` (a plain, non-React module) so the store layer
 * (`store/connection.ts`, `store/types.ts`) can import the type + guard +
 * default WITHOUT pulling a `.tsx` component (and its JSX runtime) into the
 * non-UI dependency graph. `SidebarCostBadge.tsx` re-exports everything here
 * so existing component-level imports keep working.
 *
 * Modes:
 *   - `provider-model`  (DEFAULT) — "Claude Code (SDK) · Sonnet 4.6"
 *   - `cost`            — the dollar cost ("$0.2903"), the legacy behaviour
 *   - `tokens`          — total input+output tokens for the turn ("30.0k tokens")
 *   - `context-pct`     — percent of the model context window used ("45%")
 *   - `session-type`    — the SDK/CLI/TUI/BYOK session-type tag ("SDK")
 */
import { formatTokensCompact, getProviderInfo } from '@chroxy/store-core'

/**
 * Display modes for the header cost badge. Paired with the matching runtime
 * guard below so the store rehydrate path and the Settings select share one
 * source of truth — a new mode added to the union but not to
 * `COST_BADGE_MODE_MAP` is a TS error, mirroring the `VoiceInputMode`
 * pattern in store-core.
 */
export type CostBadgeMode =
  | 'provider-model'
  | 'cost'
  | 'tokens'
  | 'context-pct'
  | 'session-type'

/** Default mode — what a fresh install / unset localStorage shows.
 * #5203: defaults to `cost` because the two-row header's left identity group
 * now owns provider/model, so the right-side badge defaulting to provider-model
 * would duplicate it. Still fully switchable in Settings. */
export const DEFAULT_COST_BADGE_MODE: CostBadgeMode = 'cost'

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

/**
 * Runtime guard — narrows an arbitrary value to a valid mode.
 *
 * Uses `Object.prototype.hasOwnProperty` (NOT the `in` operator) so inherited
 * properties like `toString` / `constructor` / `__proto__` from a corrupt
 * localStorage value can't masquerade as a valid `CostBadgeMode`.
 */
export function isCostBadgeMode(value: unknown): value is CostBadgeMode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(COST_BADGE_MODE_MAP, value)
}

/** Human-readable labels for the Settings select. */
export const COST_BADGE_MODE_LABELS: Record<CostBadgeMode, string> = {
  'provider-model': 'Provider / model',
  cost: 'Cost ($)',
  tokens: 'Token count',
  'context-pct': '% of context used',
  'session-type': 'Session type',
}

// Explicit non-breaking-space escape rather than a literal NBSP character —
// keeps the source consistent with StatusBar.tsx (#4204) and avoids an
// invisible character that's easy to miss or auto-reformat.
const NBSP = ' '

export interface CostBadgeContentInput {
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
}

/**
 * Compute the badge text for a given mode. Returns NBSP when the requested
 * datum is missing so the badge keeps its footprint (no layout shift) the
 * same way the legacy `status-cost` span did.
 */
export function formatCostBadgeContent(input: CostBadgeContentInput): string {
  const {
    mode = DEFAULT_COST_BADGE_MODE,
    cost,
    provider,
    model,
    inputTokens,
    outputTokens,
    contextPercent,
  } = input

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
