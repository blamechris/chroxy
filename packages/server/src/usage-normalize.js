/**
 * Cross-provider per-model usage normalization (#6692).
 *
 * Every provider session emits a terminal `result` event whose flat `usage`
 * object feeds the per-session accumulator (session-manager `_trackUsage`).
 * What that flat shape cannot carry is a per-model split — the Agent SDK
 * reports one (`msg.modelUsage`, camelCase keys) and single-model providers
 * can synthesize one — so the result payload gains an ADDITIVE `modelUsage`
 * field in the shape below. Token keys stay snake_case so any cell can be
 * passed straight to `computePromptCostUsd` (models.js) unchanged.
 *
 *   modelUsage: {
 *     [modelId]: {
 *       input_tokens, output_tokens,
 *       cache_read_input_tokens, cache_creation_input_tokens,
 *       web_search_requests,
 *       cost_usd,            // provider-reported; null when unknown
 *     }
 *   } | null                 // null = provider produced nothing this turn
 *
 * Consumers must treat `modelUsage` as optional — `_trackUsage` and every
 * existing subscriber ignore unknown result fields by design.
 */

/**
 * Clamp to a non-negative finite integer — mirrors `_trackUsage`'s
 * tokenDelta coercion so a poisoned provider value can never drive an
 * accumulator negative or NaN.
 */
export function nonNegInt(x) {
  const n = Number(x)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/**
 * Normalize the Agent SDK's per-model usage map (camelCase ModelUsage
 * entries) into the wire contract above. Returns null when the input is
 * absent, not an object, or normalizes to zero entries.
 */
export function normalizeSdkModelUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const [modelId, u] of Object.entries(raw)) {
    if (!modelId || !u || typeof u !== 'object') continue
    out[modelId] = {
      input_tokens: nonNegInt(u.inputTokens ?? u.input_tokens),
      output_tokens: nonNegInt(u.outputTokens ?? u.output_tokens),
      cache_read_input_tokens: nonNegInt(u.cacheReadInputTokens ?? u.cache_read_input_tokens),
      cache_creation_input_tokens: nonNegInt(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens),
      web_search_requests: nonNegInt(u.webSearchRequests ?? u.web_search_requests),
      cost_usd: Number.isFinite(u.costUSD) ? u.costUSD : (Number.isFinite(u.cost_usd) ? u.cost_usd : null),
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Build a single-entry modelUsage map for providers that run exactly one
 * model per session (byok family, codex, gemini). `usage` is the provider's
 * flat snake_case turn usage; absent fields clamp to 0. Returns null when
 * the model id is unknown or the usage object carries no token signal at
 * all, so a both-null synthetic result (stream-stall recovery) never
 * fabricates an all-zero per-model row.
 *
 * Note the gate is BROADER than `_trackUsage`'s (session-manager.js), which
 * keys only on a finite `input_tokens`: this returns a row when ANY of the 5
 * token fields is finite. They coincide today because every provider call
 * site emits a finite `input_tokens` (0 or positive) whenever `usage` is an
 * object, so the sole divergence (an output-or-cache-only turn) can't arise.
 * A future consumer that sums these rows against `cumulativeUsage` should not
 * assume literal parity — if an output-only provider ever appears, this would
 * synthesize a row `_trackUsage` skips.
 */
export function synthesizeModelUsage(model, usage, costUsd = null) {
  if (!model || typeof model !== 'string') return null
  if (!usage || typeof usage !== 'object') return null
  const anyTokenSignal = [
    usage.input_tokens, usage.output_tokens,
    usage.cache_read_input_tokens, usage.cached_input_tokens,
    usage.cache_creation_input_tokens,
  ].some((v) => Number.isFinite(Number(v)))
  if (!anyTokenSignal) return null
  return {
    [model]: {
      input_tokens: nonNegInt(usage.input_tokens),
      output_tokens: nonNegInt(usage.output_tokens),
      // codex historically emitted `cached_input_tokens`; accept both so a
      // caller can hand this the raw pre-#6692 shape without dropping cache.
      cache_read_input_tokens: nonNegInt(usage.cache_read_input_tokens ?? usage.cached_input_tokens),
      cache_creation_input_tokens: nonNegInt(usage.cache_creation_input_tokens),
      web_search_requests: nonNegInt(usage.web_search_requests),
      cost_usd: Number.isFinite(costUsd) ? costUsd : null,
    },
  }
}

/**
 * Whether a provider's sessions produce token telemetry at all. claude-tui
 * and claude-channel emit `usage:null, cost:null` on every turn (Stop-hook
 * limitation), so anything that needs metering — orchestration runs (#6691),
 * cost comparisons — must refuse or caveat them. user-shell runs no model.
 */
const UNMETERABLE_PROVIDERS = new Set(['claude-tui', 'claude-channel', 'user-shell'])

export function isMeterableProvider(provider) {
  if (!provider || typeof provider !== 'string') return false
  return !UNMETERABLE_PROVIDERS.has(provider)
}
