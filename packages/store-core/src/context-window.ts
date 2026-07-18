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
import type { ContextOccupancy, ModelInfo } from './types'

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
// #6769 — context-window fill from an OCCUPANCY SNAPSHOT, never from billing.
//
// SEMANTIC MODEL (verified against the drivers, PR #6816 review):
//
// A `result.usage` object is a per-turn BILLING aggregate summed across every
// agent-loop round of the turn — byok-session.js explicitly accumulates
// `cache_read_input_tokens` per round (#4056), and the SDK/CLI forward the
// driver's whole-turn aggregate (it sits beside `num_turns` / `total_cost_usd`
// and folds in subagent usage). For a turn with N tool-call rounds the
// conversation history is re-read from cache N times, so ANY total derived
// from `result.usage` over-reads occupancy ≈N× — a typical 8-round coding
// turn on a 100k history reads ≈850k "fill" on a 200k window. Billing usage
// is therefore NEVER an input to the meter.
//
// The honest input is an end-of-turn occupancy SNAPSHOT
// (`ContextOccupancy`, parsed from the result message's `contextOccupancy`
// wire field — deliberately NOT named `contextUsage`, which is the billing
// aggregate's client-state name). Two snapshot families exist today:
//
//   - claude-sdk: the Agent SDK's `getContextUsage()` control API —
//     `{ totalTokens, maxTokens, autoCompactThreshold (tokens),
//     isAutoCompactEnabled }`, the same numbers Claude Code's own /context
//     and status line show (the #6769 desktop-parity anchor).
//   - the byok agent-loop family (byok / docker-byok, and the subclasses
//     that reuse the loop: ollama, deepseek, anthropic-compatible): the
//     FINAL round's individual `input + cache_read + cache_creation` — that
//     round's true prompt size, i.e. the conversation as last sent to the
//     API. Emitted only when the endpoint actually reports per-round usage;
//     an endpoint that reports none produces no snapshot.
//
// A snapshot naturally persists across turns (each result re-reports it) and
// FOLLOWS A COMPACTION DOWN (the post-compaction snapshot is smaller) —
// nothing to accumulate, nothing to clamp. (Compaction *markers* are #6768,
// deliberately not implemented here.)
//
// Everything else — claude-cli (aggregate-only stream-json output, no control
// channel), claude-tui (no usage at all), codex / gemini (aggregate-only) —
// has NO occupancy signal: the snapshot stays null and every helper here
// returns null, so the meter renders its honest unknown/dash state. Never
// fabricate a number from billing usage.
// ---------------------------------------------------------------------------

/**
 * Fraction of the raw context window reserved as auto-compact headroom when
 * the snapshot does NOT carry a real `autoCompactThreshold`.
 *
 * DOCUMENTED FALLBACK, applied only where occupancy EXISTS without a
 * threshold (today: byok's final-round snapshot — byok trims history by turn
 * count, not tokens, so there is no real compaction boundary to read).
 * claude-sdk snapshots carry the SDK's real threshold and never touch this
 * constant. 0.08 approximates Claude Code's default ~92% trigger.
 *
 * NOTE: this is a CLIENT-SIDE presentation reserve and is a different thing
 * from the server's `CONTEXT_WINDOW_HEADROOM` (utils/context-window-learn.js),
 * which is an upward RATCHET multiplier (1.1) applied when learning a drifted
 * window — not a compaction reserve.
 */
export const CONTEXT_AUTO_COMPACT_RESERVE = 0.08

/**
 * The fallback effective ceiling: the raw window minus the documented
 * auto-compact reserve. `null` when the raw window is unknown / non-positive /
 * non-finite, so callers render the "unknown window" state instead of a
 * fabricated total. Used only when the occupancy snapshot has no real
 * `autoCompactThreshold` (see `contextFillPercent`).
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
 * Occupancy tokens from a snapshot, or `null` when there is no snapshot (the
 * provider has no occupancy signal → callers render the dash state) or the
 * snapshot is malformed. `0` is a valid answer (empty window).
 */
export function contextOccupancyTokens(
  occupancy: Pick<ContextOccupancy, 'totalTokens'> | null | undefined,
): number | null {
  if (!occupancy) return null
  const t = occupancy.totalTokens
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : null
}

/**
 * The ceiling the meter reads 100% at, for a given occupancy snapshot.
 *
 * Precedence (get the real number when it exists, fall back honestly):
 *   1. `autoCompactThreshold` (tokens) when present and auto-compact is not
 *      known-disabled — the SDK's real compaction boundary.
 *   2. The raw window when auto-compact is known-DISABLED — no compaction
 *      will occur, so the hard window is the honest ceiling.
 *   3. `effectiveContextWindow(raw window)` otherwise — the documented
 *      reserve fallback (byok's no-threshold snapshot).
 *
 * The raw window is `occupancy.maxTokens` when the snapshot carries it (SDK),
 * else the caller-resolved registry window (`resolveContextWindow`). Returns
 * `null` when no window is known at all.
 */
export function contextMeterCeiling(
  occupancy:
    | Pick<ContextOccupancy, 'maxTokens' | 'autoCompactThreshold' | 'isAutoCompactEnabled'>
    | null
    | undefined,
  resolvedWindow?: number | null,
): number | null {
  if (!occupancy) return null
  const pos = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  const windowTokens = pos(occupancy.maxTokens) ?? pos(resolvedWindow)
  const threshold = pos(occupancy.autoCompactThreshold)
  if (threshold != null && occupancy.isAutoCompactEnabled !== false) return threshold
  if (windowTokens == null) return null
  if (occupancy.isAutoCompactEnabled === false) return windowTokens
  return effectiveContextWindow(windowTokens)
}

/**
 * Percent of the meter ceiling the conversation currently fills. May exceed
 * 100 once occupancy passes the ceiling (the caller decides whether to clamp
 * the visual width).
 *
 * Returns `null` when there is no occupancy snapshot (no-signal providers →
 * dash), a zero-token snapshot, or no known ceiling — the cases where a
 * percentage would be meaningless or fabricated.
 */
export function contextFillPercent(
  occupancy: ContextOccupancy | null | undefined,
  resolvedWindow?: number | null,
): number | null {
  const tokens = contextOccupancyTokens(occupancy)
  if (tokens == null || tokens <= 0) return null
  const ceiling = contextMeterCeiling(occupancy, resolvedWindow)
  if (ceiling == null) return null
  return (tokens / ceiling) * 100
}
