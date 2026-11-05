/**
 * #8275 — refresh the Claude model registry from the installed `claude`
 * without a session.
 *
 * The picker is fed by the live list `claude` reports (`supportedModels()`).
 * Chroxy used to ask for it only when a claude-sdk session initialised, so a
 * daemon whose sessions are claude-tui (the default) kept the list it warmed
 * from `models-cache.json` at boot indefinitely.
 *
 * What a refresh runs: ONE prompt-less Agent SDK `query()` against the verified
 * `claude` binary. The prompt is an async iterable that never yields, so no
 * user turn is ever sent (no tokens, no billed or interactive session); the
 * only traffic is the SDK's initialize control request, whose answer is
 * `supportedModels()`. `persistSession: false` and `settingSources: []` keep it
 * from writing a transcript or loading the user's hooks/settings. The query is
 * closed as soon as the list is read, or when the timeout fires.
 *
 * Contract: best-effort and bounded. Every failure (no binary, refused by the
 * provenance gate, SDK throw, timeout, empty answer) returns null and leaves
 * the registry and cache file as they were. At most one refresh runs at a time
 * and a refresh is attempted at most once per `minIntervalMs`, because the
 * trigger (a client connecting) fires far more often than claude changes.
 * `CHROXY_DISABLE_MODEL_REFRESH=1` turns it off (the test harness sets it).
 */

import { tmpdir } from 'os'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { isWellFormedThinkingLevel, LEGACY_DEFAULT_THINKING_LEVEL } from '@chroxy/protocol'
import { updateModels, saveModelsCache } from './models.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { createLogger } from './logger.js'

const log = createLogger('claude-model-refresh')

export const REFRESH_TIMEOUT_MS = 20_000
export const REFRESH_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * The SDK's per-model effort answer (`supportsEffort` + `supportedEffortLevels`)
 * as the registry's `reasoningLevels` roster (#8700). The model default leads
 * the list. null for a model without effort, which keeps the legacy roster.
 * @param {object} modelInfo - one `supportedModels()` row
 * @returns {{reasoningLevels: string[], defaultReasoningLevel: string} | null}
 */
export function effortRoster(modelInfo) {
  if (modelInfo?.supportsEffort !== true || !Array.isArray(modelInfo.supportedEffortLevels)) return null
  const levels = [...new Set(modelInfo.supportedEffortLevels.filter(isWellFormedThinkingLevel))]
    .filter((l) => l !== LEGACY_DEFAULT_THINKING_LEVEL)
  if (levels.length === 0) return null
  return { reasoningLevels: [LEGACY_DEFAULT_THINKING_LEVEL, ...levels], defaultReasoningLevel: LEGACY_DEFAULT_THINKING_LEVEL }
}

/**
 * Stamp each `supportedModels()` row with its effort roster, ready for
 * `updateModels`. When `effortSupport` (a Map) is given it also records, per
 * model key, whether the model takes `effort` or a `budget` (#8700): a row
 * without `supportsEffort` means "no effort" only from a CLI that reports effort
 * for some model; one that reports it for none predates the field.
 * @param {unknown} sdkModels
 * @param {Map<string,string>} [effortSupport]
 * @returns {unknown}
 */
export function annotateSupportedModels(sdkModels, effortSupport = null) {
  if (!Array.isArray(sdkModels)) return sdkModels
  const reportsEffort = sdkModels.some((m) => m?.supportsEffort === true)
  return sdkModels.map((m) => {
    const support = m?.supportsEffort === true ? 'effort' : (reportsEffort ? 'budget' : null)
    if (support && effortSupport) {
      for (const key of [m?.value, m?.resolvedModel]) {
        if (typeof key === 'string' && key.length > 0) effortSupport.set(key, support)
      }
    }
    const roster = effortRoster(m)
    return roster ? { ...m, ...roster } : m
  })
}

/** An input stream that never yields: the query starts but no turn is sent. */
function idlePrompt(signal) {
  return {
    async *[Symbol.asyncIterator]() {
      if (signal.aborted) return
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    },
  }
}

let inFlight = null
let lastAttemptAt = -Infinity

/** Test seam: forget the throttle and any in-flight refresh. */
export function _resetClaudeModelRefreshForTests() {
  inFlight = null
  lastAttemptAt = -Infinity
}

/**
 * @param {object} deps
 * @param {() => string} deps.bin - returns the VERIFIED claude path; may throw
 * @param {Function} [deps.queryFn] - SDK `query` (test seam)
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.minIntervalMs]
 * @param {() => number} [deps.now]
 * @param {boolean} [deps.force] - ignore the throttle
 * @returns {Promise<object[]|null>} the converted roster, or null (skipped / failed)
 */
export function refreshClaudeModels(deps = {}) {
  const {
    bin,
    queryFn = sdkQuery,
    timeoutMs = REFRESH_TIMEOUT_MS,
    minIntervalMs = REFRESH_MIN_INTERVAL_MS,
    now = Date.now,
    force = false,
  } = deps
  if (inFlight) return inFlight
  // Operator/harness opt-out. An injected `queryFn` is a test double that can
  // spawn nothing, so it is exempt: the module's own tests exercise the path.
  if (process.env.CHROXY_DISABLE_MODEL_REFRESH === '1' && !deps.queryFn) return Promise.resolve(null)
  if (!force && now() - lastAttemptAt < minIntervalMs) return Promise.resolve(null)
  lastAttemptAt = now()
  inFlight = runRefresh({ bin, queryFn, timeoutMs }).finally(() => { inFlight = null })
  return inFlight
}

async function runRefresh({ bin, queryFn, timeoutMs }) {
  const abort = new AbortController()
  let q = null
  let timer = null
  try {
    if (typeof bin !== 'function') return null
    const path = bin()
    if (!path) return null
    q = queryFn({
      prompt: idlePrompt(abort.signal),
      options: {
        cwd: tmpdir(),
        pathToClaudeCodeExecutable: path,
        env: buildSpawnEnv('claude-sdk'),
        settingSources: [],
        persistSession: false,
        abortController: abort,
      },
    })
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    const sdkModels = await Promise.race([q.supportedModels(), timeout])
    const converted = updateModels(annotateSupportedModels(sdkModels))
    if (!converted || converted.length === 0) return null
    log.info(`Refreshed Claude models without a session: ${converted.map((m) => m.id).join(', ')}`)
    saveModelsCache()
    return converted
  } catch (err) {
    log.debug(`Claude model refresh failed (keeping the cached list): ${err?.message || err}`)
    return null
  } finally {
    if (timer) clearTimeout(timer)
    abort.abort()
    try { q?.close?.() } catch { /* already gone */ }
  }
}
