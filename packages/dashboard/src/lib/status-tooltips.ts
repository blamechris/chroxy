/**
 * Status-chip tooltips (#3858).
 *
 * Both StatusBar (top header) and FooterBar (bottom) render the same
 * read-only status chips — cost, context %, model, agent count, per-turn
 * token chip. Each one looks interactable but isn't, and the values are
 * easy to misread (especially context %, which shows the LAST TURN's
 * prompt size as a fraction of the model window, NOT a cumulative session
 * total — 100% red looks alarming but is purely per-turn).
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
  /** Percent of model window the most-recent turn consumed (may exceed 100). */
  percent: number | null
  /** Formatted summary string ("90k / 200k tokens"). */
  contextSummary?: string
  /**
   * #4205: raw input/output token counts for the most-recent turn. When
   * both are present, the tooltip appends an
   * `${in}k input + ${out}k output = ${total}k tokens` breakdown so the
   * chip explains where the percent came from (#3858's original
   * acceptance criterion — the helper was implemented + tested in #4204
   * but left unwired pending this issue). Either undefined skips the
   * breakdown so pre-first-turn renders stay clean.
   */
  inputTokens?: number
  outputTokens?: number
}

export function contextTooltip({
  percent,
  contextSummary,
  inputTokens,
  outputTokens,
}: ContextTooltipArgs): string {
  if (percent == null && !contextSummary && inputTokens == null && outputTokens == null) {
    return 'No context usage yet — meter fills after the first turn completes.'
  }
  // KEY: clarify per-turn vs cumulative. The #3858 issue calls this out
  // as the most confusing one because 100% red looks alarming but the
  // value is the LAST TURN's prompt size, not a cumulative spend.
  // Percent rounds to 1 decimal — App.tsx computes it as a float
  // ((total/contextWindow)*100) so without rounding we'd get
  // "12.3456789%" in the tooltip (Copilot review on #4204).
  const lead = percent != null
    ? `Most recent turn used ${roundPercent(percent)}% of the model's context window.`
    : 'Most recent turn context usage.'
  const detail = contextSummary ? ` (${contextSummary})` : ''
  // #4205: when both input/output are known, append the breakdown so the
  // single chip carries both the percent ("how full?") and the in/out
  // split ("what filled it?"). Composed rather than added as a separate
  // chip — the issue's "out of scope" pins this to enriching the
  // existing context chip.
  const breakdown = (inputTokens != null && outputTokens != null)
    ? ' ' + tokenChipTooltip({ inputTokens, outputTokens })
    : ''
  return `${lead}${detail} This is per-turn — resets each turn and the visible width caps at 100%.${breakdown}`
}

export interface TokenChipTooltipArgs {
  /** Input tokens the most-recent turn sent (prompt + context). */
  inputTokens: number
  /** Output tokens the most-recent turn produced (assistant reply). */
  outputTokens: number
}

/**
 * #4205 (re-introduced from #4204): "1.2k input + 0.3k output = 1.5k
 * tokens" breakdown for the context chip's hover. Composed into
 * `contextTooltip` rather than rendered as its own chip — the issue's
 * "out of scope" section pins this to enriching the existing chip.
 *
 * Token counts under 1000 render in raw form ("450 tokens"); 1000+
 * round to one decimal as kilo ("1.5k"). Matches `formatContext` in
 * App.tsx so the chip text + tooltip stay visually consistent.
 */
export function tokenChipTooltip({ inputTokens, outputTokens }: TokenChipTooltipArgs): string {
  const total = inputTokens + outputTokens
  return `Breakdown: ${formatTokens(inputTokens)} input + ${formatTokens(outputTokens)} output = ${formatTokens(total)} tokens.`
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  // Trim trailing .0 the same way roundPercent does — "1k" is cleaner
  // than "1.0k" for round multiples of 1000.
  return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`
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

