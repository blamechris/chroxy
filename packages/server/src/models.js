import { readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'

const log = createLogger('models')

/** Default context window for unknown models */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Suffix the Claude CLI uses to mark the explicit 1M-context variant */
export const ONE_M_SUFFIX = '[1m]'

/**
 * Static context-window heuristic used at cold start before the SDK reports.
 * Opus 4.6+ has 1M; most other Claude models have 200k. Any id carrying the
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
  if (fullId.includes('opus-4-6') || fullId.includes('opus-4.6')) return 1_000_000
  if (fullId.includes('opus-4-7') || fullId.includes('opus-4.7')) return 1_000_000
  // opus-4-8 is treated as 1M for consistency with the rest of the opus 4.x
  // family the heuristic already maps to 1M — this is a family-consistency
  // default, not a verified spec. The SDK's authoritative
  // modelUsage.contextWindow overrides it after the first turn if wrong.
  if (fullId.includes('opus-4-8') || fullId.includes('opus-4.8')) return 1_000_000
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

// Minimal fallback used only when the SDK has never responded and no disk
// cache exists. Short aliases (sonnet/opus/haiku) resolve to the latest
// version in the claude CLI, so these entries stay valid across releases.
// Dated full IDs are intentionally avoided here — the SDK's supportedModels()
// is the source of truth for concrete version identifiers.
//
// These also seed the merge step in `updateModels()` so that a stale or
// minimal SDK response (e.g. only reporting 4.6 models) still surfaces the
// newer 4.7 chip in the picker (#3075).
//
// Deep-frozen so callers of getModels() can't mutate the module-level constant
// via the returned array reference.
export const FALLBACK_MODELS = Object.freeze([
  Object.freeze({ id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6', contextWindow: resolveClaudeContextWindow('claude-sonnet-4-6') }),
  Object.freeze({ id: 'opus', label: 'Opus', fullId: 'claude-opus-4-7', contextWindow: resolveClaudeContextWindow('claude-opus-4-7') }),
  // Fable falls through to the 200k DEFAULT_CONTEXT_WINDOW heuristic on
  // purpose — the SDK's authoritative modelUsage.contextWindow ratchets it
  // after the first turn; we don't invent a fable window here.
  Object.freeze({ id: 'fable', label: 'Fable', fullId: 'claude-fable-5', contextWindow: resolveClaudeContextWindow('claude-fable-5') }),
  Object.freeze({ id: 'haiku', label: 'Haiku', fullId: 'claude-haiku-4-5', contextWindow: resolveClaudeContextWindow('claude-haiku-4-5') }),
])

// Public Anthropic pricing in USD per million tokens. Cache-write is the
// 5-minute ephemeral tier (the default; the 1-hour tier costs more but
// chroxy doesn't opt into it). Source: Anthropic public pricing page —
// keep this table in sync when prices change. Numbers wrong here mean
// cumulative-cost displays mislead users (#4054), so revisit on every
// model addition.
//
// #4087 — long-context (>200K input) premium tier: Anthropic charges a
// higher rate when the total input (input + cache reads + cache writes)
// exceeds 200K tokens on the `[1m]` long-context variant. The
// `longContext` block on the `[1m]` entry captures the premium rates;
// `computePromptCostUsd` selects between base and longContext rates
// based on the turn's total input tokens.
//
// Today, only Opus 4.x has a 1M-context variant in chroxy's model set
// (resolveClaudeContextWindow above). Sonnet 4.6 and Haiku 4.5 don't
// have `[1m]` forms, so their entries have no longContext block.
const CLAUDE_PRICING_USD_PER_MTOK = Object.freeze({
  'claude-sonnet-4-6': Object.freeze({ input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 }),
  'claude-opus-4-7':   Object.freeze({ input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 }),
  'claude-opus-4-7[1m]': Object.freeze({
    // Below the 200K threshold the rates match the default-window entry.
    input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75,
    // Above 200K input the published premium is a uniform 2× across all
    // four rates (input, output, cacheRead, cacheWrite). Verify against
    // the Anthropic pricing page on the next periodic check — the
    // numbers are public but easy to drift. Test in `models.test.js`
    // pins the exact literals so a drift fails loudly.
    longContext: Object.freeze({
      thresholdInputTokens: 200_000,
      input: 30.00, output: 150.00, cacheRead: 3.00, cacheWrite: 37.50,
    }),
  }),
  'claude-haiku-4-5':  Object.freeze({ input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 }),
})

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
 * semantically distinct from a genuine `$0.00` turn: the dashboard renders
 * "n/a" for an unknown cost (via `formatCostBadgeOrNa`) instead of pretending
 * it was free. Callers that accumulate a turn total MUST skip a `null` (it is
 * not addable) — see byok-session.js's `turnCostKnown` guard. Never throws,
 * never returns NaN. Cache-read tokens are NOT also billed at the input rate;
 * the SDK already excludes them from `input_tokens`.
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
function loadModelsOverlay(path = getDefaultOverlayPath()) {
  const overlay = new Map()
  let raw
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    // Missing file is the common case — empty overlay, no log.
    return overlay
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.warn(`loadModelsOverlay: malformed JSON in ${path}: ${err?.message || err} — ignoring overlay`)
    return overlay
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn(`loadModelsOverlay: ${path} is not a JSON object keyed by model id — ignoring overlay`)
    return overlay
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
  return overlay
}

// Module-level overlay, loaded once at boot. The default Claude registry and
// the module-level getModelPricing() consult this. Per-provider registries
// take their own overlay via the createModelsRegistry hook.
const defaultOverlay = loadModelsOverlay()

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
  const overlayRows = []
  const overriddenBase = []
  const baseByFullId = new Map(baseFallbackModels.map((m) => [m.fullId, m]))
  for (const entry of overlay.values()) {
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
  const fallbackModels = overlayRows.length > 0 || overriddenBase.some((m, i) => m !== baseFallbackModels[i])
    ? Object.freeze([...overriddenBase, ...overlayRows])
    : baseFallbackModels

  let activeModels = fallbackModels
  let defaultModelId = null
  let allowedModelIds = new Set()
  let toFullIdMap = new Map()
  let toShortIdMap = new Map()
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
    activeModels = models
    defaultModelId = nextDefault
    rebuildLookups(models)
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

  return {
    getModels() {
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
}

// Default instance — preserves backward compatibility for all existing imports.
// Seeded with the boot-loaded user overlay so an operator-supplied model id
// appears in the picker / allowlist and survives the loadCache prune.
const defaultRegistry = createModelsRegistry({ overlay: defaultOverlay })

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

const CLAUDE_PROVIDER_NAMES = new Set([
  'claude-sdk',
  'claude-cli',
  'docker',
  'docker-sdk',
  'docker-cli',
])

/**
 * True when the given provider name is a Claude-family provider (and so
 * shares the default models registry, which is fed by the Agent SDK's live
 * `supportedModels()` push). Non-Claude providers (Codex, Gemini, custom)
 * have their own static allowlists and should be validated strictly.
 *
 * Used by `SessionManager.createSession` (#3403) to decide whether an
 * unknown initial model should be a hard rejection or a soft fall-back to
 * the provider default — Claude's allowlist is a moving target driven by
 * a stale dashboard `defaultModel` (e.g. `opus-4-6` after `opus-4-7` ships)
 * so a hard error breaks otherwise-valid session creation.
 *
 * Also honours an opt-in static flag on the provider class
 * (`static claudeFamily = true`) so external/test providers can mark
 * themselves as Claude-style without extending the hard-coded name set.
 *
 * @param {string|undefined|null} providerName
 * @param {Function} [ProviderClass] - optional provider class for the name
 * @returns {boolean}
 */
export function isClaudeProvider(providerName, ProviderClass = null) {
  if (typeof providerName === 'string' && CLAUDE_PROVIDER_NAMES.has(providerName)) {
    return true
  }
  if (ProviderClass && ProviderClass.claudeFamily === true) {
    return true
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
  if (!providerName || CLAUDE_PROVIDER_NAMES.has(providerName)) {
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
