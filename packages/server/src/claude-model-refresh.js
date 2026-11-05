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
 * `claude` binary. The prompt is an async iterable that never yields, so WE
 * send no user turn; the only traffic we write is the SDK's initialize control
 * request, whose answer is `supportedModels()`. `persistSession: false` and
 * `settingSources: []` keep it from writing a transcript or loading the user's,
 * project's or local settings.
 *
 * Startup is made inert as far as the pinned SDK (0.2.141) allows, because
 * `settingSources: []` does NOT cover managed settings, global `~/.claude.json`
 * config or Claude.ai MCP connectors, and a SessionStart hook can return
 * `initialUserMessage`, which the CLI turns into a user turn on its own:
 *   - `settings: { disableAllHooks: true }`  (`--settings`) — no hooks / statusLine
 *   - `strictMcpConfig: true` + `mcpServers: {}` — only the (empty) --mcp-config
 *     is read, so no configured or connector MCP server starts
 *   - `tools: []` (`--tools ""`) — no built-in tool exists to call
 *   - `permissionMode: 'dontAsk'` — anything not pre-approved is denied
 *   - `maxTurns: 1` — even an injected turn is a single bounded turn
 * Residual risk, stated honestly: a managed-policy hook is NOT disabled by a
 * non-managed `disableAllHooks`. File-based managed policy (hooks or
 * managed-mcp.json under the platform's ClaudeCode directory) is detected and
 * the probe is SKIPPED with a log line. MDM / registry / remote-managed policy
 * and plugin-supplied hooks cannot be seen from here, so "no tokens" is a
 * guarantee about what chroxy sends, not an unconditional one about what a
 * hostile-or-unusual policy makes `claude` do on its own; the bounds above
 * (no tools, no MCP, one turn, denied permissions) cap what that can cost.
 *
 * Lifecycle: the child is spawned through the SDK's `spawnClaudeCodeProcess`
 * so this module owns it until a CONFIRMED exit. (The SDK's own cleanup sends
 * SIGTERM on abort, which sets `killed`, and its transport `close()` then skips
 * the TERM→KILL escalation for a child that ignores SIGTERM.) Cleanup is
 * close() → TERM → bounded wait → KILL → bounded wait, independent of
 * `killed`, and `inFlight` stays set until it completes. `stopClaudeModelRefresh`
 * (called from `SessionManager.destroyAll`, which every shutdown path runs)
 * cancels a running probe, SIGKILLs its child synchronously and latches the
 * module so no later client connect can start another.
 *
 * Contract: best-effort and bounded. Every failure (no binary, refused by the
 * provenance gate, SDK throw, timeout, empty answer) returns null and leaves
 * the registry and cache file as they were. At most one refresh runs at a time
 * and a refresh is attempted at most once per `minIntervalMs`, because the
 * trigger (a client connecting) fires far more often than claude changes.
 * `CHROXY_DISABLE_MODEL_REFRESH=1` turns it off (the test harness sets it).
 */

import { tmpdir, platform as osPlatform } from 'os'
import { spawn as nodeSpawn } from 'child_process'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
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

export const TERM_GRACE_MS = 2_000
export const KILL_WAIT_MS = 2_000

/** An input stream that never yields: the query starts but no turn is sent. */
function idlePrompt(signal) {
  return {
    async *[Symbol.asyncIterator]() {
      if (signal.aborted) return
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    },
  }
}

/** Where the pinned claude reads managed (policy) settings from, per platform. */
export function managedSettingsDir(plat = osPlatform()) {
  if (plat === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (plat === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

function hasEntries(v) {
  if (Array.isArray(v)) return v.length > 0
  return v != null && typeof v === 'object' && Object.keys(v).length > 0
}

/**
 * File-based managed policy that `disableAllHooks` / `strictMcpConfig` cannot
 * switch off from a non-managed source. Returns a reason string, or null when
 * none is visible. An existing file that cannot be read or parsed counts as a
 * reason: "cannot check" must not read as "nothing to check". MDM, registry and
 * remote-managed policy are not visible here (see the module comment).
 * @param {string} [dir]
 * @returns {string|null}
 */
export function managedPolicyBlockingProbe(dir = managedSettingsDir()) {
  const files = []
  try {
    for (const name of readdirSync(join(dir, 'managed-settings.d')).sort()) {
      if (name.endsWith('.json') && !name.startsWith('.')) files.push(join(dir, 'managed-settings.d', name))
    }
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return `cannot list ${join(dir, 'managed-settings.d')}: ${err?.code || err}`
  }
  files.unshift(join(dir, 'managed-settings.json'))
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') continue
      return `cannot read ${file}: ${err?.code || err}`
    }
    let parsed
    try { parsed = JSON.parse(text) } catch { return `cannot parse ${file}` }
    if (hasEntries(parsed?.hooks)) return `managed hooks in ${file}`
  }
  try {
    readFileSync(join(dir, 'managed-mcp.json'))
    return `managed MCP servers in ${join(dir, 'managed-mcp.json')}`
  } catch (err) {
    if (err?.code !== 'ENOENT') return `cannot read ${join(dir, 'managed-mcp.json')}: ${err?.code || err}`
  }
  return null
}

let inFlight = null
let active = null
let stopped = false
let lastAttemptAt = -Infinity

/** Test seam: forget the throttle, the stop latch and any in-flight refresh. */
export function _resetClaudeModelRefreshForTests() {
  inFlight = null
  active = null
  stopped = false
  lastAttemptAt = -Infinity
}

/**
 * Daemon shutdown: cancel a running probe, SIGKILL its child now (nothing in it
 * is worth a grace period: it holds no state and persists nothing) and refuse
 * every later refresh. Resolves once the child is confirmed gone (or the
 * bounded cleanup gave up). Safe to call repeatedly and when nothing runs.
 * @returns {Promise<void>}
 */
export function stopClaudeModelRefresh() {
  stopped = true
  const run = active
  if (!run) return Promise.resolve()
  run.killNow()
  return (inFlight || Promise.resolve()).then(() => undefined)
}

/**
 * @param {object} deps
 * @param {() => string} deps.bin - returns the VERIFIED claude path; may throw
 * @param {Function} [deps.queryFn] - SDK `query` (test seam)
 * @param {Function} [deps.spawnFn] - child_process.spawn (test seam)
 * @param {string|null} [deps.managedDir] - managed-settings dir (test seam)
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.termGraceMs]
 * @param {number} [deps.killWaitMs]
 * @param {number} [deps.minIntervalMs]
 * @param {() => number} [deps.now]
 * @param {boolean} [deps.force] - ignore the throttle
 * @returns {Promise<object[]|null>} the converted roster, or null (skipped / failed)
 */
export function refreshClaudeModels(deps = {}) {
  const {
    bin,
    queryFn = sdkQuery,
    spawnFn = nodeSpawn,
    managedDir = managedSettingsDir(),
    timeoutMs = REFRESH_TIMEOUT_MS,
    termGraceMs = TERM_GRACE_MS,
    killWaitMs = KILL_WAIT_MS,
    minIntervalMs = REFRESH_MIN_INTERVAL_MS,
    now = Date.now,
    force = false,
  } = deps
  if (stopped) return Promise.resolve(null)
  if (inFlight) return inFlight
  // Operator/harness opt-out. An injected `queryFn` is a test double that can
  // spawn nothing, so it is exempt: the module's own tests exercise the path.
  if (process.env.CHROXY_DISABLE_MODEL_REFRESH === '1' && !deps.queryFn) return Promise.resolve(null)
  if (!force && now() - lastAttemptAt < minIntervalMs) return Promise.resolve(null)
  lastAttemptAt = now()
  const run = { killNow: () => {} }
  active = run
  inFlight = runRefresh({ bin, queryFn, spawnFn, managedDir, timeoutMs, termGraceMs, killWaitMs, run })
    .finally(() => { inFlight = null; if (active === run) active = null })
  return inFlight
}

/** Follow a spawned child so its exit can be awaited and signalled. */
function trackChild(child) {
  const track = { child, exited: child.exitCode != null || child.signalCode != null, waiters: [] }
  const onGone = () => {
    track.exited = true
    for (const w of track.waiters.splice(0)) w()
  }
  child.once('exit', onGone)
  // A spawn failure emits 'error' with no 'exit'; there is nothing to wait for.
  child.once('error', () => { if (child.pid == null) onGone() })
  return track
}

/**
 * Drive the child to a CONFIRMED exit: EOF on stdin, SIGTERM, a bounded wait,
 * SIGKILL, a bounded wait. Never consults `child.killed`: a child that has
 * already been sent SIGTERM and ignored it is exactly the case to escalate.
 */
function confirmExit(track, { termGraceMs, killWaitMs }) {
  if (!track || track.exited) return Promise.resolve()
  const { child } = track
  return new Promise((resolve) => {
    let killTimer = null
    let giveUpTimer = null
    const finish = () => {
      clearTimeout(killTimer)
      clearTimeout(giveUpTimer)
      resolve()
    }
    track.waiters.push(finish)
    try { child.stdin?.end() } catch { /* already closed */ }
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      giveUpTimer = setTimeout(() => {
        log.warn(`Claude model refresh child (pid ${child.pid}) did not exit after SIGKILL`)
        finish()
      }, killWaitMs)
    }, termGraceMs)
  })
}

async function runRefresh({ bin, queryFn, spawnFn, managedDir, timeoutMs, termGraceMs, killWaitMs, run }) {
  const abort = new AbortController()
  let q = null
  let timer = null
  let track = null
  // Built first so a stop() that lands while the binary is still being verified
  // is seen: `killNow` rejects this, and the race below (or the check after the
  // gate) turns it into a cancelled refresh instead of a started child.
  let stoppedEarly = false
  let rejectCancelled
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject })
  cancelled.catch(() => {}) // never raced after the probe settles: not an unhandled rejection
  run.killNow = () => {
    stoppedEarly = true
    try { track?.child.kill('SIGKILL') } catch { /* already gone */ }
    rejectCancelled(new Error('cancelled: daemon shutting down'))
  }
  try {
    if (typeof bin !== 'function') return null
    const path = bin()
    if (!path) return null
    if (managedDir) {
      const blocked = managedPolicyBlockingProbe(managedDir)
      if (blocked) {
        log.info(`Skipping the session-less Claude model refresh: ${blocked} could still act at startup`)
        return null
      }
    }
    if (stoppedEarly) return null
    q = queryFn({
      prompt: idlePrompt(abort.signal),
      options: {
        cwd: tmpdir(),
        pathToClaudeCodeExecutable: path,
        env: buildSpawnEnv('claude-sdk'),
        settingSources: [],
        settings: { disableAllHooks: true },
        mcpServers: {},
        strictMcpConfig: true,
        tools: [],
        permissionMode: 'dontAsk',
        maxTurns: 1,
        persistSession: false,
        abortController: abort,
        // Own the child: no `signal` is handed to spawn (that would TERM it
        // behind our back and set `killed`); cleanup below decides.
        spawnClaudeCodeProcess: (o) => {
          const child = spawnFn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
          track = trackChild(child)
          return child
        },
      },
    })
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    const sdkModels = await Promise.race([q.supportedModels(), timeout, cancelled])
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
    // close() first: it ends stdin and detaches the SDK's abort handler, so the
    // abort below cannot send the SIGTERM that would hide the child from the
    // SDK's own escalation. Ours does not depend on it either way.
    try { q?.close?.() } catch { /* already gone */ }
    abort.abort()
    await confirmExit(track, { termGraceMs, killWaitMs })
  }
}
