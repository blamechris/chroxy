/**
 * #7726 (CDX-2) — the codex model catalog, sourced from the app-server's OWN
 * `model/list` instead of a frozen six-row literal.
 *
 * `codex-session.js` shipped `CODEX_MODEL_METADATA` (gpt-5-codex, gpt-5,
 * gpt-4.1, gpt-4o, o1, o3) as the roster for the picker. The binary on this
 * machine today serves `gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna,
 * gpt-5.5, gpt-5.3-codex-spark` — not one of which is in that literal. The
 * hand-maintained list is demoted here to a CATALOGUED label/window seed; the
 * binary's answer is the roster.
 *
 * Three properties hold this module's shape, and each one is a test:
 *
 *   1. UNSET IS NOT EMPTY. `UNSET` means "we have no answer" — never probed,
 *      the probe failed, the file could not be read, the body did not parse.
 *      An empty ARRAY / empty Map means "we asked and there is nothing there".
 *      Collapsing the two is recorded cause #2 in docs/false-safety-guards.md:
 *      could-not-fetch and provider-has-no-models become the same observable,
 *      and a wedged probe silently empties the picker.
 *   2. REPLACE, NEVER UNION. A successful catalog REPLACES the previous one.
 *      A union means a retired model never dies (the rule
 *      `anthropic-compatible-session.js` establishes). The operator overlay
 *      (`~/.chroxy/models.json`) is the safety net, not a stale row.
 *   3. FAILURE NEVER CLEARS. Every failure path returns null and leaves the
 *      stored catalog exactly as it was. `applyCodexCatalog` is reached ONLY
 *      from a parsed, well-shaped response.
 *
 * Protocol facts (observed against live codex-cli 0.154.0 — the raw responses
 * are recorded on epic #7721, comment 5644101381):
 *
 *   - `model/list` takes `{cursor?, limit?, includeHidden?}` and answers
 *     `{data: Model[], nextCursor}`. Each Model carries `id`, `model` (slug),
 *     `displayName`, `description`, `hidden`, `isDefault`,
 *     `supportedReasoningEfforts: [{reasoningEffort, description}]`,
 *     `defaultReasoningEffort`, `inputModalities`, `serviceTiers`.
 *   - It carries NO context window. The only in-protocol source is
 *     `thread/tokenUsage/updated.tokenUsage.modelContextWindow`, which does not
 *     arrive until the first turn — hence the best-effort read of the Codex
 *     CLI's own `models_cache.json` below, and `contextWindow: null` (never a
 *     fabricated number) when that read comes up empty.
 *   - An UNKNOWN method answers JSON-RPC `-32600` ("unknown variant"), NOT
 *     `-32601`. Nothing here switches on a code or on message text: the probe
 *     goes through `probeMethod`, which degrades on ANY error (#7724).
 *   - The spawn argv is the literal `['app-server']`. Every knob is a JSON-RPC
 *     param; no capability here adds a CLI flag.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createLogger } from './logger.js'
import { probeMethod } from './codex-protocol-capabilities.js'
import { CodexAppServerClient } from './codex-app-server-client.js'
import { refreshDiscoveredModels } from './model-discovery.js'

const log = createLogger('codex-model-catalog')

/**
 * "No answer" — distinct from an empty roster / an empty window table.
 *
 * A Symbol rather than `null` or `[]` on purpose: it cannot be spread,
 * iterated, `.length`-ed or truthiness-tested into silently behaving like an
 * empty collection, so a caller that forgets to handle it fails loudly instead
 * of quietly reporting zero.
 */
export const UNSET = Symbol('chroxy.codex-model-catalog.UNSET')

/** The app-server method this module asks. */
export const CODEX_CATALOG_METHOD = 'model/list'

/**
 * Bound on the whole no-session probe (spawn + handshake + `model/list`) —
 * ONE deadline computed once in `probeCodexCatalog` and split across the two
 * requests, not this value applied to each of them (#7757 review).
 * A wedged binary must not hold the create-session path open: on timeout the
 * probe returns null and the PREVIOUS catalog stands.
 */
export const CODEX_CATALOG_PROBE_TIMEOUT_MS = 5000

/**
 * TTL for the shared discovery slot in `model-discovery.js` — success AND
 * failure. A dashboard reconnect burst therefore spawns at most one probe per
 * window instead of one per client.
 */
export const CODEX_CATALOG_TTL_MS = 5 * 60_000

/** Discovery slot id (the `model-discovery.js` per-entry cache key). */
export const CODEX_CATALOG_DISCOVERY_ID = 'codex'

/** Filename of the Codex CLI's own cache, under `$CODEX_HOME`. */
export const CODEX_MODELS_CACHE_FILE = 'models_cache.json'

// --- per-process state -------------------------------------------------------
// One catalog per process, exactly like the per-registered-provider closure in
// anthropic-compatible-session.js. `UNSET` until a probe succeeds.
let _catalog = UNSET

/** @returns {typeof UNSET | ReadonlyArray<Object>} the raw catalog state. */
export function getCodexCatalog() {
  return _catalog
}

/**
 * 'unset' (no answer yet) | 'empty' (asked, zero models) | 'populated'.
 * Exists so a caller can tell the two zero-row cases apart without
 * reimplementing the sentinel check.
 */
export function getCodexCatalogState() {
  if (_catalog === UNSET) return 'unset'
  return _catalog.length === 0 ? 'empty' : 'populated'
}

/** The catalog rows, or `[]` when UNSET. Convenience for row consumers. */
export function getCodexCatalogRows() {
  return _catalog === UNSET ? [] : _catalog
}

/** True only when a catalog was fetched AND it has at least one row. */
export function hasCodexCatalog() {
  return _catalog !== UNSET && _catalog.length > 0
}

/** One catalog row by model id, or null. */
export function getCodexCatalogRow(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return null
  for (const row of getCodexCatalogRows()) {
    if (row.id === modelId) return row
  }
  return null
}

/**
 * REPLACE the catalog. Accepts either a row array or the
 * `{models, pricing}` catalog shape `model-discovery.js` hands its
 * `applyCatalog` sink, so it drops straight in as that hook.
 *
 * A non-array argument is IGNORED (returns false) — "I could not read this"
 * must never clear a good catalog. Zero rows IS applied: that is the provider
 * answering with an empty roster, which `getCodexCatalogState()` then reports
 * as 'empty' rather than 'unset'.
 *
 * @returns {boolean} true when the catalog was replaced.
 */
export function applyCodexCatalog(catalog) {
  const rows = Array.isArray(catalog) ? catalog : catalog?.models
  if (!Array.isArray(rows)) {
    log.debug('applyCodexCatalog: ignoring a non-array catalog (previous catalog kept)')
    return false
  }
  _catalog = Object.freeze(rows.map((r) => Object.freeze({ ...r })))
  return true
}

/** Test hook: drop the per-process catalog back to UNSET. */
export function _resetCodexCatalogForTests() {
  _catalog = UNSET
}

// --- parsing -----------------------------------------------------------------

function firstNonEmptyString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return null
}

/**
 * `supportedReasoningEfforts: [{reasoningEffort, description}]` → the effort
 * strings, de-duplicated and order-preserved. `ReasoningEffort` is a non-empty
 * STRING in the app-server schema, not an enum (six values already in the wild:
 * low / medium / high / xhigh / max / ultra), so nothing is validated against a
 * fixed list here — a hardcoded list beside a growing set is this repo's #1
 * recurring defect.
 *
 * @returns {ReadonlyArray<string>|null} null when there is nothing usable,
 *   so `withModelMetadata` (models.js) leaves the key ABSENT rather than
 *   putting an empty array on the wire.
 */
export function parseReasoningLevels(supportedReasoningEfforts) {
  if (!Array.isArray(supportedReasoningEfforts)) return null
  const out = []
  const seen = new Set()
  for (const e of supportedReasoningEfforts) {
    // Tolerate both the object form the protocol uses and a bare string, so a
    // future flattening of the field does not read as "no levels".
    const level = typeof e === 'string' ? firstNonEmptyString(e) : firstNonEmptyString(e?.reasoningEffort)
    if (!level || seen.has(level)) continue
    seen.add(level)
    out.push(level)
  }
  return out.length > 0 ? Object.freeze(out) : null
}

/**
 * Normalize a `model/list` RESULT into catalog rows.
 *
 * @returns {Array<Object>|null} null when the body is not the documented
 *   envelope (`{data: [...]}`) — a CANNOT-PARSE, which the caller must treat
 *   as "no catalog", never as a zero-model roster. `{data: []}` is a parse
 *   SUCCESS with zero rows: the provider said it has none.
 */
export function parseModelListResult(result) {
  const data = result?.data
  if (!Array.isArray(data)) return null
  const rows = []
  const seen = new Set()
  for (const m of data) {
    if (!m || typeof m !== 'object') continue
    // Belt and braces with `includeHidden: false` on the request: the CLI cache
    // carries hidden entries (e.g. `codex-auto-review`) that must not reach the
    // picker even if a future default flips.
    if (m.hidden === true) continue
    // `model` is the slug `thread/start` accepts; `id` is the catalog key. They
    // are equal on every row observed, but the slug is what gets SENT, so it
    // wins when they differ.
    const id = firstNonEmptyString(m.model, m.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    rows.push({
      id,
      label: firstNonEmptyString(m.displayName) || id,
      description: firstNonEmptyString(m.description) || '',
      reasoningLevels: parseReasoningLevels(m.supportedReasoningEfforts),
      defaultReasoningLevel: firstNonEmptyString(m.defaultReasoningEffort),
      isDefault: m.isDefault === true,
    })
  }
  return rows
}

// --- the Codex CLI's own cache (context windows only) ------------------------

/** `$CODEX_HOME`, else `~/.codex`. */
export function codexHomeDir(env = process.env) {
  const fromEnv = typeof env?.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  return fromEnv.length > 0 ? fromEnv : join(homedir(), '.codex')
}

/**
 * Best-effort, READ-ONLY read of `$CODEX_HOME/models_cache.json` for the one
 * thing `model/list` does not carry: a context window per slug.
 *
 * This file is the Codex CLI's own unversioned private cache. Every rule below
 * follows from that:
 *   - it is NEVER written, and its `auth.json` sibling is never touched;
 *   - every field is optional — a row without an integer `context_window` is
 *     skipped rather than defaulted;
 *   - any failure (absent, unreadable, not JSON, wrong shape) is a CANNOT-CHECK
 *     and returns UNSET, never an empty Map. An empty Map means the file parsed
 *     and held no usable window, which is a different fact.
 *
 * @returns {Map<string, number> | typeof UNSET}
 */
export function readCodexModelsCacheWindows({ env = process.env, readFileFn = readFileSync } = {}) {
  const path = join(codexHomeDir(env), CODEX_MODELS_CACHE_FILE)
  let raw
  try {
    raw = readFileFn(path, 'utf-8')
  } catch (err) {
    log.debug(`codex models cache not readable at ${path} (${err?.code || err?.message || err})`)
    return UNSET
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.debug(`codex models cache at ${path} is not JSON (${err?.message || err})`)
    return UNSET
  }
  const models = parsed?.models
  if (!Array.isArray(models)) {
    log.debug(`codex models cache at ${path} has no models array`)
    return UNSET
  }
  const windows = new Map()
  for (const m of models) {
    if (!m || typeof m !== 'object') continue
    const slug = firstNonEmptyString(m.slug)
    const cw = m.context_window
    if (!slug || !Number.isInteger(cw) || cw <= 0) continue
    if (!windows.has(slug)) windows.set(slug, cw)
  }
  return windows
}

/**
 * Stamp a context window onto each row from `windows`.
 *
 * `contextWindow` is the cache's value or `null` — NEVER a fabricated number,
 * and never inherited from a same-named static row. models.js preserves an
 * explicit null instead of substituting DEFAULT_CONTEXT_WINDOW, so the
 * dashboard omits the chip rather than showing an invented 200k (#5418/#5444).
 *
 * @param {Array<Object>} rows
 * @param {Map<string, number> | typeof UNSET} windows
 */
export function stampContextWindows(rows, windows) {
  const table = windows instanceof Map ? windows : null
  return rows.map((r) => {
    const cw = table?.get(r.id)
    return {
      ...r,
      fullId: r.id,
      contextWindow: Number.isInteger(cw) && cw > 0 ? cw : null,
      provenance: 'discovered',
    }
  })
}

// --- probing -----------------------------------------------------------------

/**
 * Reject after `ms` instead of hanging forever on a wedged child.
 *
 * The timer is deliberately NOT unref'd. An unref'd timer does not keep the
 * event loop alive, so in the one situation this guard exists for — a request
 * that never settles and nothing else pending — the loop would drain and the
 * timeout would never fire. That is a guard whose two states are "unnecessary"
 * and "silent", never "fired". It is cleared on settle in BOTH directions, so
 * the longest it can hold anything open is `ms`.
 */
function withTimeout(promise, ms, label) {
  if (!(typeof ms === 'number' && ms > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`codex ${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** Wrap a client so every request it serves is bounded by `timeoutMs`. */
function timeBounded(client, timeoutMs) {
  return { request: (method, params) => withTimeout(client.request(method, params), timeoutMs, method) }
}

/**
 * Ask a LIVE app-server client for its model roster.
 *
 * @returns {Promise<Array<Object>|null>} rows, or null on ANY failure — an
 *   unknown method, a transport error, a timeout, or a body that is not the
 *   documented envelope. null means "no catalog"; the caller keeps whatever it
 *   already had.
 */
export async function fetchCodexCatalogFromClient(client, { timeoutMs = CODEX_CATALOG_PROBE_TIMEOUT_MS, includeHidden = false } = {}) {
  if (!client || typeof client.request !== 'function') return null
  const probe = await probeMethod(timeBounded(client, timeoutMs), CODEX_CATALOG_METHOD, { includeHidden })
  if (!probe.supported) {
    // ANY error degrades, and identically: the live binary answers an unknown
    // method with -32600, not -32601, so nothing may branch on the code (it is
    // logged only) or on the wording. The PREVIOUS catalog stands.
    log.debug(`${CODEX_CATALOG_METHOD} unavailable (jsonRpcCode=${probe.code ?? 'none'}): ${probe.error?.message || probe.error}`)
    return null
  }
  const rows = parseModelListResult(probe.result)
  if (rows === null) {
    // Valid JSON, wrong shape. This is a CANNOT-PARSE, not an empty roster —
    // returning [] here would empty the picker on a protocol change.
    log.warn(`${CODEX_CATALOG_METHOD} returned an unexpected shape (no 'data' array); keeping the previous catalog`)
    return null
  }
  return rows
}

/** Default factory — one place the short-lived probe client is constructed. */
function defaultCreateClient(opts) {
  return new CodexAppServerClient(opts)
}

/**
 * Spawn a SHORT-LIVED app-server, ask it for the roster, kill it.
 *
 * This is the no-session path: the dashboard asks for `available_models`
 * before any codex session exists (and session-manager's create-session
 * validation runs there too), so there is no live client to borrow. The child
 * is always killed, including on every failure path.
 *
 * The spawn argv is NOT built here — `CodexAppServerClient.initialize()` owns
 * the literal `['app-server']`, and no parameter this module passes may become
 * a CLI flag.
 *
 * `bin` and `env` accept a FUNCTION as well as a value (#7757 review). Codex's
 * `bin` is `CodexSession.resolvedBinary`, a getter that re-runs a SYNCHRONOUS
 * `execFileSync('which', …)` on every read by design (#6708), and `refreshModels`
 * is called on the post-auth `available_models` path for the default provider —
 * so resolving it eagerly spawned a blocking child on every push, including the
 * calls that carry a live client (no spawn at all) and the ones the TTL gate
 * drops immediately. A thunk is only called on the branch that actually spawns.
 *
 * @returns {Promise<Array<Object>|null>}
 */
export async function probeCodexCatalog({ bin, cwd, env, createClient = defaultCreateClient, timeoutMs = CODEX_CATALOG_PROBE_TIMEOUT_MS, includeHidden = false, now = Date.now } = {}) {
  const resolvedBin = typeof bin === 'function' ? bin() : bin
  if (typeof resolvedBin !== 'string' || resolvedBin.length === 0) {
    log.debug('codex catalog probe skipped: no codex binary resolved')
    return null
  }
  let client = null
  try {
    const resolvedEnv = typeof env === 'function' ? env() : env
    client = createClient({ bin: resolvedBin, cwd, env: resolvedEnv, logger: log })
    // ONE deadline across both requests. `timeoutMs` bounds the whole probe,
    // as CODEX_CATALOG_PROBE_TIMEOUT_MS's comment says it does; applying it
    // per-request (which is what this did) let a slow handshake plus a wedged
    // `model/list` hold a spawned child for ~2x the stated budget — the
    // comment-claims-more-than-the-code class (#7290/#7291) this PR is careful
    // about elsewhere.
    const bounded = typeof timeoutMs === 'number' && timeoutMs > 0
    const deadline = bounded ? now() + timeoutMs : null
    await withTimeout(client.initialize({ name: 'chroxy', version: '1' }), timeoutMs, 'initialize')
    // Never 0 or negative: withTimeout treats those as "no bound at all", which
    // would turn an ALREADY-EXHAUSTED budget into an unbounded second request.
    const remainingMs = bounded ? Math.max(1, deadline - now()) : timeoutMs
    return await fetchCodexCatalogFromClient(client, { timeoutMs: remainingMs, includeHidden })
  } catch (err) {
    log.debug(`codex catalog probe failed: ${err?.message || err}`)
    return null
  } finally {
    try { client?.kill() } catch { /* already gone */ }
  }
}

/**
 * The `fetchCatalog` adapter `model-discovery.js` drives: resolve rows (from a
 * live client when one is supplied, otherwise a short-lived probe), enrich them
 * with context windows, and return the `{models, pricing}` catalog shape.
 *
 * @returns {Promise<{models: Array<Object>, pricing: Object}|null>}
 */
export async function fetchCodexCatalog(opts = {}) {
  const rows = opts.client
    ? await fetchCodexCatalogFromClient(opts.client, opts)
    : await probeCodexCatalog(opts)
  if (rows === null) return null
  // `cacheEnv`, NOT `env`: `env` is the CHILD's spawn environment (buildSpawnEnv),
  // which is filtered and would silently point this read at a different
  // $CODEX_HOME than the daemon's own. The cache read is the daemon's, so it
  // defaults to process.env and takes its own explicit override.
  const windows = opts.windows !== undefined
    ? opts.windows
    : readCodexModelsCacheWindows({ env: opts.cacheEnv, readFileFn: opts.readFileFn })
  return { models: stampContextWindows(rows, windows), pricing: {} }
}

/**
 * Refresh the codex catalog and feed the result into the codex models
 * registry, riding the shared per-entry slot in `model-discovery.js` — one
 * in-flight probe at a time, TTL-cached across successes AND failures, and
 * `applyCatalog` published BEFORE `updateModels` so the registry's
 * `getModelMetadata` lookups already see the discovered rows.
 *
 * Resolves to the refreshed model list when the picker CHANGED, else null —
 * the `refreshOllamaModels` / `refreshDiscoveredModels` contract that
 * `scheduleProviderModelsRefresh` (ws-history.js) expects.
 *
 * `deps` supplies SEAMS ONLY (client / createClient / registry / now / ttlMs /
 * timeoutMs / windows / bin / cwd / env). The structural keys below are set
 * AFTER the spread on purpose (#7757 review): `id`, `applyCatalog` and
 * `fetchCatalog` are the discovery slot's identity, its SINK and its SOURCE —
 * the source spawns a child process — so no caller may redirect them by
 * passing a key of the same name.
 */
export function refreshCodexModels(deps = {}) {
  return refreshDiscoveredModels({
    ...deps,
    id: CODEX_CATALOG_DISCOVERY_ID,
    ttlMs: typeof deps.ttlMs === 'number' ? deps.ttlMs : CODEX_CATALOG_TTL_MS,
    applyCatalog: applyCodexCatalog,
    fetchCatalog: fetchCodexCatalog,
    // #7757 review (Copilot): codex's catalog sink tells UNSET from empty, so
    // it wants the zero-row answer recorded rather than collapsed into the
    // failed-fetch no-op. Nothing is broadcast either way.
    publishEmptyCatalog: true,
  })
}
