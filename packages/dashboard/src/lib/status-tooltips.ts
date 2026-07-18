/**
 * Status-chip tooltips (#3858).
 *
 * Both StatusBar (top header) and FooterBar (bottom) render the same
 * read-only status chips — cost, context %, model, agent count, token
 * chip. Each one looks interactable but isn't, and the values are easy to
 * misread.
 *
 * #6769: the context % is now CUMULATIVE context-window fill — how full the
 * whole conversation currently makes the model's window (input + output +
 * cache_read + cache_creation of the latest turn, since the history lives in
 * cache_read), metered against the auto-compact-adjusted effective ceiling.
 * It grows as the conversation grows and steps DOWN after a compaction; it is
 * NOT the pre-#6769 per-turn prompt size that reset each turn. The tooltip
 * copy below reflects that cumulative meaning.
 *
 * This module returns the `title=` strings each chip surfaces on hover.
 * Native `title=` is enough (matches the existing QR / Share / cwd
 * tooltip pattern in FooterBar.tsx:82/100). Per the issue's "Out of scope"
 * section, we don't introduce a custom tooltip component.
 *
 * For non-button elements (cost <span>, agent badge <span>), the consumer
 * should ALSO pass the same string as `aria-label` so screen readers
 * announce it — native `title=` is not reliably exposed to AT on `<span>`.
 */

// #4206: the source-of-truth list lives in client-estimated-cost-providers.ts
// and is also imported by message-handler.ts (where the cost fallback fires).
// Adding a provider in one site without the other was the bug-in-waiting that
// motivated the extraction — see that module's header for the full why.
import { CLIENT_ESTIMATED_COST_PROVIDERS } from './client-estimated-cost-providers'
// #5094: canonical COMPACT token formatter (lowercase `k`, 1-decimal `M`,
// correct rollover at 1M). Replaces the old file-private `formatTokens`
// here that overflowed to "1000.0k" at exactly one million tokens.
import { formatTokensCompact } from '@chroxy/store-core'

export interface CostTooltipArgs {
  cost: number | undefined
  provider?: string
}

export function costTooltip({ cost, provider }: CostTooltipArgs): string {
  if (cost == null) {
    return 'No usage yet — cost will appear after the first turn completes.'
  }
  const base = `Total session cost so far: $${cost.toFixed(4)}.`
  if (provider && CLIENT_ESTIMATED_COST_PROVIDERS.has(provider)) {
    return `${base} Estimated client-side from token usage (Codex/Gemini don't return a server-authoritative cost).`
  }
  return base
}

export interface ContextTooltipArgs {
  /**
   * #6769: percent of the model's context window the whole conversation
   * currently fills (may exceed 100 once past the auto-compact ceiling).
   */
  percent: number | null
  /** Formatted summary string ("90k / 200k tokens"). */
  contextSummary?: string
  /**
   * #4205/#6769: raw input/output token counts for the most-recent turn.
   * When both are present the tooltip appends a `… = ${total}k tokens`
   * breakdown so the chip explains what fills the window. Either undefined
   * skips the breakdown so pre-first-turn renders stay clean.
   */
  inputTokens?: number
  outputTokens?: number
  /**
   * #6769: cached conversation history in the window (cache_read +
   * cache_creation). When > 0, the breakdown surfaces it as the dominant
   * term (`Nk cached history + …`) — under prompt caching the bulk of the
   * fill is history, not the new turn. Absent / 0 falls back to the plain
   * `input + output` breakdown (providers with no cache fields).
   */
  cachedTokens?: number
}

export function contextTooltip({
  percent,
  contextSummary,
  inputTokens,
  outputTokens,
  cachedTokens,
}: ContextTooltipArgs): string {
  if (percent == null && !contextSummary && inputTokens == null && outputTokens == null) {
    return 'No context usage yet — meter fills after the first turn completes.'
  }
  // #6769: this is CUMULATIVE window fill — the whole conversation, not the
  // last turn's prompt. It grows as you chat and steps down after a
  // compaction. Percent rounds to 1 decimal — App.tsx computes it as a float
  // (occupancy / effectiveWindow * 100) so without rounding we'd get
  // "12.3456789%" in the tooltip.
  const lead = percent != null
    ? `Conversation fills ${roundPercent(percent)}% of the model's context window (before auto-compact).`
    : 'Cumulative context-window fill.'
  const detail = contextSummary ? ` (${contextSummary})` : ''
  // #6769: append the cache-aware breakdown so the single chip carries both
  // the percent ("how full?") and the split ("what filled it?").
  const breakdown = (inputTokens != null && outputTokens != null)
    ? ' ' + tokenChipTooltip({ inputTokens, outputTokens, cachedTokens })
    : ''
  return `${lead}${detail} This tracks the whole conversation — it grows as you chat and steps down after a compaction.${breakdown}`
}

export interface TokenChipTooltipArgs {
  /** New (uncached) input tokens the most-recent turn sent. */
  inputTokens: number
  /** Output tokens the most-recent turn produced (assistant reply). */
  outputTokens: number
  /**
   * #6769: cached conversation history in the window (cache_read +
   * cache_creation). When > 0 it's surfaced as the leading term and folded
   * into the total; absent / 0 gives the plain `input + output` breakdown.
   */
  cachedTokens?: number
}

/**
 * #4205/#6769: token breakdown for the context chip's hover.
 *
 * Under prompt caching the conversation history dominates (cache_read), so
 * when `cachedTokens > 0` the breakdown reads
 * "Nk cached history + Ik new input + Ok output = Tk tokens" — the total is
 * the cumulative window occupancy. Providers with no cache fields (cachedTokens
 * absent / 0) fall back to the plain "Ik input + Ok output = Tk tokens".
 *
 * Token counts under 1000 render in raw form ("450 tokens"); 1000+
 * abbreviate as kilo ("1.5k") via the canonical `formatTokensCompact`,
 * matching the header meter + `formatContext` chip in App.tsx so the chip
 * text + tooltip stay visually consistent (#5094).
 */
export function tokenChipTooltip({ inputTokens, outputTokens, cachedTokens }: TokenChipTooltipArgs): string {
  const cached = cachedTokens != null && cachedTokens > 0 ? cachedTokens : 0
  const total = cached + inputTokens + outputTokens
  const parts = cached > 0
    ? `${formatTokensCompact(cached)} cached history + ${formatTokensCompact(inputTokens)} new input + ${formatTokensCompact(outputTokens)} output`
    : `${formatTokensCompact(inputTokens)} input + ${formatTokensCompact(outputTokens)} output`
  return `Breakdown: ${parts} = ${formatTokensCompact(total)} tokens.`
}

function roundPercent(n: number): string {
  // 1-decimal precision is enough; trim trailing .0 for clean rounds.
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

export interface ModelTooltipArgs {
  model: string | undefined
  /** Optional model context-window size in tokens (e.g. 200_000). */
  contextWindow?: number
}

export function modelTooltip({ model, contextWindow }: ModelTooltipArgs): string {
  if (!model) return 'Active model unknown.'
  const winSuffix = contextWindow
    ? ` Context window: ${contextWindow.toLocaleString()} tokens.`
    : ''
  return `Active model: ${model}.${winSuffix}`
}

export function agentCountTooltip(count?: number | null): string {
  if (!count || count <= 0) return ''
  const noun = count === 1 ? 'agent' : 'agents'
  return `${count} background ${noun} currently active in this session.`
}

