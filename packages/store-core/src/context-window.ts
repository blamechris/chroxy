/**
 * #5424 — context-window resolution shared by the mobile SettingsBar and the
 * dashboard header/footer meters.
 *
 * `DEFAULT_CONTEXT_WINDOW` (200k) is a *Claude* default. The server's claude
 * registry always ships a real `contextWindow` per model, so the fallback
 * only fires for legacy servers that predate the field — which only ran
 * claude. Other providers can legitimately report no window at all: ollama
 * deliberately sends `contextWindow: null` (the effective window is the
 * local model file's `num_ctx` — the server never fabricates a number).
 * Rendering "% of 200k" for a local model whose real window may be 8k–32k
 * is misleading in the dangerous direction (looks fine while the model is
 * already truncating), so unknown stays unknown: callers get `null` and
 * must render an "unknown window" presentation (raw token count, no
 * percentage / progress bar) instead of a fabricated fraction.
 */
import { DEFAULT_CONTEXT_WINDOW } from './types'
import type { ContextUsage, ModelInfo } from './types'

/**
 * Claude-backed docker provider ids — an EXPLICIT allowlist, not a `docker-*`
 * prefix (#5448). Every id here runs a Claude session inside the container
 * (docker-cli / docker-sdk / docker-byok, plus the `docker` alias for docker-cli
 * — see provider-labels.ts and the server's registerDockerProvider). It is an
 * allowlist so a FUTURE non-Claude containerized provider registered under a
 * `docker-*` name (e.g. `docker-ollama`) FAILS CLOSED — it does NOT inherit the
 * Claude 200k default and instead resolves to a real `null` meter (the failure
 * mode #5424 fixed for ollama). The server pins its own DOCKER_PROVIDER_IDS to
 * this same set (providers.js) — each side's test fails if its list drifts — so
 * adding a docker provider trips a test and forces a conscious "is it
 * Claude-backed?" decision in both packages, instead of silently regressing the
 * context-window meter. (The two lists can't share an import: the server loads
 * only @chroxy/store-core/crypto, not this TS main entry.)
 */
export const CLAUDE_BACKED_DOCKER_IDS: ReadonlySet<string> = new Set([
  'docker', 'docker-cli', 'docker-sdk', 'docker-byok',
])

/**
 * Whether `provider` runs Claude models (and so may assume the Claude
 * 200k default when a model's `contextWindow` is missing).
 *
 * The claude-* family is matched by prefix (open-ended — every claude-* is
 * Claude). The docker family is matched by the EXPLICIT CLAUDE_BACKED_DOCKER_IDS
 * allowlist (#5448), NOT a `docker-*` prefix, so an unknown `docker-*` fails
 * closed rather than fabricating a 200k meter.
 *
 * `null`/`undefined` counts as Claude-backed: servers that predate
 * per-session provider reporting only ran claude, so the legacy fallback
 * behaviour is preserved for them.
 */
export function isClaudeBackedProvider(provider: string | null | undefined): boolean {
  if (provider == null) return true
  if (provider === 'claude' || provider.startsWith('claude-')) return true
  return CLAUDE_BACKED_DOCKER_IDS.has(provider)
}

/**
 * Resolve the context window (in tokens) to meter against for a model.
 *
 * - When the model reports a positive numeric `contextWindow`, that value
 *   wins — provider is irrelevant.
 * - When it's missing, the Claude 200k default applies ONLY to
 *   Claude-backed providers (see `isClaudeBackedProvider`).
 * - Otherwise returns `null`: the window is genuinely unknown and callers
 *   must not render a percentage against a made-up total.
 */
export function resolveContextWindow(
  modelInfo: Pick<ModelInfo, 'contextWindow'> | null | undefined,
  provider?: string | null,
): number | null {
  const cw = modelInfo?.contextWindow
  if (typeof cw === 'number' && Number.isFinite(cw) && cw > 0) return cw
  return isClaudeBackedProvider(provider) ? DEFAULT_CONTEXT_WINDOW : null
}

// ---------------------------------------------------------------------------
// #6769 — cumulative context-window fill (occupancy).
//
// SEMANTIC MODEL (chosen from the data source, not assumed):
//
// On Claude's API every `result` event's `usage` object ALREADY reports the
// full prompt that was sent for that turn, split across four fields:
//   - input_tokens                — new, uncached prompt tokens this turn
//   - cache_read_input_tokens     — the conversation history served FROM cache
//   - cache_creation_input_tokens — history written INTO the cache this turn
//   - output_tokens               — the assistant's reply
//
// Under prompt caching the bulk of a mid-conversation prompt lives in
// `cache_read_input_tokens`, so the current window occupancy at the turn
// boundary is:
//
//     input + cache_read + cache_creation + output
//
// NOT `input + output` (which, with caching on, is just the new user message
// plus the reply — it reads near-empty while the window is actually nearly
// full: the exact bug #6769 fixes).
//
// This value is ALREADY cumulative: each turn re-reports the whole history via
// `cache_read`, so reading the LATEST result's total is the conversation's
// current fill — there is nothing to sum across turns. Summing would double-
// count the history every turn (that is what the server's per-session
// `cumulativeUsage` billing total does — see types/session.ts — and why it is
// the wrong number for this meter).
//
// It also FOLLOWS A COMPACTION DOWN for free: after Claude auto-compacts, the
// next turn's `cache_read` is smaller, so occupancy drops rather than clamping
// to a per-session maximum. (Rendering an explicit compaction *marker* is
// #6768 — a separate issue, deliberately not implemented here.)
//
// Providers that omit the cache fields degrade to `input + output`
// automatically: `handleResultUsage` (handlers/stream.ts) defaults every
// missing numeric field to 0, so the cache terms vanish with no special-casing.
// Providers with no usage data at all (e.g. claude-tui) never populate
// `contextUsage`, so callers keep showing the dash/unknown state — this helper
// returns `null` for null usage and never fabricates a number.
// ---------------------------------------------------------------------------

/**
 * Current context-window occupancy in tokens for the most recent turn.
 *
 * = `inputTokens + outputTokens + cacheRead + cacheCreation`.
 *
 * Returns `null` only when there is no usage at all (pre-first-turn). An
 * all-zero usage object returns `0` (an empty turn) so callers can still
 * distinguish "0 tokens" from "unknown".
 *
 * Each field is coerced to a finite number (missing / non-finite → 0), the
 * same defensive rule `handleResultUsage` (handlers/stream.ts) applies when it
 * builds `ContextUsage` — so a partial object (e.g. a provider or persisted
 * cache shape that predates the cache fields) degrades to `input + output`
 * rather than poisoning the whole total to NaN.
 */
export function contextWindowTokens(
  usage:
    | Partial<Pick<ContextUsage, 'inputTokens' | 'outputTokens' | 'cacheRead' | 'cacheCreation'>>
    | null
    | undefined,
): number | null {
  if (!usage) return null
  const finite = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0
  return (
    finite(usage.inputTokens) +
    finite(usage.outputTokens) +
    finite(usage.cacheRead) +
    finite(usage.cacheCreation)
  )
}

/**
 * Fraction of the raw context window reserved as auto-compact headroom.
 *
 * Claude Code compacts BEFORE the hard window limit, so the meter should read
 * 100% (the "context left before auto-compact" gauge is exhausted) at the
 * compaction boundary, not at the raw ceiling. 0.08 mirrors Claude Code's
 * default ~92% auto-compact trigger.
 *
 * NOTE: this is a CLIENT-SIDE presentation reserve and is a different thing
 * from the server's `CONTEXT_WINDOW_HEADROOM` (utils/context-window-learn.js),
 * which is an upward RATCHET multiplier (1.1) applied when learning a drifted
 * window — not a compaction reserve.
 */
export const CONTEXT_AUTO_COMPACT_RESERVE = 0.08

/**
 * The effective ceiling to meter against: the raw window minus the auto-compact
 * reserve. `null` when the raw window is unknown / non-positive / non-finite,
 * so callers render the "unknown window" state instead of a fabricated total.
 */
export function effectiveContextWindow(
  contextWindow: number | null | undefined,
): number | null {
  if (
    typeof contextWindow !== 'number' ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return null
  }
  // Floor at 1 so a pathologically tiny window can't produce a 0 denominator.
  return Math.max(1, Math.round(contextWindow * (1 - CONTEXT_AUTO_COMPACT_RESERVE)))
}

/**
 * Percent of the effective (auto-compact-adjusted) context window the current
 * conversation fills. May exceed 100 once occupancy passes the compaction
 * boundary (the caller decides whether to clamp the visual width).
 *
 * Returns `null` when there is no usage yet, a zero-token conversation, or an
 * unknown window — the three cases where a percentage would be meaningless or
 * fabricated (callers fall back to the raw token-count / unknown-window state).
 */
export function contextFillPercent(
  usage:
    | Partial<Pick<ContextUsage, 'inputTokens' | 'outputTokens' | 'cacheRead' | 'cacheCreation'>>
    | null
    | undefined,
  contextWindow: number | null | undefined,
): number | null {
  const tokens = contextWindowTokens(usage)
  if (tokens == null || tokens <= 0) return null
  const ceiling = effectiveContextWindow(contextWindow)
  if (ceiling == null) return null
  return (tokens / ceiling) * 100
}
