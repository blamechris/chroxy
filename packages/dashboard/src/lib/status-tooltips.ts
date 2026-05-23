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

/**
 * Provider ids whose cost is computed client-side from token usage
 * (Codex, Gemini) rather than reported by the server (Claude). When the
 * cost chip describes a client-estimated value, the tooltip says so.
 */
const CLIENT_ESTIMATED_COST_PROVIDERS = new Set(['codex', 'gemini'])

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
}

export function contextTooltip({ percent, contextSummary }: ContextTooltipArgs): string {
  if (percent == null && !contextSummary) {
    return 'No context usage yet — meter fills after the first turn completes.'
  }
  // KEY: clarify per-turn vs cumulative. The #3858 issue calls this out
  // as the most confusing one because 100% red looks alarming but the
  // value is the LAST TURN's prompt size, not a cumulative spend.
  const lead = percent != null
    ? `Most recent turn used ${percent}% of the model's context window.`
    : 'Most recent turn context usage.'
  const detail = contextSummary ? ` (${contextSummary})` : ''
  return `${lead}${detail} This is per-turn — the bar resets each turn and the visible width caps at 100%.`
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

export function agentCountTooltip(count: number): string {
  if (!count || count <= 0) return ''
  const noun = count === 1 ? 'agent' : 'agents'
  return `${count} background ${noun} currently active in this session.`
}

export interface TokenChipTooltipArgs {
  inputTokens: number
  outputTokens: number
}

export function tokenChipTooltip(args: TokenChipTooltipArgs | null): string {
  if (!args) {
    return 'No usage yet — token count appears after the first turn completes.'
  }
  const { inputTokens, outputTokens } = args
  const inK = Math.round(inputTokens / 1000)
  const outK = Math.round(outputTokens / 1000)
  const totalK = Math.round((inputTokens + outputTokens) / 1000)
  return `Most recent turn: ${inK}k input + ${outK}k output = ${totalK}k tokens sent to the model. Not cumulative.`
}
