/**
 * Shared cost-formatting helpers (#4123).
 *
 * Both the dashboard's sidebar badge (#4073) and the mobile session-
 * header badge (#4074) format the same `cumulativeUsage.costUsd` value
 * the same way. Keeping the implementation in one place avoids drift —
 * if the dashboard's badge ever showed `$0.07` while the app showed
 * `$0.070`, users would think the two surfaces disagreed on cost.
 *
 * Pure functions with no DOM/RN dependencies — safe to import from
 * either consumer.
 */

import type { CumulativeUsage } from './types'

/**
 * Format a USD value for the cost badge. Three tiers of fixed-decimal
 * precision based on magnitude — sub-dollar accuracy matters for spotting
 * whether a session ran one tiny test or dozens of expensive turns; at
 * dollar scale, fractional cents are noise.
 *
 *   `< $0.01`  → 4 decimals (`$0.0023`) — very small turns stay readable
 *   `$0.01–$1` → 3 decimals (`$0.070`, `$0.420`) — sub-dollar accuracy
 *   `>= $1`    → 2 decimals (`$1.23`, `$42.50`) — dollars are the unit
 *
 * Returns `'$0'` for zero / negative / non-finite input (defensive — the
 * Sidebar still guards on `> 0` before rendering, but a corrupted
 * upstream payload must not poison the renderer with `$NaN`).
 */
export function formatCostBadge(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return '$0'
  if (costUsd >= 1) return `$${costUsd.toFixed(2)}`
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`
  return `$${costUsd.toFixed(3)}`
}

/**
 * #5039: error-path partial-cost snapshot folded onto a server `error`
 * event when the failed turn ran any parent rounds + Task subagent
 * calls before the error fired. Shape returned by `handleError` and
 * consumed by `formatPartialCostLine` below — see PR #5037 wire side
 * and #5038 cumulative-tracker fold.
 */
export interface ErrorPartialCost {
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/**
 * #5039: human-readable one-liner for the error-path partial cost.
 *
 *   `"This turn cost $0.087 (1.2K in · 3.4K out)"`
 *
 * Used as a sub-line under the main error message on the dashboard
 * toast (`<span data-testid="toast-partial-cost-*">`) and appended to
 * the mobile `Alert.alert` body. Single source of truth so the two
 * surfaces can't drift apart in copy/format.
 *
 * Falls back to a cost-only string when the usage object was empty (a
 * subscription-billed provider that only produced a cost). Token counts
 * use the same K/M abbreviation as `SidebarTokenView.formatTokenCount`
 * — kept inline here to keep cost-format dependency-free.
 */
export function formatPartialCostLine(partial: ErrorPartialCost): string {
  const cost = formatCostBadge(partial.costUsd)
  const inTokens = partial.inputTokens
  const outTokens = partial.outputTokens
  if (inTokens <= 0 && outTokens <= 0) {
    return `This turn cost ${cost}`
  }
  return `This turn cost ${cost} (${formatTokens(inTokens)} in · ${formatTokens(outTokens)} out)`
}

/** Token-count abbreviation mirroring `SidebarTokenView.formatTokenCount`. */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(n)
  if (n < 999_500) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/**
 * Build the multi-line breakdown shown in the dashboard's native browser
 * tooltip (the cost-badge hover popover) — one string, six rows separated
 * by newlines, suitable for a `<span title={...}>` attribute.
 *
 * Not currently used by the mobile app: SettingsBar.tsx's tap-to-expand
 * sheet renders the six rows directly as `<View>` rows with separate
 * label / value text nodes (#4074), since RN doesn't support multi-line
 * tooltips. The two surfaces produce the same six pieces of information
 * in the same order; this helper formats the dashboard's native-tooltip
 * form.
 */
export function formatCostBreakdown(usage: CumulativeUsage): string {
  const fmt = (n: number) => n.toLocaleString()
  return [
    `Total cost: $${usage.costUsd.toFixed(4)}`,
    `Turns billed: ${fmt(usage.turnsBilled)}`,
    `Input tokens: ${fmt(usage.inputTokens)}`,
    `Output tokens: ${fmt(usage.outputTokens)}`,
    `Cache read: ${fmt(usage.cacheReadTokens)}`,
    `Cache write: ${fmt(usage.cacheCreationTokens)}`,
  ].join('\n')
}
