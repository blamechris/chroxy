// Claude provider family's model catalog (#6201 OCP).
//
// Extracted VERBATIM from models.js so the generic models registry / overlay /
// cost engine in models.js no longer OWNS the Claude model roster — it merely
// consumes it. This is the inversion the #6201 audit wanted: adding a new
// Claude-family model is now a single-row edit HERE (MODEL_METADATA), not an
// edit to models.js's central tables. DeepSeek (#6365) was the first slice of
// the same move; this is the Claude slice.
//
// This module is a PURE LEAF: it imports nothing from models.js or any session
// class, so models.js can import it without a circular dependency, and all five
// Claude session classes (SdkSession / CliSession / ClaudeTuiSession /
// ClaudeChannelSession / ClaudeByokSession) can share one source of truth for
// their `getFallbackModels()` / `getModelMetadata()` statics — which were
// byte-identical copies before this consolidation.
//
// models.js re-exports DEFAULT_CONTEXT_WINDOW, ONE_M_SUFFIX, FALLBACK_MODELS,
// resolveClaudeContextWindow and claudeDeriveId under their original names, so
// every existing importer (and the test suites) is unaffected.

/** Default context window for unknown models. Also the floor of the Claude
 *  context-window heuristic below, and the generic registry fallback in
 *  models.js for providers that report no window. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Suffix the Claude CLI uses to mark the explicit 1M-context variant */
export const ONE_M_SUFFIX = '[1m]'

// Opus gained a 1M context window at 4.6. `[major, minor]` of the first opus
// release with a 1M window — opus at or above this (and any future opus major)
// is treated as 1M; earlier opus and every other family default to 200k. The
// SDK's authoritative modelUsage.contextWindow overrides this after turn 1, so a
// wrong cold-start guess only ever surfaces for the first turn.
const OPUS_ONE_M_MIN_VERSION = Object.freeze([4, 6])
// Matches an opus version token: `opus-<major>` with an OPTIONAL `-<minor>` /
// `.<minor>`, e.g. `claude-opus-4-8`, `claude-opus-4.8`, `claude-opus-5` (major
// only), or `claude-opus-4-7-20251201` (versioned + dated). Both major and minor
// are 1–2 digits NOT followed by another digit, so:
//   - a DATED base id like `claude-opus-4-20250514` (opus 4.0, dated — 200k) does
//     NOT read the date as a minor (the optional group fails → major-only 4.0);
//   - a `claude-3-opus-20240229` id does NOT read the 8-digit date as a major
//     (the major is capped at 2 digits + lookahead → no match → default).
const OPUS_VERSION_RE = /opus-(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?/

/**
 * Static context-window heuristic used at cold start before the SDK reports.
 * Opus 4.6+ has 1M (matched by family + version, so new minors/majors inherit it
 * without a code change); most other Claude models have 200k. Any id carrying the
 * explicit `[1m]` CLI suffix is a 1M-context variant regardless of the base
 * model. The SDK sends authoritative values in
 * `SDKResultSuccess.modelUsage[*].contextWindow` after each turn — registries
 * opportunistically correct themselves via `updateContextWindow()` so wrong
 * guesses only surface for the first turn.
 *
 * Exported so Claude providers (SdkSession/CliSession) can reuse it in
 * their `getModelMetadata()` implementations.
 */
export function resolveClaudeContextWindow(fullId) {
  if (typeof fullId !== 'string') return DEFAULT_CONTEXT_WINDOW
  if (fullId.endsWith(ONE_M_SUFFIX)) return 1_000_000
  const m = OPUS_VERSION_RE.exec(fullId)
  if (m) {
    const major = Number(m[1])
    const minor = m[2] === undefined ? null : Number(m[2])
    const [minMajor, minMinor] = OPUS_ONE_M_MIN_VERSION
    // A future major (opus 5+) is 1M with or without a minor; opus 4 needs an
    // explicit minor >= 6 (bare `opus-4` is 4.0 → 200k, not assumed 4.6).
    if (major > minMajor) return 1_000_000
    if (major === minMajor && minor !== null && minor >= minMinor) return 1_000_000
  }
  return DEFAULT_CONTEXT_WINDOW
}


/**
 * Default Claude ID converter: strips the `claude-` prefix to produce the
 * short id while keeping the full id as-is. Exported so provider classes
 * can compose it in their own `getModelMetadata()`.
 */
export function claudeDeriveId(fullId) {
  return typeof fullId === 'string' && fullId.startsWith('claude-') ? fullId.slice(7) : fullId
}

// Single source of truth for Claude model metadata (#5930 / #5631 DRY core).
// Each row describes one known Claude model family head; the two scattered
// data tables below — CLAUDE_FALLBACK_MODELS (cold-start / SDK-merge seed) and
// CLAUDE_PRICING_USD_PER_MTOK (per-fullId billing rates) — are DERIVED from
// this array, so adding a model is a single-row edit instead of edits in
// several hand-synced places. The regex/string heuristics
// (resolveClaudeContextWindow, humanizeModelId) intentionally stay separate:
// they are the graceful-degradation path for models NOT in this table.
//
// Per-row fields:
//   shortId, label, fullId — the CLAUDE_FALLBACK_MODELS triple. The fullIds are
//     versioned family heads WITHOUT a date suffix (e.g. `claude-opus-4-7`, not
//     `claude-opus-4-7-20251201`): the short aliases (sonnet/opus/haiku) resolve
//     to the latest version in the claude CLI, and the SDK's supportedModels()
//     is the source of truth for concrete date-pinned identifiers. These rows
//     also seed the merge step in updateModels() so a stale/minimal SDK response
//     still surfaces the newer chip in the picker (#3075).
//   contextWindow — OPTIONAL. When set it overrides the cold-start heuristic
//     for that known model (symmetric with the on-disk overlay in
//     computeFallbackModels); when absent (the case for every row today) it is
//     derived via resolveClaudeContextWindow(fullId), so the derivation is
//     byte-identical to the prior CLAUDE_FALLBACK_MODELS literals.
//   pricing — base Anthropic rates in USD per million tokens
//     {input, output, cacheRead, cacheWrite}. ABSENT (e.g. fable, shipped
//     without verified pricing) emits NO pricing key, so resolveModelPricing
//     returns null — never $0 — for it.
//   oneM — the `[1m]` long-context variant's rates, including the `longContext`
//     premium block (#4087). ABSENT emits no `<fullId>[1m]` pricing key. Kept a
//     sibling of `pricing` so a [1m] form can carry distinct base rates.
//
// Cache-write rates are the 5-minute ephemeral tier (the default; chroxy
// doesn't opt into the pricier 1-hour tier). Source: Anthropic public pricing
// page — keep rates in sync on every model change; wrong numbers mislead
// cumulative-cost displays (#4054). The models.test.js snapshot pins the
// derived tables to literals, so any rate drift OR derivation regression fails
// loudly.
const MODEL_METADATA = Object.freeze([
  Object.freeze({
    shortId: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6',
    pricing: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  }),
  Object.freeze({
    shortId: 'opus', label: 'Opus', fullId: 'claude-opus-4-8',
    pricing: { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
    // #4087 — long-context (>200K input) premium tier. Below the 200K
    // threshold the rates match the base entry; above it the published premium
    // is a uniform 2× across all four rates. Today only Opus 4.x has a 1M
    // variant in chroxy's set (resolveClaudeContextWindow). Verify against the
    // Anthropic pricing page on the next periodic check.
    oneM: {
      input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75,
      longContext: {
        thresholdInputTokens: 200_000,
        input: 30.00, output: 150.00, cacheRead: 3.00, cacheWrite: 37.50,
      },
    },
  }),
  // #6219 — Fable (claude-fable-5) is disallowed for chroxy and removed from the
  // roster. It is also filtered out of any SDK-returned list (DISALLOWED_MODEL_IDS
  // in models.js) so it can't reappear in SDK/TUI modes, not just the CLI fallback.
  Object.freeze({
    shortId: 'haiku', label: 'Haiku', fullId: 'claude-haiku-4-5',
    pricing: { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  }),
])

// Freeze a pricing block (incl. the nested longContext premium) IN PLACE so the
// derived CLAUDE_PRICING_USD_PER_MTOK keeps the deep-frozen contract callers
// relied on when the rates were hand-authored as Object.freeze literals. The
// derived table deliberately shares object identity with its MODEL_METADATA
// source row (both are frozen + read-only) — do NOT defensively deep-clone here,
// that would just reintroduce the two-copies-can-drift problem this consolidation
// removes.
function deepFreezePricing(rates) {
  if (rates && typeof rates === 'object') {
    for (const v of Object.values(rates)) {
      if (v && typeof v === 'object') Object.freeze(v)
    }
    Object.freeze(rates)
  }
  return rates
}

// Minimal fallback used only when the SDK has never responded and no disk cache
// exists. Derived from MODEL_METADATA (source order preserved). Deep-frozen so
// callers of getModels() can't mutate the module-level constant via the
// returned array reference.
//
// Re-exported by models.js under the original name `FALLBACK_MODELS`.
export const CLAUDE_FALLBACK_MODELS = Object.freeze(
  MODEL_METADATA.map((m) => Object.freeze({
    id: m.shortId,
    label: m.label,
    fullId: m.fullId,
    contextWindow: m.contextWindow ?? resolveClaudeContextWindow(m.fullId),
  })),
)

// Public Anthropic pricing in USD per million tokens, derived from
// MODEL_METADATA: each row's `pricing` becomes the base `<fullId>` entry and
// each `oneM` becomes the `<fullId>[1m]` long-context entry (#4087).
// `computePromptCostUsd` selects between base and longContext rates based on
// the turn's total input tokens.
export const CLAUDE_PRICING_USD_PER_MTOK = Object.freeze(
  MODEL_METADATA.reduce((table, m) => {
    if (m.pricing) table[m.fullId] = deepFreezePricing(m.pricing)
    if (m.oneM) table[`${m.fullId}${ONE_M_SUFFIX}`] = deepFreezePricing(m.oneM)
    return table
  }, {}),
)

// Short-id → fullId so callers can pass either form. The fallback set is
// the canonical mapping; new short aliases get picked up automatically.
//
// `[1m]` long-context variant (#4087): try the model id verbatim FIRST
// so an explicit `claude-opus-4-7[1m]` entry — with its longContext
// premium block — wins over the suffix-stripped fallback.
//
// Also normalises dated full IDs back to the family head: the Anthropic
// SDK's `Model` enum returns forms like `claude-opus-4-7-20251201`, which
// users may pin for reproducibility (#4084). The pricing table is keyed
// on family heads (`claude-opus-4-7`), so a regex strip of the trailing
// 8+-digit date suffix lets the lookup succeed for either form.
//
// [1m] re-attach after fallback (#4105 + #4107): when the input ended
// with `[1m]` and a non-verbatim match resolves to a family head, try
// `${head}[1m]` first so the explicit premium entry wins over the base.
// Otherwise short-form `opus[1m]` and dated-form `*-YYYYMMDD[1m]` would
// silently route to base rates and undercount >200K turns.
export function resolvePricingKey(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return null
  if (CLAUDE_PRICING_USD_PER_MTOK[modelId]) return modelId
  const had1m = modelId.endsWith(ONE_M_SUFFIX)
  const stripped = had1m ? modelId.slice(0, -ONE_M_SUFFIX.length) : modelId
  // When the input carried [1m] AND a non-verbatim resolution lands on a
  // family head with an explicit [1m] entry, prefer the [1m] entry so the
  // longContext premium block is reachable.
  const preferOneM = (key) => {
    if (had1m) {
      const oneMKey = `${key}${ONE_M_SUFFIX}`
      if (CLAUDE_PRICING_USD_PER_MTOK[oneMKey]) return oneMKey
    }
    return key
  }
  if (CLAUDE_PRICING_USD_PER_MTOK[stripped]) return preferOneM(stripped)
  // Dated full id? Strip the 8-digit date suffix and retry against the
  // pricing table. The strip applies unconditionally; safety comes from
  // the table itself — only `claude-*` keys exist, so a short-form like
  // `opus-4-7-20251201` strips to `opus-4-7`, misses the table, and
  // falls through to the CLAUDE_FALLBACK_MODELS short-id lookup (which expects
  // the un-stripped id).
  const dateStripped = stripped.replace(/-\d{8,}$/, '')
  if (CLAUDE_PRICING_USD_PER_MTOK[dateStripped]) return preferOneM(dateStripped)
  const fallback = CLAUDE_FALLBACK_MODELS.find((m) => m.id === stripped)
  return fallback ? preferOneM(fallback.fullId) : null
}

/**
 * Claude-style model metadata: strip the `claude-` prefix for the short id,
 * reuse the shared context-window heuristic. The single source of truth for
 * every Claude provider class's `static getModelMetadata()` — these were
 * byte-identical copies across SdkSession / CliSession / ClaudeTuiSession /
 * ClaudeChannelSession / ClaudeByokSession before #6201 consolidated them here.
 *
 * Called with the full model id as returned by the SDK (e.g. 'claude-sonnet-4-6').
 * Short alias resolution is intentionally left to the caller — the registry
 * always has the fullId available.
 *
 * @param {string} modelId - Full model id (e.g. 'claude-sonnet-4-6').
 * @returns {{id:string,label:string,fullId:string,contextWindow:number,description:string}|null}
 */
export function claudeModelMetadata(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return null
  const fullId = modelId
  const id = claudeDeriveId(fullId)
  return {
    id,
    label: id,
    fullId,
    contextWindow: resolveClaudeContextWindow(fullId),
    description: '',
  }
}
