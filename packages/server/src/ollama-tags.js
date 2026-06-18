/**
 * Dynamic Ollama model discovery — GET /api/tags (#5421).
 *
 * Asks the local Ollama daemon which models are actually pulled and feeds
 * the result into the per-provider models registry so the dashboard picker
 * reflects `ollama list` instead of the static 3-model seed from #5418.
 *
 * Design constraints (issue #5421):
 *   - ADVISORY, NOT RESTRICTIVE. Discovery only populates the picker;
 *     `OllamaSession.getAllowedModels()` stays null (unrestricted) because
 *     a model can be `ollama pull`ed mid-session or addressed by an alias
 *     the tag list doesn't spell out. Validation never consults this module.
 *   - GRACEFUL FAILURE. Ollama down / slow / returning garbage must never
 *     delay session start or spam the logs: short timeout (800ms), debug-
 *     level logging only, and the picker keeps whatever it already had
 *     (the static fallback list on cold boot).
 *   - NO RETRY STORM. Results — including failures — are cached for a
 *     30s TTL, and concurrent callers share one in-flight request. A
 *     dashboard reconnect loop can't hammer the daemon.
 *
 * This module also owns base-URL resolution (moved here from
 * ollama-session.js, which re-exports it for compatibility) so the session
 * seam, the auth-panel label, and the tags probe can never disagree about
 * where Ollama lives. /api/tags is served at the Ollama ROOT — when an
 * operator's override includes the Anthropic-compat `/v1` path suffix, it
 * is stripped before appending /api/tags.
 */

import { getRegistryForProvider } from './models.js'
import { createLogger } from './logger.js'

const log = createLogger('ollama')

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'

// Bounded probe: Ollama is a local daemon — if it hasn't answered in 800ms
// it is down (or wedged), and the picker should just keep its current list.
export const OLLAMA_TAGS_TIMEOUT_MS = 800

// Cache window for discovery results (success AND failure). Keeps a
// reconnecting dashboard / multi-client handshake burst down to at most
// one HTTP probe per 30s while still picking up `ollama pull` quickly.
export const OLLAMA_TAGS_CACHE_TTL_MS = 30_000

/**
 * Resolve the Ollama endpoint. Exported (and re-exported by
 * ollama-session.js) for tests and for the auth panel's detail string —
 * keep resolution in exactly one place.
 *
 * Resolution order (first match wins):
 *   1. CHROXY_OLLAMA_BASE_URL — full URL, chroxy-specific override
 *   2. OLLAMA_HOST — Ollama's own convention; may be `host:port` without
 *      a scheme, normalized to http:// here
 *   3. http://localhost:11434 — Ollama's default bind
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveOllamaBaseUrl(env = process.env) {
  // Trimmed-non-empty is the single "is set" predicate — resolveAuth
  // derives its override-var label from the same helper so the detail
  // string and the actual routing can never disagree. An exported-but-
  // empty (or whitespace) var counts as unset. Deliberately NO URL
  // validation here: silently redirecting a typo'd override to localhost
  // would mask the misconfig — a malformed value flows through and fails
  // loudly in the SDK's request path, and resolveAuth's `detail` shows
  // the exact string in the dashboard.
  const explicit = ollamaEnvOverride(env)
  if (explicit === 'CHROXY_OLLAMA_BASE_URL') return env.CHROXY_OLLAMA_BASE_URL.trim()
  if (explicit === 'OLLAMA_HOST') {
    const host = env.OLLAMA_HOST.trim()
    // OLLAMA_HOST accepts bare `host`, `host:port`, or a full URL.
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`
  }
  return DEFAULT_OLLAMA_BASE_URL
}

/**
 * Which env var (if any) is overriding the endpoint. Shared by
 * resolveOllamaBaseUrl (routing) and OllamaSession.resolveAuth (labelling)
 * so the two can't drift.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {'CHROXY_OLLAMA_BASE_URL'|'OLLAMA_HOST'|null}
 */
export function ollamaEnvOverride(env) {
  if (typeof env.CHROXY_OLLAMA_BASE_URL === 'string' && env.CHROXY_OLLAMA_BASE_URL.trim().length > 0) {
    return 'CHROXY_OLLAMA_BASE_URL'
  }
  if (typeof env.OLLAMA_HOST === 'string' && env.OLLAMA_HOST.trim().length > 0) {
    return 'OLLAMA_HOST'
  }
  return null
}

/**
 * Build the /api/tags URL from a resolved base URL. /api/tags lives at the
 * Ollama root: trailing slashes and an Anthropic-compat `/v1` path suffix
 * (some operators point CHROXY_OLLAMA_BASE_URL at the versioned path even
 * though the SDK appends it itself) are stripped first.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function buildOllamaTagsUrl(baseUrl) {
  let root = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  root = root.replace(/\/+$/, '')
  root = root.replace(/\/v1$/i, '')
  return `${root}/api/tags`
}

/**
 * GET <root>/api/tags and return the installed model tags as a normalized,
 * deduplicated string array — or null on ANY failure (daemon down, non-2xx,
 * malformed JSON, unexpected shape, timeout). Failures log at debug level
 * only: an absent Ollama is a normal steady state, not an error.
 *
 * Normalization: a bare `:latest` suffix is stripped (Ollama treats
 * `qwen3-coder` and `qwen3-coder:latest` as the same model, and the short
 * form matches the curated fallback ids so the picker doesn't show
 * duplicates). Other tags (`:7b`, `:q4_K_M`, …) identify distinct local
 * variants and are kept verbatim.
 *
 * @param {Object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env] - env for base-URL resolution
 * @param {typeof fetch} [opts.fetchFn] - injectable fetch for tests
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string[]|null>}
 */
export async function fetchOllamaTags({ env = process.env, fetchFn = fetch, timeoutMs = OLLAMA_TAGS_TIMEOUT_MS } = {}) {
  const url = buildOllamaTagsUrl(resolveOllamaBaseUrl(env))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, { signal: controller.signal })
    if (!res?.ok) {
      log.debug(`tags probe: ${url} answered ${res?.status ?? 'no response'}`)
      return null
    }
    const body = await res.json()
    if (!Array.isArray(body?.models)) {
      log.debug(`tags probe: ${url} returned unexpected shape (no models array)`)
      return null
    }
    const seen = new Set()
    const tags = []
    for (const m of body.models) {
      // /api/tags entries carry both `name` and `model` (identical in
      // practice); prefer `name`, fall back to `model` for forward-compat.
      const raw = typeof m?.name === 'string' && m.name.trim().length > 0
        ? m.name.trim()
        : (typeof m?.model === 'string' ? m.model.trim() : '')
      if (!raw) continue
      const tag = raw.replace(/:latest$/, '')
      if (!tag || seen.has(tag)) continue
      seen.add(tag)
      tags.push(tag)
    }
    return tags
  } catch (err) {
    // AbortError (timeout), ECONNREFUSED (daemon down), invalid JSON —
    // all the same outcome: no discovery this round.
    log.debug(`tags probe: ${url} failed (${err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err?.message || err})`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// --- TTL cache for refreshOllamaModels ---
// -Infinity (not 0) so the first call always probes even under an injected
// test clock that starts near zero.
let _lastProbeAt = -Infinity
let _inflight = null
// Stringified tag set last fed into the registry — lets a successful
// re-probe that found the SAME models skip the registry rebuild and the
// resulting available_models re-broadcast.
let _lastAppliedKey = null

/** Test hook: drop the TTL cache + change-detection state. */
export function _resetOllamaTagsStateForTests() {
  _lastProbeAt = -Infinity
  _inflight = null
  _lastAppliedKey = null
}

/**
 * Discover installed models and feed them into the ollama provider's
 * models registry. Resolves to the registry's refreshed model list when
 * the picker contents CHANGED, or null when there is nothing new to
 * broadcast (probe failed, no models installed, same set as last time,
 * or served from the TTL cache).
 *
 * Callers treat a non-null result as "push a fresh available_models to
 * clients"; null means whatever was already sent is still accurate.
 *
 * Concurrency: one probe in flight at a time (joiners share its promise);
 * results — including failures — are cached for OLLAMA_TAGS_CACHE_TTL_MS
 * so handshake bursts and reconnect loops cost at most one HTTP GET per
 * window.
 *
 * @param {Object} [opts] - forwarded to fetchOllamaTags; plus:
 * @param {Object} [opts.registry] - injectable registry for tests.
 *   Defaults to getRegistryForProvider('ollama'). In production the
 *   provider is registered by providers.js at module load, well before
 *   any caller of this function exists.
 * @param {number} [opts.ttlMs]
 * @param {() => number} [opts.now] - injectable clock for tests
 * @returns {Promise<Array<Object>|null>}
 */
export async function refreshOllamaModels(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : OLLAMA_TAGS_CACHE_TTL_MS
  if (_inflight) return _inflight
  if (now() - _lastProbeAt < ttlMs) return null
  _inflight = (async () => {
    try {
      const tags = await fetchOllamaTags(opts)
      _lastProbeAt = now()
      // Failure or an empty install: keep the current picker contents
      // (static fallback on cold boot, last successful discovery after).
      if (!Array.isArray(tags) || tags.length === 0) return null
      const key = JSON.stringify(tags)
      if (key === _lastAppliedKey) return null
      const registry = opts.registry ?? getRegistryForProvider('ollama')
      // No displayName: labels come from OllamaSession.getModelMetadata
      // (curated labels for the recommended models, the raw tag otherwise).
      const converted = registry.updateModels(tags.map((tag) => ({ value: tag })))
      if (!Array.isArray(converted) || converted.length === 0) return null
      _lastAppliedKey = key
      log.info(`discovered ${tags.length} installed Ollama model${tags.length === 1 ? '' : 's'} via /api/tags`)
      return registry.getModels()
    } finally {
      _inflight = null
    }
  })()
  return _inflight
}
