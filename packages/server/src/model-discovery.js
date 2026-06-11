/**
 * Generic model-catalog discovery for `providers.anthropicCompatible` entries
 * (#5548) — a capability declared via `modelDiscovery: { url, format }`, NOT
 * OpenRouter-specific code.
 *
 * Many aggregators and local servers expose an OpenAI-ish `/v1/models` listing
 * (OpenRouter carries per-token pricing alongside; LM Studio / vLLM list ids
 * only). This module probes that endpoint, normalizes the response per-format
 * into `{ models, pricing }`, and feeds the result into the provider's models
 * registry + per-model cost table — exactly the role Ollama's /api/tags probe
 * (ollama-tags.js, #5421) plays for the local daemon. The cache/refresh shape
 * is deliberately the same:
 *
 *   - ADVISORY for the picker, AUTHORITATIVE for validation. A discovered
 *     catalog replaces the static `models` allowlist for that entry (the
 *     issue's tri-state interplay with #5418): the session class reports the
 *     discovered ids from getAllowedModels() once a catalog is in hand.
 *   - GRACEFUL FAILURE. Endpoint down / slow / garbage must never delay or
 *     break session start: bounded timeout, debug-level logging, and the
 *     picker keeps whatever it already had (the static seed on cold boot).
 *   - NO RETRY STORM. Results — success AND failure — are cached per entry for
 *     a TTL, and concurrent callers share one in-flight request. A reconnect
 *     loop can't hammer the aggregator.
 *
 * Unlike Ollama's single global daemon, anthropicCompatible entries are
 * many-and-configurable, so the cache here is keyed per entry id (a Map of
 * per-entry slots) rather than module-level scalars.
 *
 * Pricing: OpenRouter reports USD-per-TOKEN rates as strings (e.g.
 * `"0.0000004"` = $0.40/MTok). We convert to chroxy's internal USD-per-MTok
 * convention so the discovered table drops straight into byok-session's cost
 * math (the same units `pricing` blocks already use).
 */

import { createLogger } from './logger.js'

const log = createLogger('model-discovery')

// Bounded probe. A catalog endpoint is a remote HTTP service (OpenRouter) or a
// local one (LM Studio) — 4s is generous for the former and instant for the
// latter, while still capping a wedged endpoint's drag on a session that opted
// in. Discovery is fire-and-forget, so this never blocks the user.
export const MODEL_DISCOVERY_TIMEOUT_MS = 4000

// Cache window for discovery results (success AND failure). A catalog of
// hundreds of models changes slowly; 5 min keeps a reconnecting dashboard /
// multi-client handshake burst down to at most one HTTP probe per window while
// still picking up new models within the session.
export const MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60_000

// USD per token → USD per MTok. OpenRouter prices are per-token strings.
const TOKENS_PER_MTOK = 1_000_000

/**
 * Coerce an OpenRouter per-token price (string or number) to USD-per-MTok.
 * Missing / unparseable / negative → 0 (an honest $0 rather than a fabricated
 * rate — the ollama/local convention).
 *
 * @param {*} perToken
 * @returns {number}
 */
function perTokenToMTok(perToken) {
  const n = typeof perToken === 'string' ? Number(perToken) : perToken
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0
  return n * TOKENS_PER_MTOK
}

/**
 * Normalize an OpenRouter /api/v1/models response into chroxy's shape.
 *
 * OpenRouter entry (relevant fields):
 *   { id, name, context_length,
 *     pricing: { prompt, completion, input_cache_read, input_cache_write } }
 *
 * @param {*} body - parsed JSON
 * @returns {{ models: Array<{id,label,contextWindow}>, pricing: Object }|null}
 */
function parseOpenRouter(body) {
  const list = Array.isArray(body?.data) ? body.data : null
  if (!list) return null
  const models = []
  const pricing = {}
  const seen = new Set()
  for (const m of list) {
    const id = typeof m?.id === 'string' ? m.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = typeof m?.name === 'string' && m.name.trim().length > 0 ? m.name.trim() : id
    const ctx = Number.isInteger(m?.context_length) && m.context_length > 0 ? m.context_length : null
    models.push({ id, label, contextWindow: ctx })
    const p = m?.pricing
    if (p && typeof p === 'object') {
      pricing[id] = Object.freeze({
        input: perTokenToMTok(p.prompt),
        output: perTokenToMTok(p.completion),
        cacheRead: perTokenToMTok(p.input_cache_read),
        cacheWrite: perTokenToMTok(p.input_cache_write),
      })
    }
  }
  if (models.length === 0) return null
  return { models, pricing }
}

/**
 * Normalize a bare OpenAI /v1/models response (ids only, no pricing). Covers
 * LM Studio, vLLM, and any OpenAI-format server. Designed to slot in alongside
 * the openrouter adapter — same return shape, empty pricing table.
 *
 * OpenAI entry: { id, object: 'model', ... } under a top-level `data` array.
 *
 * @param {*} body
 * @returns {{ models: Array<{id,label,contextWindow}>, pricing: Object }|null}
 */
function parseOpenAi(body) {
  const list = Array.isArray(body?.data) ? body.data : null
  if (!list) return null
  const models = []
  const seen = new Set()
  for (const m of list) {
    const id = typeof m?.id === 'string' ? m.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    // No name/context in the bare OpenAI list — id doubles as label, window
    // unknown (null, never fabricated — the #5444 rule).
    models.push({ id, label: id, contextWindow: null })
  }
  if (models.length === 0) return null
  return { models, pricing: {} }
}

const FORMAT_PARSERS = Object.freeze({
  openrouter: parseOpenRouter,
  openai: parseOpenAi,
})

/**
 * Fetch + normalize a model catalog. Returns `{ models, pricing }` on success
 * or null on ANY failure (endpoint down, non-2xx, malformed JSON, unexpected
 * shape, timeout, unknown format). Failures log at debug level only.
 *
 * Authorization: discovery endpoints often gate the list behind the same key
 * as the chat endpoint (OpenRouter requires no key for /api/v1/models, but
 * passing one is harmless and future-proofs gated aggregators). When `apiKey`
 * is supplied and non-empty it rides as `Authorization: Bearer`. Never logged.
 *
 * @param {Object} opts
 * @param {string} opts.url
 * @param {string} opts.format - one of MODEL_DISCOVERY_FORMATS
 * @param {string|null} [opts.apiKey]
 * @param {typeof fetch} [opts.fetchFn] - injectable fetch for tests
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{models:Array,pricing:Object}|null>}
 */
export async function fetchModelCatalog({ url, format, apiKey = null, fetchFn = fetch, timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS } = {}) {
  const parse = FORMAT_PARSERS[format]
  if (typeof parse !== 'function') {
    log.debug(`discovery: unknown format '${format}' for ${url}`)
    return null
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { accept: 'application/json' }
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      headers.authorization = `Bearer ${apiKey}`
    }
    const res = await fetchFn(url, { signal: controller.signal, headers })
    if (!res?.ok) {
      log.debug(`discovery: ${url} answered ${res?.status ?? 'no response'}`)
      return null
    }
    const body = await res.json()
    const parsed = parse(body)
    if (!parsed) {
      log.debug(`discovery: ${url} returned an unexpected shape for format '${format}'`)
      return null
    }
    return parsed
  } catch (err) {
    log.debug(`discovery: ${url} failed (${err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err?.message || err})`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// --- Per-entry TTL cache for refreshDiscoveredModels ---
// Keyed by entry id (anthropicCompatible entries are many; Ollama is one
// global daemon and uses module scalars). Each slot tracks last-probe time,
// the in-flight promise, and the last-applied key for change detection.
const _slots = new Map()

function slotFor(id) {
  let slot = _slots.get(id)
  if (!slot) {
    slot = { lastProbeAt: -Infinity, inflight: null, lastAppliedKey: null }
    _slots.set(id, slot)
  }
  return slot
}

/** Test hook: drop all per-entry cache + change-detection state. */
export function _resetModelDiscoveryStateForTests() {
  _slots.clear()
}

/**
 * Discover the catalog for one anthropicCompatible entry and feed it into the
 * provider's models registry. Resolves to the refreshed registry model list
 * when the picker CHANGED, or null when there is nothing new to broadcast
 * (probe failed, no models, same set as last time, or served from the TTL
 * cache) — the exact contract of refreshOllamaModels so the generic
 * `scheduleProviderModelsRefresh` hook in ws-history treats both alike.
 *
 * Side effect: when discovery succeeds, the full catalog (`{ models, pricing }`)
 * is published via `applyCatalog(catalog)` BEFORE the registry feed, so the
 * session class's getModelMetadata/getAllowedModels/_getPricing read from the
 * discovered ids + context windows + per-model pricing (real cost, not $0) by
 * the time the registry's updateModels() consults them.
 *
 * @param {Object} opts
 * @param {string} opts.id - provider/entry id (cache key + log label)
 * @param {string} opts.url
 * @param {string} opts.format
 * @param {string|null} [opts.apiKey]
 * @param {Object} opts.registry - provider models registry (updateModels/getModels)
 * @param {(catalog: {models:Array,pricing:Object}) => void} [opts.applyCatalog] - catalog sink
 * @param {typeof fetch} [opts.fetchFn]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.ttlMs]
 * @param {() => number} [opts.now] - injectable clock for tests
 * @returns {Promise<Array<Object>|null>}
 */
export async function refreshDiscoveredModels(opts = {}) {
  const { id } = opts
  if (typeof id !== 'string' || id.length === 0) return null
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : MODEL_DISCOVERY_CACHE_TTL_MS
  const slot = slotFor(id)
  if (slot.inflight) return slot.inflight
  if (now() - slot.lastProbeAt < ttlMs) return null
  slot.inflight = (async () => {
    try {
      const catalog = await fetchModelCatalog(opts)
      slot.lastProbeAt = now()
      if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) return null
      // Publish the catalog to the session class FIRST (cheap, idempotent) so
      // its getModelMetadata/getAllowedModels/_getPricing reflect the discovered
      // ids + context windows + per-model pricing before updateModels() (which
      // consults getModelMetadata for labels/windows) runs below. Done on every
      // successful probe so a re-probe with the same model SET but updated rates
      // still refreshes cost reporting.
      if (typeof opts.applyCatalog === 'function') {
        try {
          opts.applyCatalog(catalog)
        } catch (err) {
          log.debug(`discovery: applyCatalog for ${id} threw: ${err?.message || err}`)
        }
      }
      // Change-detection key: order-insensitive (a reorder of the same set
      // isn't a change) and metadata-aware (a label / context-window update on
      // an existing id IS a change the registry must pick up — updateModels()
      // feeds those into the picker). Sort so upstream ordering can't trigger a
      // spurious rebroadcast; include label + window so a metadata-only update
      // still re-pushes. (Pricing already refreshes unconditionally via the
      // applyCatalog call above, so it stays out of the key.)
      const key = JSON.stringify(
        catalog.models
          .map((m) => [m.id, m.label ?? '', m.contextWindow ?? null])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      )
      if (key === slot.lastAppliedKey) return null
      const registry = opts.registry
      if (!registry || typeof registry.updateModels !== 'function') return null
      const converted = registry.updateModels(
        catalog.models.map((m) => ({ value: m.id, displayName: m.label, contextWindow: m.contextWindow })),
      )
      if (!Array.isArray(converted) || converted.length === 0) return null
      slot.lastAppliedKey = key
      log.info(`discovered ${catalog.models.length} models for '${id}' via ${opts.format} catalog`)
      return typeof registry.getModels === 'function' ? registry.getModels() : converted
    } finally {
      slot.inflight = null
    }
  })()
  return slot.inflight
}
