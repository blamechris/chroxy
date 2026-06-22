import { readFileSync, mkdirSync, watch as fsWatch } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'

const log = createLogger('models')

/** Default context window for unknown models */
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
// data tables below — FALLBACK_MODELS (cold-start / SDK-merge seed) and
// CLAUDE_PRICING_USD_PER_MTOK (per-fullId billing rates) — are DERIVED from
// this array, so adding a model is a single-row edit instead of edits in
// several hand-synced places. The regex/string heuristics
// (resolveClaudeContextWindow, humanizeModelId) intentionally stay separate:
// they are the graceful-degradation path for models NOT in this table.
//
// Per-row fields:
//   shortId, label, fullId — the FALLBACK_MODELS triple. The fullIds are
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
//     byte-identical to the prior FALLBACK_MODELS literals.
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
  // below) so it can't reappear in SDK/TUI modes, not just the CLI fallback.
  Object.freeze({
    shortId: 'haiku', label: 'Haiku', fullId: 'claude-haiku-4-5',
    pricing: { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  }),
])

// #6219 — fullIds chroxy disallows regardless of source: the CLI fallback (gone
// already, removed from MODEL_METADATA), the Agent SDK's supportedModels() push,
// the disk cache, AND a user models-overlay.json. Fable (claude-fable-5) is
// currently the only one. Keyed on the FULL id (not the short `fable` alias) so
// the precise disallowed model is dropped without false-positiving an unrelated
// overlay/SDK entry that merely uses `fable` as a short label. The short alias
// can't resurface anyway — it only ever resolved to claude-fable-5, now removed.
// The `[1m]` variant is also matched. Exported for tests + future enforcement.
export const DISALLOWED_MODEL_IDS = Object.freeze(new Set(['claude-fable-5']))

/** True when a model id (with or without a trailing `[1m]`) is a disallowed fullId. */
export function isDisallowedModelId(id) {
  if (typeof id !== 'string') return false
  const base = id.endsWith('[1m]') ? id.slice(0, -'[1m]'.length) : id
  return DISALLOWED_MODEL_IDS.has(base)
}

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
export const FALLBACK_MODELS = Object.freeze(
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
const CLAUDE_PRICING_USD_PER_MTOK = Object.freeze(
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
function resolvePricingKey(modelId) {
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
  // falls through to the FALLBACK_MODELS short-id lookup (which expects
  // the un-stripped id).
  const dateStripped = stripped.replace(/-\d{8,}$/, '')
  if (CLAUDE_PRICING_USD_PER_MTOK[dateStripped]) return preferOneM(dateStripped)
  const fallback = FALLBACK_MODELS.find((m) => m.id === stripped)
  return fallback ? preferOneM(fallback.fullId) : null
}

/**
 * Returns the pricing rates for a model (USD per million tokens), or null
 * if pricing is unknown. Callers that can't compute cost should still
 * function — emit `cost: 0` and log a warn so the gap is visible without
 * blocking the turn.
 *
 * Accepts short ids ('sonnet'), full ids ('claude-sonnet-4-6'), and the
 * `[1m]` long-context suffix. The returned entry's top-level rates are
 * the base (≤200K input) tier. `[1m]` variants additionally carry a
 * `longContext` block with premium rates that `computePromptCostUsd`
 * selects when the turn's total input exceeds the threshold (#4087).
 * The selection happens inside computePromptCostUsd — callers should
 * pass usage to that helper rather than reaching into `.longContext`
 * directly.
 */
export function getModelPricing(modelId) {
  return resolveModelPricing(modelId, defaultOverlay)
}

/**
 * Resolve pricing for a model id with an optional overlay consulted first.
 * Precedence: overlay pricing (matched on the resolved full id) > static
 * CLAUDE_PRICING_USD_PER_MTOK > null. A missing overlay pricing block does
 * NOT shadow the static table (we only short-circuit when the overlay
 * actually carries a `pricing` object), and an absent match everywhere
 * yields null — never 0.
 *
 * @param {string} modelId
 * @param {Map} [overlay] - fullId → overlay entry map (see loadModelsOverlay)
 * @returns {object|null}
 */
function resolveModelPricing(modelId, overlay) {
  if (overlay && overlay.size > 0 && typeof modelId === 'string' && modelId.length > 0) {
    // Try the id verbatim, then the registry-resolved full id, against the
    // overlay's fullId-keyed map. Short ids ('opus') resolve via the default
    // registry so an operator can key the overlay on either form.
    const candidates = new Set([modelId])
    const resolvedFull = defaultRegistry.resolveModelId(modelId)
    if (typeof resolvedFull === 'string' && resolvedFull.length > 0) candidates.add(resolvedFull)
    for (const candidate of candidates) {
      const entry = overlay.get(candidate)
      if (entry && entry.pricing) return entry.pricing
    }
  }
  const key = resolvePricingKey(modelId)
  // Coalesce a resolved-but-absent key (e.g. a short alias that resolves to a
  // full id with no pricing row because we don't ship unverified pricing) to null, not
  // undefined, so the documented "rates or null" contract holds and callers
  // that branch on `=== null` work.
  return (key && CLAUDE_PRICING_USD_PER_MTOK[key]) || null
}

// Public DeepSeek pricing in USD per million tokens (#4656). Source:
// https://api-docs.deepseek.com/quick_start/pricing — keep in sync.
// DeepSeek bills cache hits separately from cache misses but does NOT
// charge a separate cache-write fee, so `cacheWrite` is 0; the field is
// kept so the same `computePromptCostUsd` helper consumes both tables
// without a shape branch.
//
// DeepSeek hits chroxy through their Anthropic-compatible endpoint
// (https://api.deepseek.com/anthropic), so usage objects arrive in the
// Anthropic shape (`input_tokens` / `output_tokens` /
// `cache_read_input_tokens` / `cache_creation_input_tokens`). DeepSeek's
// own docs note that they map their internal cache-hit metric onto the
// Anthropic `cache_read_input_tokens` slot, and they never report cache
// writes — so the zero rate is correct, not a placeholder.
const DEEPSEEK_PRICING_USD_PER_MTOK = Object.freeze({
  // V3 chat — general-purpose model.
  'deepseek-chat':     Object.freeze({ input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0 }),
  // R1 reasoning — emits a reasoning trace before the final answer.
  'deepseek-reasoner': Object.freeze({ input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 }),
})

/**
 * Returns the DeepSeek pricing rates for a model (USD per million tokens),
 * or null if pricing is unknown (#4656).
 *
 * Verbatim-only lookup. DeepSeek doesn't ship date-suffixed model ids the
 * way Anthropic does, so the strip-and-retry dance from `resolvePricingKey`
 * isn't warranted here. If they ever do, extend along the same shape.
 */
export function getDeepSeekPricing(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return null
  return DEEPSEEK_PRICING_USD_PER_MTOK[modelId] || null
}

/**
 * Compute USD cost for a single turn's usage object as returned by the
 * Anthropic SDK (`{ input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens }`).
 *
 * Returns `null` — NOT 0 — when pricing is unknown OR usage is missing OR the
 * computed cost isn't finite (#5630). A `null` means "cost unknown", which is
 * semantically distinct from a genuine `$0.00` turn — it lets the per-turn
 * wire `cost` carry an honest "unknown" instead of a misleading `0`. Callers
 * that accumulate a turn total MUST skip a `null` (it is not addable) — see
 * byok-session.js's `turnCostKnown` guard. Never throws, never returns NaN.
 * Cache-read tokens are NOT also billed at the input rate; the SDK already
 * excludes them from `input_tokens`.
 *
 * #4087 — long-context premium: when the pricing entry has a
 * `longContext` block AND the turn's total input (input + cache reads +
 * cache writes) exceeds the threshold, ALL tokens in the turn are
 * charged at the premium rate. The threshold-crossing applies to the
 * whole turn, not just over-threshold tokens — matches Anthropic's
 * public pricing-table format.
 *
 * @returns {number|null} Finite USD cost, or `null` when cost is unknown.
 */
export function computePromptCostUsd(usage, pricing) {
  if (!pricing || !usage) return null
  const inputTokens = Number(usage.input_tokens) || 0
  const outputTokens = Number(usage.output_tokens) || 0
  const cacheReadTokens = Number(usage.cache_read_input_tokens) || 0
  const cacheWriteTokens = Number(usage.cache_creation_input_tokens) || 0
  // Select base or long-context rates. Only `[1m]`-variant entries carry
  // a `longContext` block, so default-window models always use the
  // top-level rates.
  let rates = pricing
  if (pricing.longContext) {
    const totalInput = inputTokens + cacheReadTokens + cacheWriteTokens
    if (totalInput > pricing.longContext.thresholdInputTokens) {
      rates = pricing.longContext
    }
  }
  const cost =
      inputTokens      * rates.input      / 1_000_000
    + outputTokens     * rates.output     / 1_000_000
    + cacheReadTokens  * rates.cacheRead  / 1_000_000
    + cacheWriteTokens * rates.cacheWrite / 1_000_000
  return Number.isFinite(cost) ? cost : null
}

function getDefaultCachePath() {
  const configDir = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
  return join(configDir, 'models-cache.json')
}

/**
 * User-extensible overlay path. Mirrors getDefaultCachePath's config-dir
 * resolution EXACTLY (CHROXY_CONFIG_DIR || ~/.chroxy) so the overlay file
 * lives next to the cache. The overlay lets operators surface a brand-new
 * model id, override a label/contextWindow, or supply pricing for a model
 * the static table doesn't carry — all without a code change.
 */
function getDefaultOverlayPath() {
  const configDir = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
  return join(configDir, 'models.json')
}

/**
 * Load and normalise the user overlay from disk (boot-only — not hot-reload;
 * that's a deferred follow-up). The file is an object keyed by full model id:
 *
 *   {
 *     "claude-fable-5": {
 *       "shortId": "fable",            // optional
 *       "label": "Fable",              // optional
 *       "fullId": "claude-fable-5",    // optional (defaults to the key)
 *       "contextWindow": 200000,       // optional
 *       "pricing": {                   // optional
 *         "input": 10, "output": 50, "cacheRead": 1, "cacheWrite": 12.5
 *       }
 *     }
 *   }
 *
 * Parses defensively: a missing file yields an empty overlay; malformed JSON
 * (or a non-object root) logs a warn and yields an empty overlay. NEVER throws
 * on boot. Returns a Map keyed by fullId for O(1) lookup; each value carries a
 * normalised `{ fullId, shortId, label, contextWindow, pricing }` where any
 * absent field is left undefined (NOT defaulted to 0/null) so downstream
 * precedence can distinguish "overlay said nothing" from "overlay said X".
 *
 * @param {string} [path]
 * @returns {Map<string, {fullId:string, shortId?:string, label?:string, contextWindow?:number, pricing?:object}>}
 */
/**
 * #5932 — load the overlay with an explicit MALFORMED-vs-EMPTY signal so a
 * hot-reload can keep the last-good set when the file becomes malformed
 * (rather than silently dropping every overlaid model). Returns
 * `{ ok, overlay }`:
 *   - absent file        → `{ ok: true,  overlay: <empty> }` (legit "no overrides";
 *     a reload of an absent/deleted file CLEARS the overlay — an explicit
 *     operator action, distinct from a parse failure)
 *   - malformed JSON      → `{ ok: false, overlay: <empty> }`  (keep last-good on reload)
 *   - non-object JSON root → `{ ok: false, overlay: <empty> }`
 *   - valid object        → `{ ok: true,  overlay: <normalised> }`
 *
 * NEVER throws. The boot-time {@link loadModelsOverlay} wraps this and returns
 * just the overlay (treating malformed as empty, exactly as before).
 *
 * @param {string} [path]
 * @returns {{ ok: boolean, overlay: Map<string, object> }}
 */
function loadModelsOverlayResult(path = getDefaultOverlayPath()) {
  const overlay = new Map()
  let raw
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    // A genuinely-absent file (ENOENT) is the common case AND a legitimate
    // operator action — empty overlay, `ok: true` so a reload of a deleted file
    // clears the overlay (no log; absence is normal). Any OTHER read error
    // (EACCES, EBUSY, EISDIR, transient IO) is NOT an intentional clear — return
    // `ok: false` + warn so a hot-reload keeps the LAST-GOOD set instead of
    // silently wiping the operator's overlay on a transient fault (Copilot #5945).
    if (err?.code === 'ENOENT') return { ok: true, overlay }
    log.warn(`loadModelsOverlay: cannot read ${path}: ${err?.code || ''} ${err?.message || err} — keeping last-good overlay`.replace(/\s+/g, ' ').trim())
    return { ok: false, overlay }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.warn(`loadModelsOverlay: malformed JSON in ${path}: ${err?.message || err} — ignoring overlay`)
    return { ok: false, overlay }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn(`loadModelsOverlay: ${path} is not a JSON object keyed by model id — ignoring overlay`)
    return { ok: false, overlay }
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const fullId = typeof value.fullId === 'string' && value.fullId.length > 0 ? value.fullId : key
    const entry = { fullId }
    if (typeof value.shortId === 'string' && value.shortId.length > 0) entry.shortId = value.shortId
    if (typeof value.label === 'string' && value.label.length > 0) entry.label = value.label
    if (typeof value.contextWindow === 'number' && value.contextWindow > 0) entry.contextWindow = value.contextWindow
    if (value.pricing && typeof value.pricing === 'object' && !Array.isArray(value.pricing)) {
      entry.pricing = value.pricing
    }
    overlay.set(fullId, entry)
  }
  return { ok: true, overlay }
}

function loadModelsOverlay(path = getDefaultOverlayPath()) {
  return loadModelsOverlayResult(path).overlay
}

// Module-level overlay, loaded at boot and HOT-RELOADABLE (#5932). The default
// Claude registry and the module-level getModelPricing() consult this; both
// read it dynamically (getModelPricing at call time; the registry via
// applyOverlay), so reassigning it in reloadModelsOverlay() takes effect without
// a restart. Per-provider registries take their own overlay via the
// createModelsRegistry hook.
let defaultOverlay = loadModelsOverlay()

/**
 * Per-provider cache path resolver (#4413). Non-Claude providers
 * (codex, gemini, …) persist learned context-window ratchets to their own
 * disk file so a server restart doesn't lose state and the default Claude
 * cache (`models-cache.json`) stays untouched.
 *
 * The provider name is sanitised to a filename-safe slug so an unexpected
 * `providerName` value can't escape the config dir via path metacharacters.
 *
 * @param {string} providerName
 * @returns {string}
 */
function getProviderCachePath(providerName) {
  const configDir = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
  const safe = String(providerName).replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(configDir, `models-cache.${safe}.json`)
}

/**
 * Canonical JSON stringifier — sorts object keys recursively so equivalent
 * data produces an identical string regardless of construction order.
 *
 * Used by the registry's snapshotString() to dedupe saveCache() writes. The
 * JS spec guarantees insertion-order key iteration, but relying on that to
 * compare payloads is fragile: any future refactor that builds model objects
 * via `{...m, contextWindow}` spreads or object-rest patterns could silently
 * shuffle keys and defeat the snapshot equality check. Sorting keys makes
 * the snapshot invariant to construction order.
 *
 * Semantics match `JSON.stringify` for the cases that matter:
 *   - undefined / function / symbol values: dropped from objects,
 *     coerced to null inside arrays (same as JSON.stringify)
 *   - sparse array holes: serialized as null (same as JSON.stringify)
 *   - `toJSON()`: honored on any object that defines it
 *   - circular structures: throw (same as JSON.stringify)
 *
 * Implementation: normalize to a key-sorted plain-object/array tree first,
 * then hand to `JSON.stringify`. This avoids emitting invalid JSON like
 * `{"k":undefined}` while still guaranteeing canonical ordering.
 *
 * Exported for tests.
 */
export function canonicalStringify(value) {
  const seen = new Set()

  function normalize(current, key, inArray) {
    if (current && typeof current === 'object' && typeof current.toJSON === 'function') {
      current = current.toJSON(key)
    }
    if (current === undefined || typeof current === 'function' || typeof current === 'symbol') {
      return inArray ? null : undefined
    }
    if (!current || typeof current !== 'object') {
      return current
    }
    if (seen.has(current)) {
      throw new TypeError('Converting circular structure to JSON')
    }
    seen.add(current)
    try {
      if (Array.isArray(current)) {
        const out = new Array(current.length)
        for (let i = 0; i < current.length; i += 1) {
          out[i] = normalize(current[i], String(i), true)
        }
        return out
      }
      const out = {}
      const keys = Object.keys(current).sort()
      for (const childKey of keys) {
        const childValue = normalize(current[childKey], childKey, false)
        if (childValue !== undefined) {
          out[childKey] = childValue
        }
      }
      return out
    } finally {
      seen.delete(current)
    }
  }

  return JSON.stringify(normalize(value, '', false))
}

/**
 * Decompose a Claude model fullId into its `family` (e.g. `claude-opus-4`)
 * and optional numeric `minor` (e.g. `7` for `claude-opus-4-7`). Used by
 * `loadCache()` to detect retired model versions in the disk cache (#3162):
 *
 *   `claude-opus-4-7`            → { family: 'claude-opus-4', minor: 7 }
 *   `claude-opus-4-7[1m]`        → { family: 'claude-opus-4', minor: 7 }
 *   `claude-opus-4-7-20251201`   → { family: 'claude-opus-4', minor: 7 }
 *   `claude-sonnet-4-20250514`   → { family: 'claude-sonnet-4', minor: null }
 *   `claude-sonnet-4-6`          → { family: 'claude-sonnet-4', minor: 6 }
 *
 * `loadCache()` keeps cached entries whose family is present in
 * `FALLBACK_MODELS` and (when minor is known) whose minor matches a fallback
 * minor for the same family. SDK-reported dated ids like
 * `claude-sonnet-4-20250514` carry no minor and pass through on family
 * match — the API still accepts them. Family/major-only retirement (e.g.
 * sonnet 3 family removed entirely) is caught by the family-not-in-fallback
 * branch.
 */
function modelFamilyAndMinor(fullId) {
  if (typeof fullId !== 'string') return { family: '', minor: null }
  let stripped = fullId.endsWith(ONE_M_SUFFIX) ? fullId.slice(0, -ONE_M_SUFFIX.length) : fullId
  stripped = stripped.replace(/-\d{8,}$/, '')
  const m = stripped.match(/^(claude-[a-z]+-\d+)(?:-(\d+))?$/)
  if (m) {
    return { family: m[1], minor: m[2] ? parseInt(m[2], 10) : null }
  }
  return { family: stripped, minor: null }
}

/**
 * Derive a human-readable label from a stripped model ID.
 * E.g. "opus-4-5-20251101" → "Opus 4.5", "sonnet-4-20250514" → "Sonnet 4",
 * "opus-4-7[1m]" → "Opus 4.7 (1M)"
 */
function humanizeModelId(id) {
  const oneM = id.endsWith(ONE_M_SUFFIX)
  let clean = oneM ? id.slice(0, -ONE_M_SUFFIX.length) : id
  clean = clean.replace(/-\d{8,}$/, '')
  const parts = clean.split('-')
  if (parts.length === 0) return id
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  const version = parts.slice(1).join('.')
  const base = version ? `${family} ${version}` : family
  return oneM ? `${base} (1M)` : base
}

/**
 * Factory function that creates an isolated models registry.
 * Each instance has its own mutable state, preventing test pollution.
 *
 * Accepts optional provider-specific hooks so non-Claude providers (Codex,
 * Gemini, …) can drive their own fallback list, ID derivation and context-
 * window heuristic without the registry hard-coding Claude conventions. When
 * no hooks are supplied the registry defaults to the Claude behaviour so all
 * existing callers (sdk-session, server-cli, test suites) keep working.
 *
 * @param {Object} [hooks]
 * @param {ReadonlyArray<Object>} [hooks.fallbackModels] - Provider's minimal
 *   fallback list. Defaults to Claude's `FALLBACK_MODELS`.
 * @param {(fullId:string) => string} [hooks.deriveId] - Maps an SDK `fullId`
 *   to the registry's short id. Defaults to Claude's `claude-` strip.
 * @param {(fullId:string) => number} [hooks.resolveContextWindow] -
 *   Heuristic context-window resolver. Defaults to the Claude one.
 * @param {(fullId:string) => (Object|null)} [hooks.getModelMetadata] -
 *   Optional provider lookup that can return `{id,label,fullId,contextWindow}`
 *   for a known model fullId. When present it is consulted first during
 *   `updateModels()` to reuse provider-authoritative metadata.
 * @param {() => string} [hooks.cachePath] - Resolver for the disk cache path
 *   used by `loadCache()` / `saveCache()` when no explicit path is passed.
 *   Lazy so the path is re-read from `CHROXY_CONFIG_DIR` after env edits in
 *   tests. Defaults to the shared Claude cache at
 *   `~/.chroxy/models-cache.json`. Non-Claude providers should supply a
 *   provider-scoped path (e.g. `~/.chroxy/models-cache.codex.json`) so the
 *   default Claude cache stays untouched by per-provider learn-loops (#4413).
 * @param {Map} [hooks.overlay] - User-extensible overlay (fullId → entry; see
 *   loadModelsOverlay). Overlay entries SEED the registry like a
 *   FALLBACK_MODELS row, so a brand-new model id appears with no code change
 *   and survives loadCache()'s family prune. The default Claude registry gets
 *   the module-level `defaultOverlay`; pass `new Map()` to opt out.
 */
export function createModelsRegistry(hooks = {}) {
  const baseFallbackModels = hooks.fallbackModels ?? FALLBACK_MODELS
  const deriveIdFn = typeof hooks.deriveId === 'function' ? hooks.deriveId : claudeDeriveId
  const resolveContextWindowFn = typeof hooks.resolveContextWindow === 'function'
    ? hooks.resolveContextWindow
    : resolveClaudeContextWindow
  const cachePathFn = typeof hooks.cachePath === 'function' ? hooks.cachePath : getDefaultCachePath
  const getModelMetadataFn = typeof hooks.getModelMetadata === 'function' ? hooks.getModelMetadata : null
  const overlay = hooks.overlay instanceof Map ? hooks.overlay : new Map()

  // Fold overlay entries into the fallback set. An overlay entry for a fullId
  // NOT already in the base fallbacks seeds the registry exactly like a
  // FALLBACK_MODELS row would — so it appears in getModels(), resolves both
  // ways, lands in the allowlist, and is unioned into the loadCache prune
  // allowlist (its family survives boot). For an id already present in the
  // base fallbacks, the overlay's label/contextWindow override the static
  // heuristic (overlay > heuristic). Pricing is handled separately by
  // resolveModelPricing. SDK live values still win over both at
  // updateModels() time (the contextWindowOverrides / providerMeta lookups
  // are consulted ahead of the fallback row's contextWindow).
  //
  // #5932 — extracted so applyOverlay() can RE-fold a hot-reloaded overlay
  // without rebuilding the whole registry (which would discard SDK-learned
  // models + contextWindow overrides).
  function computeFallbackModels(overlayMap) {
    const overlayRows = []
    const overriddenBase = []
    const baseByFullId = new Map(baseFallbackModels.map((m) => [m.fullId, m]))
    for (const entry of overlayMap.values()) {
      // #6219 — an overlay must not reintroduce a disallowed model (e.g. fable).
      if (isDisallowedModelId(entry.shortId) || isDisallowedModelId(entry.fullId)) continue
      const baseRow = baseByFullId.get(entry.fullId)
      if (baseRow) {
        // Override the base row's label/window from the overlay when supplied.
        if (entry.label !== undefined || entry.contextWindow !== undefined || entry.shortId !== undefined) {
          baseByFullId.set(entry.fullId, Object.freeze({
            id: entry.shortId ?? baseRow.id,
            label: entry.label ?? baseRow.label,
            fullId: baseRow.fullId,
            contextWindow: entry.contextWindow ?? baseRow.contextWindow,
          }))
        }
        continue
      }
      const shortId = entry.shortId ?? deriveIdFn(entry.fullId)
      overlayRows.push(Object.freeze({
        id: shortId,
        label: entry.label ?? humanizeModelId(shortId),
        fullId: entry.fullId,
        contextWindow: entry.contextWindow ?? resolveContextWindowFn(entry.fullId),
      }))
    }
    // Preserve base order, then append overlay-only rows.
    for (const m of baseFallbackModels) overriddenBase.push(baseByFullId.get(m.fullId))
    return overlayRows.length > 0 || overriddenBase.some((m, i) => m !== baseFallbackModels[i])
      ? Object.freeze([...overriddenBase, ...overlayRows])
      : baseFallbackModels
  }

  // #5932: `let` (was const) so applyOverlay() can swap in a re-folded set.
  let fallbackModels = computeFallbackModels(overlay)

  let activeModels = fallbackModels
  let defaultModelId = null
  let allowedModelIds = new Set()
  let toFullIdMap = new Map()
  let toShortIdMap = new Map()
  // #5932: the last SDK model list applied via updateModels(), retained so
  // applyOverlay() can RE-merge a hot-reloaded overlay with the live SDK data
  // (AC2) instead of reverting to the bare fallback view. Null until the first
  // SDK refresh (CLI-only / pre-init).
  let lastSdkModels = null
  // #5932 (PR #5945 review): the last list applied via loadCache(), retained so
  // an overlay reload in the CLI-only window (cache warmed, no SDK refresh yet)
  // preserves cache-warmed entries the new fallback doesn't cover (date-suffixed
  // ids past the family filter) — WITHOUT resurrecting overlay-only rows the
  // operator removed (those only ever live in fallbackModels, never here).
  let lastCacheModels = null
  // Snapshot of the last saved cache payload so saveCache() can skip
  // redundant writes. `null` forces the first save to always run.
  let lastSavedSnapshot = null
  // Authoritative contextWindow values observed from SDK `modelUsage`,
  // keyed by fullId. These override the static resolveContextWindow()
  // heuristic and must survive subsequent updateModels() refreshes
  // (which otherwise rebuild every entry from the heuristic on every
  // SDK session init). Cleared on resetModels().
  const contextWindowOverrides = new Map()

  // #4106: warn-once set for synthesized 1M variants that lack a matching
  // pricing entry. updateModels() can be called repeatedly across the
  // server lifetime (every SDK session init); without this guard, an
  // operator running with a new model family would see the same warn line
  // for every session. Cleared on resetModels().
  const pricingDriftWarned = new Set()

  // Seed lookups with FALLBACK_MODELS aliases so legacy short ids
  // (`sonnet`/`opus`/`haiku`) remain valid even after the SDK returns a
  // dynamic list whose derived short ids look different
  // (e.g. `sonnet-4-6`). Dynamic entries override on collision.
  function rebuildLookups(models) {
    allowedModelIds = new Set()
    toFullIdMap = new Map()
    toShortIdMap = new Map()

    const seed = (list) => {
      for (const m of list) {
        allowedModelIds.add(m.id)
        allowedModelIds.add(m.fullId)
        toFullIdMap.set(m.id, m.fullId)
        toFullIdMap.set(m.fullId, m.fullId)
        toShortIdMap.set(m.fullId, m.id)
        toShortIdMap.set(m.id, m.id)
      }
    }

    seed(fallbackModels)
    if (models !== fallbackModels) seed(models)
  }

  function applyModels(models, nextDefault) {
    // #6219 — strip disallowed models (fable) from ANY source funnelled through
    // here (SDK updateModels(), disk loadCache()), so they can't appear in
    // SDK/TUI modes. Skip the allocation when nothing is disallowed (the common
    // case). The CLI fallback is already clean (removed from MODEL_METADATA).
    const filtered = models.some((m) => isDisallowedModelId(m.id) || isDisallowedModelId(m.fullId))
      ? models.filter((m) => !isDisallowedModelId(m.id) && !isDisallowedModelId(m.fullId))
      : models
    activeModels = filtered
    defaultModelId = nextDefault
    rebuildLookups(filtered)
  }

  function snapshotString() {
    return canonicalStringify({ models: activeModels, defaultModelId })
  }

  // Hoisted out of the returned method so loadCache() can heal the disk
  // file in the same pass when stale entries are pruned (#3162).
  function saveCacheImpl(path) {
    const snapshot = snapshotString()
    if (snapshot === lastSavedSnapshot) return true

    try {
      mkdirSync(dirname(path), { recursive: true })
      // Pass a per-pid `tmpSuffix` so two concurrent processes
      // (test runner + main daemon, or two test workers) writing the
      // same cache do not race on the same intermediate `.tmp` file
      // (#4874). The suffix is honoured on both POSIX and Windows since
      // #4913 — writeFileRestricted now uses the same temp+rename
      // pattern on both platforms, so the per-pid hint protects every
      // host. writeFileRestricted handles atomic rename + cleanup
      // internally; no manual rename/unlink wrapper is needed here.
      writeFileRestricted(path, JSON.stringify({
        models: activeModels,
        defaultModelId,
        savedAt: Date.now(),
      }, null, 2), { tmpSuffix: `.tmp-${process.pid}` })
      lastSavedSnapshot = snapshot
      return true
    } catch (err) {
      // Persisting the cache failed (permission denied, disk full, read-only
      // parent). The in-memory list stays live for this process, but will be
      // lost on restart — surface at warn level so operators can diagnose
      // from ~/.chroxy/logs/chroxy.log.
      log.warn(`saveCache: failed to persist models cache to ${path}: ${err?.code || ''} ${err?.message || err}`.trim())
      return false
    }
  }

  rebuildLookups(fallbackModels)

  // #5932: captured in a const so applyOverlay() can re-run the full
  // updateModels() pipeline against a re-folded fallback set. Methods reference
  // `registry` only at call time (by which point it's assigned), so there is no
  // temporal-dead-zone hazard.
  const registry = {
    getModels() {
      return activeModels
    },

    /**
     * #5932 — apply a hot-reloaded overlay WITHOUT rebuilding the registry
     * (which would discard SDK-learned models + contextWindow overrides). Re-fold
     * the new overlay into the fallback set, then:
     *   - if SDK data was applied (lastSdkModels) → re-run updateModels() so the
     *     overlay (overlay-only rows + label/window overrides) re-merges with the
     *     live SDK list exactly as it did originally (AC2);
     *   - otherwise (CLI-only / pre-init) → the re-folded fallback IS the active
     *     list; re-apply it and rebuild lookups, preserving the current default.
     * Returns the new active model list.
     */
    applyOverlay(newOverlay) {
      const map = newOverlay instanceof Map ? newOverlay : new Map()
      fallbackModels = computeFallbackModels(map)
      if (lastSdkModels) {
        registry.updateModels(lastSdkModels)
      } else if (lastCacheModels) {
        // Cache-warmed (loadCache) but no SDK refresh yet — apply the new
        // fallback (base + overlay overrides + overlay-only rows) while
        // PRESERVING the cache entries it doesn't cover (date-suffixed ids past
        // the family filter, e.g. `claude-sonnet-4-20250514`). Preserve from the
        // CACHE list, not `activeModels`, so an overlay-only row the operator
        // REMOVED still drops (it lives in fallbackModels, never lastCacheModels)
        // — matched on fullId so an overlay override of a cached/fallback row
        // still wins (it's in fallbackModels → the cache copy is skipped).
        const byFullId = new Set(fallbackModels.map((m) => m.fullId))
        const preserved = lastCacheModels.filter((m) => !byFullId.has(m.fullId))
        const next = preserved.length > 0 ? Object.freeze([...fallbackModels, ...preserved]) : fallbackModels
        applyModels(next, defaultModelId)
      } else {
        applyModels(fallbackModels, defaultModelId)
      }
      return activeModels
    },

    updateModels(sdkModels) {
      if (!Array.isArray(sdkModels)) {
        log.debug(`updateModels: ignoring non-array input (got ${sdkModels === null ? 'null' : typeof sdkModels})`)
        return null
      }

      let nextDefault = null
      // Track total dropped count separately from the key-sample buffer so
      // the log reports "dropped N/M" correctly when more than 3 entries
      // are invalid (the sample is capped to avoid log bloat).
      let droppedCount = 0
      const droppedSample = []
      const converted = sdkModels
        .filter(m => {
          const ok = m && typeof m.value === 'string' && m.value.length > 0
          if (!ok) {
            droppedCount++
            if (droppedSample.length < 3) droppedSample.push(m)
          }
          return ok
        })
        .map(m => {
          const fullId = m.value
          // Prefer the provider's own metadata lookup when it recognises
          // the id — that keeps the short id / label / context window in
          // sync with whatever the provider exposes via `getAllowedModels()`
          // and `getFallbackModels()`. When the provider has no entry for
          // this id (new release, custom deploy, …) fall back to the
          // registry's deriveId/resolveContextWindow hooks.
          const providerMeta = getModelMetadataFn ? getModelMetadataFn(fullId) : null
          const derivedId = providerMeta?.id ?? deriveIdFn(fullId)
          let label = m.displayName || ''
          if (typeof m.displayName === 'string' && /^default\b/i.test(m.displayName)) {
            nextDefault = derivedId
            const match = label.match(/^Default\s*\((.+)\)$/)
            if (match) label = match[1]
          }
          if (!label || /^recommended$/i.test(label)) {
            label = providerMeta?.label || humanizeModelId(derivedId)
          }
          // Prefer an authoritative value observed from SDK modelUsage
          // over the static heuristic, so a learned contextWindow isn't
          // lost when _fetchSupportedModels() fires on every init.
          const contextWindow = contextWindowOverrides.get(fullId)
            ?? providerMeta?.contextWindow
            ?? resolveContextWindowFn(fullId)
          return { id: derivedId, label, fullId, contextWindow }
        })

      if (droppedCount > 0) {
        // Contract drift: SDK returned entries whose `value` was missing,
        // non-string, or empty. Log the accurate total count, plus a
        // keys-only sample of the first N offenders — entries may carry
        // provider metadata we don't want to leak to disk logs.
        const sample = droppedSample.map(m => {
          if (m === null) return 'null'
          if (typeof m !== 'object') return typeof m
          return `{${Object.keys(m).join(',')}}`
        }).join(', ')
        log.warn(`updateModels: dropped ${droppedCount}/${sdkModels.length} SDK entries with missing or invalid 'value' key (sample: ${sample})`)
      }

      if (converted.length === 0) {
        if (sdkModels.length > 0) {
          log.warn(`updateModels: SDK returned ${sdkModels.length} entries but none matched the expected {value,displayName,description} shape — keeping existing models`)
        }
        return converted
      }

      // Merge fallback entries that the SDK omitted so the picker stays
      // useful when the CLI under-reports (#3075 — observed on Opus 4.7,
      // where supportedModels() returned only the 4.6 family). Match on
      // fullId — fallback's id is a short alias (e.g. `opus`) that would
      // otherwise collide with a derived id of the same family.
      const seenFullIds = new Set(converted.map(m => m.fullId))
      for (const fb of fallbackModels) {
        if (!seenFullIds.has(fb.fullId)) {
          // Re-derive the short id with the registry's hook so non-Claude
          // providers don't accidentally inherit Claude's `claude-` strip.
          const providerMeta = getModelMetadataFn ? getModelMetadataFn(fb.fullId) : null
          const id = providerMeta?.id ?? deriveIdFn(fb.fullId)
          const label = providerMeta?.label || humanizeModelId(id)
          const contextWindow = contextWindowOverrides.get(fb.fullId)
            ?? providerMeta?.contextWindow
            ?? fb.contextWindow
            ?? resolveContextWindowFn(fb.fullId)
          converted.push({ id, label, fullId: fb.fullId, contextWindow })
          seenFullIds.add(fb.fullId)
        }
      }

      // Synthesize 1M-context variants for any model with a >=1M context
      // window that doesn't already have an explicit `[1m]` entry. The CLI
      // accepts `claude-*[1m]` as a separate model id (verified against the
      // claude binary), so the picker should surface it as a distinct chip
      // even though `supportedModels()` doesn't list it (#3075).
      //
      // Pricing-table drift guard (#4106): the day Anthropic ships a 1M
      // variant of Sonnet/Haiku/any-future-model, `updateModels` will
      // synthesize the `[1m]` chip here, but if the pricing table at the
      // top of this file doesn't carry a matching entry with a
      // `longContext` block, `resolvePricingKey` falls back to the base
      // family entry and silently undercounts >200K turns by whatever the
      // premium ratio is. Warn-once per variant so an operator notices
      // before the bills lie. Forward-compat only — no current breakage.
      const variants = []
      for (const m of converted) {
        if (!m.fullId || m.fullId.endsWith(ONE_M_SUFFIX)) continue
        if (m.contextWindow < 1_000_000) continue
        const variantFullId = `${m.fullId}${ONE_M_SUFFIX}`
        if (seenFullIds.has(variantFullId)) continue
        const variantId = `${m.id}${ONE_M_SUFFIX}`
        // Consult the provider's metadata hook first so non-Claude registries
        // that eventually ship a >=1M model get their authoritative label
        // instead of the humanizeModelId mangling (#4441 follow-up to #4438).
        // Currently unreachable for codex/gemini (no 1M models today) but
        // keeps the synthesis path consistent with the five other call sites.
        const providerMeta = getModelMetadataFn ? getModelMetadataFn(variantFullId) : null
        variants.push({
          id: variantId,
          label: providerMeta?.label || humanizeModelId(variantId),
          fullId: variantFullId,
          contextWindow: 1_000_000,
        })
        seenFullIds.add(variantFullId)
        // Drift detection (#4106 + #4116). Two failure modes both lose
        // the premium tier in different ways:
        //   (1) No `[1m]` entry at all → resolvePricingKey may return null
        //       (cost=0) or fall back to the base family entry (no
        //       longContext block) depending on the family.
        //   (2) `[1m]` entry exists but lacks `longContext` → premium
        //       block silently absent; >200K turns billed at base rates.
        // Both produce undercounting; warn for either. Gate to `claude-*`
        // so non-Claude registries don't get a Claude-pricing nag.
        if (variantFullId.startsWith('claude-')) {
          const entry = CLAUDE_PRICING_USD_PER_MTOK[variantFullId]
          if ((!entry || !entry.longContext) && !pricingDriftWarned.has(variantFullId)) {
            const reason = entry
              ? `no longContext premium block; >200K turns will bill at base rates`
              : `no entry in CLAUDE_PRICING_USD_PER_MTOK; cost may be 0 or fall back to base`
            log.warn(`pricing-table drift: synthesized 1M variant ${variantFullId} ${reason}. Add an explicit entry (with longContext) in packages/server/src/models.js.`)
            pricingDriftWarned.add(variantFullId)
          }
        }
      }
      converted.push(...variants)

      // #5631 — robustness: the `/^default\b/i` displayName regex is the only
      // path that sets nextDefault. If the SDK ever drops or renames the
      // "Default (…)" marker, nextDefault stays null and the registry has no
      // default model at all. Pick a deterministic fallback so drift is
      // visible and the picker still has a sensible default: prefer a stable
      // family present in FALLBACK_MODELS (opus, then sonnet) — matched by the
      // fallback row's fullId so SDK-derived ids like `opus-4-8` (not the
      // short alias `opus`) still match — else the first converted entry.
      // Warn so the regex miss surfaces in logs.
      if (nextDefault === null && converted.length > 0) {
        let picked = null
        for (const preferredShortId of ['opus', 'sonnet']) {
          const fb = fallbackModels.find((m) => m.id === preferredShortId)
          if (!fb) continue
          const match = converted.find((m) => m.fullId === fb.fullId)
          if (match) { picked = match.id; break }
        }
        if (!picked) picked = converted[0].id
        nextDefault = picked
        log.warn(`updateModels: no SDK entry matched the /^default\\b/i displayName regex — falling back to '${picked}' as the default model. The SDK's "Default (…)" marker may have changed shape.`)
      }

      // #5932: remember the raw SDK list so a later overlay hot-reload can
      // re-merge against it (AC2). Store the original input, not `converted`,
      // so the re-merge re-derives ids/labels/windows from the new fallback
      // exactly as the original call did.
      lastSdkModels = sdkModels
      applyModels(converted, nextDefault)
      return converted
    },

    /**
     * Replace the contextWindow for an existing entry when the SDK reports
     * an authoritative value (via `SDKResultSuccess.modelUsage`). Matches
     * on `fullId` or short `id`. No-op if the model isn't in the registry
     * or the reported value already matches.
     */
    updateContextWindow(modelId, contextWindow) {
      if (typeof modelId !== 'string' || typeof contextWindow !== 'number' || contextWindow <= 0) {
        return false
      }
      let changed = false
      activeModels = activeModels.map(m => {
        if ((m.id === modelId || m.fullId === modelId) && m.contextWindow !== contextWindow) {
          changed = true
          // Persist the authoritative value so a later updateModels()
          // refresh doesn't revert us to the static heuristic.
          contextWindowOverrides.set(m.fullId, contextWindow)
          return { ...m, contextWindow }
        }
        return m
      })
      return changed
    },

    resetModels() {
      contextWindowOverrides.clear()
      pricingDriftWarned.clear()
      // #5932: drop the retained SDK + cache lists too, so a reset truly returns
      // to the bare fallback view (a later applyOverlay won't re-merge stale
      // SDK/cache data).
      lastSdkModels = null
      lastCacheModels = null
      applyModels(fallbackModels, null)
      lastSavedSnapshot = null
    },

    getDefaultModelId() {
      return defaultModelId
    },

    resolveModelId(model) {
      return toFullIdMap.get(model) || model
    },

    toShortModelId(model) {
      return toShortIdMap.get(model) || model
    },

    getAllowedModelIds() {
      return allowedModelIds
    },

    /**
     * Load a previously cached model list from disk. Returns true on success.
     * Silently returns false if the cache is absent, malformed, or empty.
     * Missing `label` and `contextWindow` fields are re-derived so that
     * older or hand-edited cache files don't leave the picker with empty
     * labels or a default context window.
     */
    loadCache(path = cachePathFn()) {
      try {
        const raw = readFileSync(path, 'utf-8')
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return false

        // Filter out cached entries whose family is no longer in
        // FALLBACK_MODELS, OR whose minor version was superseded (#3162).
        // FALLBACK_MODELS is version-pinned per release, so it's the
        // authoritative set of currently-supported families/minors.
        // Date-suffixed SDK ids (e.g. `claude-sonnet-4-20250514`) carry no
        // explicit minor and pass through on family match — the API still
        // accepts them. Family-only retirement (e.g. sonnet 3 dropped
        // entirely) is caught by the family-not-in-fallback branch.
        // CLI-only users never have updateModels() called, so without
        // this filter a stale cache lingers indefinitely.
        const fallbackByFamily = new Map()
        for (const fb of fallbackModels) {
          const { family, minor } = modelFamilyAndMinor(fb.fullId)
          if (!family) continue
          if (!fallbackByFamily.has(family)) fallbackByFamily.set(family, new Set())
          if (minor !== null) fallbackByFamily.get(family).add(minor)
        }

        const valid = parsed.models.filter(m =>
          m && typeof m.id === 'string' && typeof m.fullId === 'string',
        )
        const models = valid
          .filter(m => {
            const { family, minor } = modelFamilyAndMinor(m.fullId)
            if (!fallbackByFamily.has(family)) return false
            if (minor === null) return true
            return fallbackByFamily.get(family).has(minor)
          })
          .map(m => {
            // #4434: when the cached label is missing/empty (older cache
            // files, or operators hand-editing the on-disk cache that
            // landed in #4413), prefer the provider's own metadata label
            // before falling back to `humanizeModelId`. The humanize
            // helper assumes Claude-style ids ("opus-4-7" → "Opus 4.7")
            // and mangles non-Claude ids ("gpt-5-codex" → "Gpt 5.codex").
            // Mirrors the post-filter merge step below which already
            // consults `getModelMetadataFn` for the same reason.
            const providerMeta = getModelMetadataFn ? getModelMetadataFn(m.fullId) : null
            return {
              id: m.id,
              fullId: m.fullId,
              label: typeof m.label === 'string' && m.label.length > 0
                ? m.label
                : (providerMeta?.label || humanizeModelId(m.id)),
              contextWindow: typeof m.contextWindow === 'number' && m.contextWindow > 0
                ? m.contextWindow
                : resolveContextWindowFn(m.fullId),
            }
          })

        const droppedStaleCount = valid.length - models.length
        if (droppedStaleCount > 0) {
          log.info(`loadCache: dropped ${droppedStaleCount} stale cache entr${droppedStaleCount === 1 ? 'y' : 'ies'} not in FALLBACK_MODELS`)
        }

        if (models.length === 0) {
          if (valid.length > 0) {
            log.warn(`loadCache: all ${valid.length} cached entries are stale; falling back to FALLBACK_MODELS`)
          }
          return false
        }

        // Merge in any fallback entries the filtered cache doesn't cover
        // so the picker always has the canonical sonnet/opus/haiku aliases
        // even when the cache was mostly stale. The `[1m]` variant
        // synthesis that updateModels() does is intentionally NOT repeated
        // here — variants are already in the saved cache for SDK users,
        // and CLI-only users would not have a working SDK call to populate
        // them anyway.
        const seenFullIds = new Set(models.map(m => m.fullId))
        for (const fb of fallbackModels) {
          if (!seenFullIds.has(fb.fullId)) {
            const providerMeta = getModelMetadataFn ? getModelMetadataFn(fb.fullId) : null
            const id = providerMeta?.id ?? deriveIdFn(fb.fullId)
            const label = providerMeta?.label || humanizeModelId(id)
            const contextWindow = providerMeta?.contextWindow ?? fb.contextWindow ?? resolveContextWindowFn(fb.fullId)
            models.push({ id, fullId: fb.fullId, label, contextWindow })
            seenFullIds.add(fb.fullId)
          }
        }

        // Drop the cached default if it points to a filtered-out entry —
        // otherwise resolveModelId would map a stale short id to the same
        // retired fullId on the first set_model call.
        let nextDefault = parsed.defaultModelId || null
        const defaultDiscarded = nextDefault && !models.some(m => m.id === nextDefault || m.fullId === nextDefault)
        if (defaultDiscarded) nextDefault = null

        applyModels(models, nextDefault)
        // #5932: remember the cache-applied list so an overlay reload in the
        // CLI-only window (no SDK refresh yet) preserves these entries.
        lastCacheModels = models
        // Treat the loaded state as the last-saved baseline so subsequent
        // saveCache() calls only hit disk when the registry actually drifts.
        lastSavedSnapshot = snapshotString()

        // Heal the disk file when we pruned anything. Without this the
        // CLI-only/offline path would re-filter the same stale entries on
        // every startup since updateModels() never runs to overwrite them.
        if (droppedStaleCount > 0 || defaultDiscarded) {
          // Force a write by clearing the snapshot baseline (saveCacheImpl
          // skips when snapshot matches lastSavedSnapshot).
          lastSavedSnapshot = null
          saveCacheImpl(path)
        }

        return true
      } catch {
        return false
      }
    },

    /**
     * Persist the current model list to disk. Returns true on success
     * OR when there was nothing to persist (idempotent no-op); returns
     * false only if the write was attempted and failed.
     *
     * Skips disk IO when the (models, defaultModelId) snapshot matches the
     * last successful save — `_fetchSupportedModels()` fires on every SDK
     * session init, which would otherwise write ~2 KB on every user message.
     *
     * Writes go through a temp file + rename so a crash mid-write can't
     * leave a truncated cache, and permissions are locked down via
     * writeFileRestricted (0600).
     */
    saveCache(path = cachePathFn()) {
      return saveCacheImpl(path)
    },
  }

  return registry
}

// Default instance — preserves backward compatibility for all existing imports.
// Seeded with the boot-loaded user overlay so an operator-supplied model id
// appears in the picker / allowlist and survives the loadCache prune.
const defaultRegistry = createModelsRegistry({ overlay: defaultOverlay })

/**
 * #5932 — hot-reload the user model overlay (`~/.chroxy/models.json`) into the
 * DEFAULT (Claude) registry + the module-level pricing path, without a daemon
 * restart. Re-reads the file, re-folds it into the registry (re-merging with
 * any live SDK model list — AC2), and swaps the module-level `defaultOverlay`
 * so `getModelPricing()` picks up new/changed pricing.
 *
 * Safety (AC3): a MALFORMED overlay is rejected — the registry + pricing keep
 * the LAST GOOD set and the call returns `{ reloaded: false, reason }`. A
 * deleted/absent file legitimately CLEARS the overlay (an explicit operator
 * action). Never throws.
 *
 * @param {string} [path]
 * @returns {{ reloaded: boolean, reason?: string, models?: object[], defaultModelId?: string|null }}
 */
export function reloadModelsOverlay(path = getDefaultOverlayPath()) {
  const result = loadModelsOverlayResult(path)
  if (!result.ok) {
    // Malformed — keep the last-good registry + pricing untouched.
    return { reloaded: false, reason: 'malformed' }
  }
  defaultOverlay = result.overlay
  defaultRegistry.applyOverlay(result.overlay)
  return {
    reloaded: true,
    models: defaultRegistry.getModels(),
    defaultModelId: defaultRegistry.getDefaultModelId(),
  }
}

/**
 * #5932 — watch the overlay file for edits and hot-reload on change. Watches the
 * containing DIRECTORY (not the file inode) so an editor's atomic
 * write-temp-then-rename still fires, filters to the overlay filename, and
 * debounces the burst of events a single save emits. On a successful reload the
 * `onReload({ models, defaultModelId })` callback fires (the caller broadcasts
 * `available_models`). A malformed save is ignored (last-good kept, no callback).
 *
 * Returns a `{ close() }` handle; call it on daemon shutdown. Never throws — a
 * watch that can't be established (e.g. unsupported FS) logs a warn and returns
 * an inert handle (boot-only behavior, unchanged).
 *
 * `watchFactory` is injectable for tests (defaults to `fs.watch`); it must
 * return a watcher with `.close()` and accept `(dir, listener)`.
 *
 * @param {{ path?: string, onReload?: (r: object) => void, debounceMs?: number, watchFactory?: Function }} [opts]
 * @returns {{ close: () => void }}
 */
export function watchModelsOverlay({ path = getDefaultOverlayPath(), onReload, debounceMs = 200, watchFactory } = {}) {
  const dir = dirname(path)
  const file = basename(path)
  let timer = null
  let closed = false

  const fire = () => {
    timer = null
    if (closed) return
    const result = reloadModelsOverlay(path)
    if (result.reloaded && typeof onReload === 'function') {
      try { onReload(result) } catch (err) { log.warn(`watchModelsOverlay: onReload threw: ${err?.message || err}`) }
    }
  }
  const trigger = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, debounceMs)
  }

  let watcher
  try {
    const factory = typeof watchFactory === 'function' ? watchFactory : (d, listener) => fsWatch(d, listener)
    watcher = factory(dir, (_eventType, changed) => {
      // Directory watch fires for every entry; only react to our file. A null
      // filename (some platforms) is treated as "maybe ours" → reload.
      if (changed == null || basename(String(changed)) === file) trigger()
    })
    if (watcher && typeof watcher.on === 'function') {
      watcher.on('error', (err) => log.warn(`watchModelsOverlay: watcher error: ${err?.message || err}`))
    }
  } catch (err) {
    log.warn(`watchModelsOverlay: could not watch ${dir}: ${err?.message || err} — overlay edits need a restart`)
    return { close() {} }
  }

  return {
    close() {
      closed = true
      if (timer) { clearTimeout(timer); timer = null }
      try { watcher?.close?.() } catch { /* already closed */ }
    },
  }
}

/**
 * #5932 — test hook: restore the module-level default overlay + registry to a
 * known state so a test that exercises reloadModelsOverlay() doesn't leak global
 * mutations into sibling tests. Pass a Map to seed a specific overlay, or omit
 * for an empty one.
 */
export function _resetModelsOverlayForTests(overlay = new Map()) {
  defaultOverlay = overlay instanceof Map ? overlay : new Map()
  defaultRegistry.applyOverlay(defaultOverlay)
}

/**
 * Per-provider registries. Providers that expose static
 * `getFallbackModels()` and `getModelMetadata(id)` get a dedicated, isolated
 * registry so a Codex or Gemini session never sees Claude-only models. The
 * cache is lazy and keyed by provider name.
 *
 * The default Claude providers (`claude-sdk`, `claude-cli`, any docker alias
 * thereof) continue to share the module-level `defaultRegistry` so that the
 * existing cache-warming path (`loadModelsCache`) and the live
 * `updateModels()` feed from the Agent SDK still have one source of truth.
 */
const providerRegistryCache = new Map()

/**
 * True when the given provider is a Claude-family provider (and so shares the
 * default models registry, which is fed by the Agent SDK's live
 * `supportedModels()` push). Non-Claude providers (Codex, Gemini, custom) have
 * their own static allowlists and should be validated strictly.
 *
 * Used by `SessionManager.createSession` (#3403) to decide whether an unknown
 * initial model should be a hard rejection or a soft fall-back to the provider
 * default — Claude's allowlist is a moving target driven by a stale dashboard
 * `defaultModel` (e.g. `opus-4-6` after `opus-4-7` ships) so a hard error breaks
 * otherwise-valid session creation.
 *
 * #5858: membership is the SINGLE `static claudeFamily = true` flag on the
 * provider class (inherited by docker-* subclasses), not a hand-maintained name
 * literal that drifted from the registry (#5855). When the class isn't passed,
 * it is resolved via the `nameToProviderClass` map (populated for every provider
 * at registration). Docker-* resolve once `registerDockerProvider()` has run —
 * which is always before a docker session is created; `getRegistryForProvider`
 * is unaffected pre-registration because its unknown-name branch also returns
 * the default registry.
 *
 * @param {string|undefined|null} providerName
 * @param {Function} [ProviderClass] - optional provider class for the name
 * @returns {boolean}
 */
export function isClaudeProvider(providerName, ProviderClass = null) {
  // A passed class is AUTHORITATIVE: trust its boolean flag, so an explicit
  // `static claudeFamily = false` opts out even when the name would otherwise
  // resolve to a Claude class (name/class can only disagree on a caller bug,
  // but the class the caller handed us is the ground truth).
  if (ProviderClass && typeof ProviderClass.claudeFamily === 'boolean') {
    return ProviderClass.claudeFamily
  }
  // No class (or no flag on it) — resolve the class by name via the registry.
  if (typeof providerName === 'string') {
    const resolved = nameToProviderClass.get(providerName)
    if (resolved && resolved.claudeFamily === true) {
      return true
    }
  }
  return false
}

// Populated by providers.js at module load so models.js can resolve a
// provider name to its ProviderClass without creating a circular import.
// Keeping this module-local + async-free keeps `getRegistryForProvider()`
// synchronous for the ws-history.js hot path (post-auth handshake).
const nameToProviderClass = new Map()

/**
 * Called by providers.js after `registerProvider(name, ProviderClass)` so
 * models.js can build a per-provider registry on demand. Noop for Claude
 * providers — they share the default registry.
 *
 * @param {string} providerName
 * @param {Function} ProviderClass
 */
export function registerProviderRegistry(providerName, ProviderClass) {
  if (!providerName || typeof providerName !== 'string') return
  if (typeof ProviderClass !== 'function') return
  nameToProviderClass.set(providerName, ProviderClass)
  // Purge any previously-cached registry so a re-registration picks up
  // the new class (useful for tests and hot-reload).
  providerRegistryCache.delete(providerName)
}

/**
 * Test helper (#4413). Drops the cached provider registries so the next
 * `getRegistryForProvider()` call rebuilds — and re-runs `loadCache()` —
 * from disk. Used by the persistence test suite to simulate "server
 * restart": save → wipe in-memory state → re-read.
 *
 * Not exported via the public API surface beyond tests; the name leads
 * with an underscore to signal that.
 *
 * @param {string} [providerName] - When provided, drop only that provider's
 *   cached registry; when omitted, drop all of them.
 */
export function _resetProviderRegistryCacheForTests(providerName) {
  if (typeof providerName === 'string' && providerName.length > 0) {
    providerRegistryCache.delete(providerName)
    return
  }
  providerRegistryCache.clear()
}

/**
 * Lazily create and cache a provider-scoped registry.
 *
 * Claude providers (including docker-based variants) share the module-level
 * default registry so the live SDK feed keeps updating a single source of
 * truth. Non-Claude providers get their own registry driven by
 * `ProviderClass.getFallbackModels()` and `ProviderClass.getModelMetadata()`.
 *
 * Unknown or unregistered provider names fall back to the Claude registry
 * (safe default — matches the legacy global behaviour).
 *
 * @param {string} providerName
 * @returns {ReturnType<typeof createModelsRegistry>}
 */
export function getRegistryForProvider(providerName) {
  if (!providerName || isClaudeProvider(providerName)) {
    return defaultRegistry
  }

  const cached = providerRegistryCache.get(providerName)
  if (cached) return cached

  const ProviderClass = nameToProviderClass.get(providerName)
  if (!ProviderClass || typeof ProviderClass.getFallbackModels !== 'function') {
    return defaultRegistry
  }

  const registry = createModelsRegistry({
    fallbackModels: ProviderClass.getFallbackModels(),
    getModelMetadata: typeof ProviderClass.getModelMetadata === 'function'
      ? (id) => ProviderClass.getModelMetadata(id)
      : null,
    // Non-Claude providers typically use opaque full ids (no prefix to
    // strip) — identity is the safest default. Providers can override via
    // `getModelMetadata()` when they want a different short id.
    deriveId: (fullId) => fullId,
    resolveContextWindow: (fullId) => {
      const meta = typeof ProviderClass.getModelMetadata === 'function'
        ? ProviderClass.getModelMetadata(fullId)
        : null
      // #5421: preserve an EXPLICIT null — providers like ollama return
      // `contextWindow: null` to say "window unknown, never fabricate"
      // (#5418), and substituting DEFAULT_CONTEXT_WINDOW here would pin a
      // made-up 200k chip on every discovered local model. Only fall back
      // to the default when the provider has no metadata entry at all.
      if (meta && 'contextWindow' in meta) return meta.contextWindow
      return DEFAULT_CONTEXT_WINDOW
    },
    // #4413: provider-scoped cache path. Lazy resolver so tests that mutate
    // `CHROXY_CONFIG_DIR` after registry creation still hit the temp dir.
    cachePath: () => getProviderCachePath(providerName),
  })
  // #4413: hydrate the registry from its own cache file before serving the
  // first getModels() call. A miss (no file, malformed, all-stale) is a
  // silent no-op so cold-boot semantics are unchanged. This restores any
  // previously-learned context-window ratchet (gpt-5/gpt-5-codex 400k →
  // 550k after a series of large turns) so the dashboard meter is honest
  // immediately, not only after the next over-budget turn.
  try {
    registry.loadCache()
  } catch (err) {
    log.warn(`getRegistryForProvider(${providerName}): loadCache threw unexpectedly: ${err?.message || err}`)
  }
  providerRegistryCache.set(providerName, registry)
  return registry
}

// Accept both short ids and full model IDs in set_model.
// Proxy delegates to the default registry's live Set so mutations
// (from updateModels/resetModels) are always reflected.
export const ALLOWED_MODEL_IDS = new Proxy(new Set(), {
  get(_, prop) {
    const target = defaultRegistry.getAllowedModelIds()
    const value = Reflect.get(target, prop, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

export function getModels() {
  return defaultRegistry.getModels()
}

export function updateModels(sdkModels) {
  return defaultRegistry.updateModels(sdkModels)
}

export function updateContextWindow(modelId, contextWindow) {
  return defaultRegistry.updateContextWindow(modelId, contextWindow)
}

export function resetModels() {
  defaultRegistry.resetModels()
}

export function resolveModelId(model) {
  return defaultRegistry.resolveModelId(model)
}

export function toShortModelId(model) {
  return defaultRegistry.toShortModelId(model)
}

export function getDefaultModelId() {
  return defaultRegistry.getDefaultModelId()
}

export function loadModelsCache(path) {
  return defaultRegistry.loadCache(path)
}

export function saveModelsCache(path) {
  return defaultRegistry.saveCache(path)
}
