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
 * Format a USD value for the session-overview rows (per-session + total) —
 * a DETAIL register distinct from `formatCostBadge`. The overview favours a
 * clean "no spend yet" affordance and a friendly sub-cent label over always
 * rendering a precise number:
 *
 *   `null` / `0`    → '—' (em-dash) — "no cost recorded yet", visually
 *                     distinct from a real `$0.00`
 *   `0 < x < $0.01` → '<$0.01' — human-friendly "basically free" label
 *   `>= $0.01`      → 2 decimals (`$1.23`, `$12.50`)
 *
 * Used by the mobile SessionOverview screen. Kept here (not inlined in the
 * component) so every cost formatter shares one home and the app/dashboard
 * can't drift on cost display — the reason this module exists (#4123 / #6201).
 */
export function formatCostOverview(cost: number | null): string {
  if (cost === null || cost === 0) return '—'
  if (cost > 0 && cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
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
 * use the canonical `formatTokens` K/M abbreviation.
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

/**
 * Canonical token-count formatters (#5058 / #5094).
 *
 * The dashboard accumulated five subtly-different K/M token formatters
 * (uppercase `K` vs lowercase `k`, 1- vs 2-decimal `M`, two of them with
 * an overflow bug that rendered `1000k` / `1000.0k` at exactly 1M instead
 * of rolling over). The same fill amount could render as `30k`, `30.0k`,
 * `30.0K`, or `30K` depending on which surface displayed it.
 *
 * We collapse them to TWO canonical helpers, both living here in
 * `@chroxy/store-core` so every surface (dashboard sidebar, status/footer
 * tooltips, header meter, error-path cost line) draws from one source:
 *
 *   - `formatTokens`        — STANDARD: uppercase `K` (1 decimal), `M`
 *                             (2 decimals). Used by the sidebar token view,
 *                             the cost-badge tooltip breakdown, and the
 *                             error-path partial-cost line. Higher
 *                             precision for the detailed/breakdown surfaces.
 *   - `formatTokensCompact` — COMPACT: lowercase `k` (1 decimal), `M`
 *                             (1 decimal, trailing `.0` stripped so common
 *                             window sizes show `1M` / `2M`). Used by the
 *                             header status-line meter, the context chip
 *                             label, and the context-chip breakdown
 *                             tooltip. Tighter for single-line chips.
 *
 * #5058 guard decision: the defensive `!Number.isFinite(n) || n <= 0 → '0'`
 * guard lives ON the shared helpers (not as a per-caller wrapper). It is
 * cheap, and the wire-data consumers (`formatPartialCostLine` via
 * `pickFiniteTokenCount`, the context tooltip fed from raw turn usage)
 * need it — putting it on the helper makes every caller safe by default
 * and a corrupted upstream payload can't poison any renderer with `NaN`.
 */

/**
 * STANDARD token-count abbreviation — uppercase `K`, 2-decimal `M`.
 *
 *   formatTokens(0)         → "0"
 *   formatTokens(999)       → "999"
 *   formatTokens(1234)      → "1.2K"
 *   formatTokens(999_499)   → "999.5K"
 *   formatTokens(999_500)   → "1.00M"   ← rolls to M before "1000.0K"
 *   formatTokens(1_000_000) → "1.00M"
 *   formatTokens(1_500_000) → "1.50M"
 *
 * Rolls over to `M` when the K-rounded value would reach 1000 (n ≥ 999_500
 * rounds to 1000.0K) to avoid the "1000.0K" visual nonsense. Returns "0"
 * defensively for zero / negative / non-finite input.
 *
 * Non-integer input (possible via untyped wire data through
 * `pickFiniteTokenCount`) is rounded to an integer FIRST, so the
 * threshold checks below run on the same value that gets rendered —
 * otherwise 999.6 would pass the `< 1000` branch yet render as "1000"
 * with no `K` suffix.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  n = Math.round(n)
  if (n < 1000) return String(n)
  if (n < 999_500) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/**
 * #5065: COMPACT lowercase token formatter for the header status-line
 * `used / total tokens` label.
 *
 *   formatTokensCompact(0)         → "0"
 *   formatTokensCompact(999)       → "999"
 *   formatTokensCompact(1_000)     → "1.0k"
 *   formatTokensCompact(30_000)    → "30.0k"
 *   formatTokensCompact(999_500)   → "1M"   (rolls to M before "1000.0k")
 *   formatTokensCompact(1_000_000) → "1M"
 *   formatTokensCompact(1_500_000) → "1.5M"
 *
 * Whole-million values drop the trailing ".0" so the common context-window
 * sizes (200k / 1M / 2M) render as the marketing label users recognise
 * rather than "1.0M". Uses lowercase `k` / uppercase `M` to match the
 * existing `formatContext` helper in App.tsx that already produces "30k
 * tokens" — keeping the header label visually consistent with the chip.
 *
 * Non-finite or non-positive input returns "0" defensively so a corrupted
 * upstream payload can't poison the renderer with "NaN" / "Infinity".
 */
export function formatTokensCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  // Round non-integer wire data to an integer first so the threshold
  // checks below run on the same value that gets rendered (mirrors
  // `formatTokens`): otherwise 999.6 would pass `< 1000` yet render "1000".
  n = Math.round(n)
  if (n < 1000) return String(n)
  if (n < 999_500) return `${(n / 1000).toFixed(1)}k`
  // Round to one decimal first, then strip a trailing ".0" so whole
  // millions render as "1M" / "2M" / "1M" (rolled over from 999_500)
  // rather than the visually noisy "1.0M". One decimal is enough
  // resolution for a status-line chip — sub-100k differences inside a
  // multi-million window aren't legible there anyway.
  const m = n / 1_000_000
  const rounded = m.toFixed(1)
  return rounded.endsWith('.0') ? `${rounded.slice(0, -2)}M` : `${rounded}M`
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
