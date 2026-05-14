/**
 * Tooltip strings for the read-only status chips in StatusBar and FooterBar
 * (#3858). Centralized so both header and footer surface the same prose for
 * the same data — avoids drift if the meaning of a value changes.
 *
 * Native `title=` is used rather than a custom tooltip component to match
 * the existing QR / Share / Settings buttons. Trade-off: native tooltips
 * are not screen-reader friendly on non-button elements — for those, the
 * call site adds an explicit `aria-label` derived from the same content.
 */

export interface ContextTooltipData {
  inputTokens: number
  outputTokens: number
  contextWindow: number | null
  percent: number | null
}

/**
 * Token chip — most recent turn breakdown. Falls back to a short generic
 * line when usage hasn't been recorded yet (first turn of a fresh session).
 */
export function tokenTooltip(usage: { inputTokens: number; outputTokens: number } | null): string {
  if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0)) {
    return 'Tokens sent to the model on the most recent turn. Updates after each response.'
  }
  const total = usage.inputTokens + usage.outputTokens
  const fmt = (n: number) => n.toLocaleString()
  return `Most recent turn: ${fmt(usage.inputTokens)} input + ${fmt(usage.outputTokens)} output = ${fmt(total)} tokens. Not cumulative across the session.`
}

/**
 * True iff `provider` belongs to the Claude family — covers raw `claude-*`
 * ids plus the Docker wrappers (`docker`, `docker-cli`, `docker-sdk`) that
 * inherit Claude's billing model. Mirrors the server-side
 * `_isClaudeFamilyProvider()` in `packages/server/src/skills-frontmatter.js`
 * — keep the two rules in sync so the cost-estimation disclaimer cannot
 * disagree between server billing and client tooltip. Exported for tests.
 */
export function isClaudeFamilyProvider(provider: string | null | undefined): boolean {
  if (typeof provider !== 'string') return false
  const norm = provider.trim().toLowerCase()
  if (norm.length === 0) return false
  if (norm === 'claude' || norm.startsWith('claude-')) return true
  if (norm === 'docker' || norm.startsWith('docker-')) return true
  return false
}

/**
 * Cost chip — total session cost so far. Notes when the value is
 * client-estimated from token usage (Codex/Gemini) rather than reported
 * authoritatively by the provider (Claude family — including Docker
 * wrappers).
 */
export function costTooltip(cost: number | null | undefined, provider: string | null | undefined): string {
  if (cost == null) return 'Total session cost so far. Updates after each response.'
  const suffix = isClaudeFamilyProvider(provider)
    ? ''
    : ' Estimated client-side from token usage; actual provider billing may differ.'
  return `Total session cost so far: $${cost.toFixed(4)}.${suffix}`
}

/**
 * Context window meter — per-turn (NOT cumulative). This is the
 * most-misunderstood value in the UI, so the tooltip emphasises it.
 */
export function contextTooltip(data: ContextTooltipData): string {
  const { inputTokens, outputTokens, contextWindow, percent } = data
  const total = inputTokens + outputTokens
  if (total === 0) {
    return 'How much of the model context window the most recent turn used. Per-turn, not cumulative.'
  }
  const fmt = (n: number) => n.toLocaleString()
  const pctStr = percent != null ? `${Math.min(Math.round(percent), 100)}% — ` : ''
  const windowStr = contextWindow ? ` of the model context window (${fmt(contextWindow)} tokens)` : ''
  return `${pctStr}${fmt(total)} tokens used by the most recent turn${windowStr}. Per-turn, not cumulative — the bar caps at 100%.`
}

/**
 * Active-agents chip — number of background agents currently working.
 */
export function agentTooltip(count: number): string {
  if (count === 0) return 'No background agents currently active.'
  const noun = count === 1 ? 'background agent' : 'background agents'
  return `${count} ${noun} currently active in this session.`
}

/**
 * Model chip — active model id + context window if known. The header pill
 * is clickable in some places; the footer label is read-only.
 */
export function modelTooltip(model: string | null | undefined, contextWindow: number | null | undefined): string {
  if (!model) return 'Active model. Click the model picker in the header to switch.'
  const win = contextWindow ? ` Context window: ${contextWindow.toLocaleString()} tokens.` : ''
  return `Active model: ${model}.${win}`
}
