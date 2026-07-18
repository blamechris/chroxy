/**
 * Status-chip tooltips (#3858).
 *
 * Both StatusBar (top header) and FooterBar (bottom) render the same
 * read-only status chips — cost, context %, model, agent count, token
 * chip. Each one looks interactable but isn't, and the values are easy to
 * misread.
 *
 * #6769: the context % is window OCCUPANCY — how many tokens the conversation
 * currently occupies in the model's window, from the provider's end-of-turn
 * snapshot (SDK getContextUsage() / byok final-round prompt), metered against
 * the real auto-compact threshold when known. It grows as the conversation
 * grows and steps DOWN after a compaction. It is NEVER computed from the
 * billing usage aggregate (which sums across agent-loop rounds and over-reads
 * fill), and it is NOT the pre-#6769 per-turn prompt size that reset each
 * turn. The tooltip copy below reflects the occupancy meaning; the last-turn
 * billing in/out counts appear only as a clearly-labelled secondary line.
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
   * #6769: percent of the meter ceiling (real auto-compact threshold when
   * known) the conversation currently occupies. May exceed 100 past the
   * ceiling. Null when the provider has no occupancy signal.
   */
  percent: number | null
  /** Formatted summary string ("110.0k tokens"). */
  contextSummary?: string
  /**
   * #4205: raw input/output token counts BILLED for the most-recent turn.
   * When both are present the tooltip appends a clearly-labelled last-turn
   * billing line — deliberately separate from the occupancy lead, because
   * billing counts are summed across agent-loop rounds and do NOT describe
   * window fill. Either undefined skips the line.
   */
  inputTokens?: number
  outputTokens?: number
  /**
   * #6769: true when the occupancy comes from byok's final-round prompt
   * estimate rather than the SDK's authoritative context-usage API.
   */
  estimated?: boolean
}

export function contextTooltip({
  percent,
  contextSummary,
  inputTokens,
  outputTokens,
  estimated,
}: ContextTooltipArgs): string {
  if (percent == null && !contextSummary && inputTokens == null && outputTokens == null) {
    return 'No context usage yet — meter fills after the first turn completes.'
  }
  // #6769: this is window OCCUPANCY from the provider's end-of-turn snapshot.
  // The auto-compact phrasing ("usable space before auto-compact" / "steps
  // down after a compaction") applies ONLY to sources with a REAL threshold
  // (the SDK snapshot). Estimated sources (the byok final-round family —
  // there's no compaction boundary behind their reserve-fallback ceiling)
  // phrase it as plain context-window fill, flagged as estimated.
  // Percent rounds to 1 decimal — App.tsx computes it as a float
  // (occupancy / ceiling * 100) so without rounding we'd get
  // "12.3456789%" in the tooltip.
  const lead = percent != null
    ? estimated
      ? `Conversation fills ${roundPercent(percent)}% of the model's context window (estimated).`
      : `Conversation occupies ${roundPercent(percent)}% of the context window's usable space (before auto-compact).`
    : estimated
      ? 'Context-window fill (estimated).'
      : 'Context-window occupancy.'
  const detail = contextSummary ? ` (${contextSummary})` : ''
  const behaviour = estimated
    ? ' Estimated from the last API round — grows with the conversation.'
    : ' Grows with the conversation and steps down after a compaction.'
  // #4205: the last-turn billing line stays available on hover, clearly
  // labelled so it can't be read as window fill (#6769).
  const breakdown = (inputTokens != null && outputTokens != null)
    ? ' ' + tokenChipTooltip({ inputTokens, outputTokens })
    : ''
  return `${lead}${detail}${behaviour}${breakdown}`
}

export interface TokenChipTooltipArgs {
  /** Input tokens billed for the most-recent turn (all agent-loop rounds). */
  inputTokens: number
  /** Output tokens billed for the most-recent turn (all agent-loop rounds). */
  outputTokens: number
}

/**
 * #4205/#6769: last-turn BILLING breakdown for the context chip's hover.
 *
 * These are the turn's billed token counts (summed across the turn's
 * agent-loop rounds) — labelled as billing so they can't be mistaken for
 * window occupancy, which the tooltip lead covers from the snapshot.
 *
 * Token counts under 1000 render in raw form ("450 tokens"); 1000+
 * abbreviate as kilo ("1.5k") via the canonical `formatTokensCompact`,
 * matching the header meter + `formatContext` chip in App.tsx so the chip
 * text + tooltip stay visually consistent (#5094).
 */
export function tokenChipTooltip({ inputTokens, outputTokens }: TokenChipTooltipArgs): string {
  const total = inputTokens + outputTokens
  return `Last turn billed: ${formatTokensCompact(inputTokens)} input + ${formatTokensCompact(outputTokens)} output = ${formatTokensCompact(total)} tokens.`
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

