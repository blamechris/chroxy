/**
 * statusLine — read the user's Claude Code `statusLine` command from their own
 * settings.json, execute it the way Claude Code does, and surface its stdout.
 *
 * Feature #6791. A user who has configured a `statusLine` script (git branch,
 * model, a cost tracker, …) sees none of it in Chroxy today; this module reads
 * the effective config and runs it so its output can be broadcast to clients.
 *
 * ── Trust + security model (this EXECUTES a shell command) ────────────────────
 * The command is ONLY ever the one in the user's OWN settings.json — the same
 * trust boundary Claude Code itself honours when it runs the script. There is
 * NO client-supplied command and NO client-supplied path: the settings files
 * are read from fixed, server-chosen locations only
 *   - <sessionCwd>/.claude/settings.json         (project — highest precedence)
 *   - ~/.claude/project-settings.json            (user project-settings)
 *   - ~/.claude/settings.json                    (user — lowest precedence)
 * (mirrors Claude Code's precedence — see docs.claude.com "statusline").
 * `sessionCwd` comes from the server's session record, never from the wire.
 *
 * Robustness hardening, none of which Claude Code documents but all of which a
 * long-lived daemon needs so a slow/hostile script can't wedge it:
 *   - strict TIMEOUT (default 5s) — SIGTERM then SIGKILL after a grace window;
 *   - stdout SIZE CAP (default 8 KB) — truncated, never buffered unbounded;
 *   - the session JSON is delivered on STDIN (the documented contract), never
 *     interpolated into the command string, so untrusted context can't inject;
 *   - chroxy's own daemon secrets are stripped from the child env (buildSpawnEnv);
 *   - non-zero exit / no output / timeout → blank (matches Claude Code), no crash;
 *   - no `statusLine` configured → silent no-op (feature simply inactive).
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createLogger } from './logger.js'
import { CHROXY_SECRET_DENYLIST } from './utils/spawn-env.js'

const log = createLogger('statusline')

/** Kill a script that runs longer than this (ms). */
export const STATUSLINE_DEFAULT_TIMEOUT_MS = 5_000
/** Hard cap on captured stdout+stderr bytes; output past this is truncated. */
export const STATUSLINE_MAX_OUTPUT_BYTES = 8 * 1024
/** SIGTERM → SIGKILL grace after a timeout / cap kill. */
export const STATUSLINE_HARD_KILL_GRACE_MS = 2_000
/** Floor between two spawns of the same session's script (debounce). */
export const STATUSLINE_MIN_REFRESH_INTERVAL_MS = 1_000
/** Periodic re-run cadence when the config gives no explicit `refreshInterval`. */
export const STATUSLINE_DEFAULT_REFRESH_INTERVAL_MS = 10_000
/** Ceiling for a configured `refreshInterval` so a tiny value can't hot-loop. */
export const STATUSLINE_MIN_CONFIGURED_INTERVAL_MS = 1_000
/** How long a resolved (or null) config is cached per cwd before a re-read. */
export const STATUSLINE_CONFIG_CACHE_TTL_MS = 5_000

/**
 * Settings files consulted for the effective `statusLine`, in Claude Code's
 * precedence order (first match wins). Every path is derived server-side from
 * the session cwd and the user home — none is client-supplied.
 *
 * @param {string} cwd     - session working directory (project scope)
 * @param {string} homeDir - user home directory (~/.claude scope)
 * @returns {string[]} absolute settings.json paths, highest precedence first
 */
export function statusLineSettingsPaths(cwd, homeDir) {
  const paths = []
  if (cwd) paths.push(join(cwd, '.claude', 'settings.json'))
  if (homeDir) {
    paths.push(join(homeDir, '.claude', 'project-settings.json'))
    paths.push(join(homeDir, '.claude', 'settings.json'))
  }
  return paths
}

/**
 * Extract a usable `statusLine` config from a parsed settings object, or null.
 * Only `type: "command"` with a non-empty string `command` is honoured — every
 * other shape (missing, wrong type, empty command) is treated as "not
 * configured" so a malformed entry is inert rather than throwing.
 *
 * @param {unknown} settings - parsed settings.json object
 * @returns {{command: string, refreshIntervalMs: number|null}|null}
 */
export function parseStatusLineConfig(settings) {
  if (!settings || typeof settings !== 'object') return null
  const sl = settings.statusLine
  if (!sl || typeof sl !== 'object') return null
  if (sl.type !== 'command') return null
  if (typeof sl.command !== 'string' || sl.command.trim() === '') return null

  // `refreshInterval` is documented in SECONDS (minimum 1). Absent → the
  // StatusLineManager periodic loop (see `_tick`) falls back to
  // STATUSLINE_DEFAULT_REFRESH_INTERVAL_MS rather than going event-driven-only;
  // we still apply a floor here so a tiny configured value can't spin the daemon.
  let refreshIntervalMs = null
  if (Number.isFinite(sl.refreshInterval) && sl.refreshInterval > 0) {
    refreshIntervalMs = Math.max(Math.floor(sl.refreshInterval * 1000), STATUSLINE_MIN_CONFIGURED_INTERVAL_MS)
  }
  return { command: sl.command, refreshIntervalMs }
}

/**
 * Build the JSON object Claude Code pipes to a `statusLine` command on stdin.
 * Chroxy populates every field it actually knows; fields it doesn't are OMITTED
 * (the contract allows absent fields — scripts already guard for them). Nothing
 * here is interpolated into the command — it is the stdin payload only.
 *
 * @param {object} ctx - server-side session context (see StatusLineManager)
 * @returns {object} the stdin JSON payload
 */
export function buildStatusLineInput(ctx = {}) {
  const input = {}
  if (ctx.cwd) input.cwd = ctx.cwd
  if (ctx.sessionId) input.session_id = ctx.sessionId
  if (ctx.sessionName) input.session_name = ctx.sessionName
  if (ctx.transcriptPath) input.transcript_path = ctx.transcriptPath
  if (ctx.version) input.version = ctx.version

  if (ctx.model && (ctx.model.id || ctx.model.displayName)) {
    input.model = {}
    if (ctx.model.id) input.model.id = ctx.model.id
    if (ctx.model.displayName) input.model.display_name = ctx.model.displayName
  }

  const currentDir = ctx.cwd || null
  const projectDir = ctx.projectDir || ctx.cwd || null
  if (currentDir || projectDir) {
    input.workspace = {}
    if (currentDir) input.workspace.current_dir = currentDir
    if (projectDir) input.workspace.project_dir = projectDir
  }

  if (ctx.outputStyle) input.output_style = { name: ctx.outputStyle }

  if (ctx.cost && typeof ctx.cost === 'object') {
    const cost = {}
    if (Number.isFinite(ctx.cost.totalCostUsd)) cost.total_cost_usd = ctx.cost.totalCostUsd
    if (Number.isFinite(ctx.cost.totalDurationMs)) cost.total_duration_ms = ctx.cost.totalDurationMs
    if (Number.isFinite(ctx.cost.totalApiDurationMs)) cost.total_api_duration_ms = ctx.cost.totalApiDurationMs
    if (Number.isFinite(ctx.cost.totalLinesAdded)) cost.total_lines_added = ctx.cost.totalLinesAdded
    if (Number.isFinite(ctx.cost.totalLinesRemoved)) cost.total_lines_removed = ctx.cost.totalLinesRemoved
    if (Object.keys(cost).length > 0) input.cost = cost
  }

  return input
}

/**
 * Default child env: the user's full environment (like Claude Code) minus
 * chroxy's own daemon secrets (the CHROXY_SECRET_DENYLIST — e.g. the primary
 * API_TOKEN) and ANTHROPIC_API_KEY, plus the COLUMNS/LINES the contract says to
 * set. Deliberately does NOT go through `buildSpawnEnv` / the credential store:
 * a status script needs no provider OAuth token, and injecting one would hit
 * the keychain on every periodic spawn (every ~10s) for no benefit.
 */
function defaultBuildEnv() {
  const env = { ...process.env }
  for (const key of [...CHROXY_SECRET_DENYLIST, 'ANTHROPIC_API_KEY']) delete env[key]
  env.COLUMNS = '80'
  env.LINES = '1'
  return env
}

/** setTimeout that never keeps the event loop alive (self-exit safety). */
function unrefTimer(fn, ms) {
  const t = setTimeout(fn, ms)
  if (typeof t.unref === 'function') t.unref()
  return t
}

/**
 * Execute a `statusLine` command once, feeding `input` (a JSON string) on stdin,
 * capturing stdout/stderr under a byte cap, and killing it if it exceeds
 * `timeoutMs`. Never throws — every failure folds into the returned result.
 *
 * Modeled on built-in-tools/bash-exec.js (same SIGTERM→SIGKILL grace + byte-cap
 * discipline) but pipes stdin and runs through the platform shell to match
 * Claude Code's own invocation: `/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on
 * Windows (COMSPEC — same precedent as `utils/win-spawn.js`'s `prepareSpawn`
 * and `platform.js`'s `defaultShell`), so statusLine also works on win32
 * instead of silently failing to spawn `/bin/sh`.
 *
 * @param {object}   opts
 * @param {string}   opts.command        - the shell command (user's own config)
 * @param {string}   opts.cwd            - working directory for the child
 * @param {string}   opts.input          - JSON string written to the child's stdin
 * @param {object}   [opts.env]          - child env (defaults to secret-stripped user env)
 * @param {number}   [opts.timeoutMs]
 * @param {number}   [opts.maxOutputBytes]
 * @param {Function} [opts.spawnFn]      - injectable spawn (tests)
 * @param {Function} [opts.setTimer]     - injectable setTimeout (tests)
 * @param {Function} [opts.clearTimer]   - injectable clearTimeout (tests)
 * @param {NodeJS.Platform} [opts.platform=process.platform] - override for tests
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number|null, signal:string|null, timedOut:boolean, truncated:boolean, durationMs:number, error:string|null}>}
 */
export async function runStatusLineCommand({
  command,
  cwd,
  input = '',
  env,
  timeoutMs = STATUSLINE_DEFAULT_TIMEOUT_MS,
  maxOutputBytes = STATUSLINE_MAX_OUTPUT_BYTES,
  spawnFn = spawn,
  setTimer = unrefTimer,
  clearTimer = clearTimeout,
  platform = process.platform,
} = {}) {
  const startedAt = Date.now()
  const base = { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, truncated: false, durationMs: 0, error: null }

  if (typeof command !== 'string' || command.trim() === '') {
    return { ...base, error: 'no command', durationMs: 0 }
  }

  let child
  try {
    const isWin = platform === 'win32'
    // Same shell-selection precedent as `utils/win-spawn.js#prepareSpawn` and
    // `platform.js#defaultShell`: Windows has no `/bin/sh`, so route through
    // COMSPEC (cmd.exe) with `/d` (skip AutoRun) `/s` (strip exactly the outer
    // quote pair) `/c` (run then exit) and `windowsVerbatimArguments` so Node
    // doesn't re-quote our already-quoted command line — mirrors Node's own
    // internal `{ shell: true }` behavior on win32.
    const shellCommand = isWin ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh'
    const shellArgs = isWin ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command]
    child = spawnFn(shellCommand, shellArgs, {
      cwd: cwd || process.cwd(),
      env: env || defaultBuildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(isWin ? { windowsVerbatimArguments: true } : {}),
    })
  } catch (err) {
    return { ...base, error: err?.message || 'spawn failed', durationMs: Date.now() - startedAt }
  }

  let stdout = ''
  let stderr = ''
  let totalBytes = 0
  let truncated = false
  let timedOut = false
  let hardKillTimer = null

  const killChild = (sig) => {
    if (!child || child.killed || child.exitCode !== null) return
    try {
      child.kill(sig)
    } catch {
      // already gone
    }
    if (sig === 'SIGTERM' && hardKillTimer === null) {
      hardKillTimer = setTimer(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        } catch {}
      }, STATUSLINE_HARD_KILL_GRACE_MS)
    }
  }

  const capture = (chunk, which) => {
    if (totalBytes >= maxOutputBytes) return
    const chunkBytes = chunk.length
    const remaining = maxOutputBytes - totalBytes
    if (chunkBytes > remaining) {
      const sliced = chunk.subarray(0, remaining).toString('utf8')
      if (which === 'stdout') stdout += sliced
      else stderr += sliced
      totalBytes += remaining
      truncated = true
      killChild('SIGTERM')
    } else {
      const text = chunk.toString('utf8')
      if (which === 'stdout') stdout += text
      else stderr += text
      totalBytes += chunkBytes
    }
  }

  child.stdout?.on('data', (c) => capture(c, 'stdout'))
  child.stderr?.on('data', (c) => capture(c, 'stderr'))

  // Feed the session JSON on stdin, then close it. A script that never reads
  // stdin makes the pipe error with EPIPE — swallow it (it is expected, not a
  // fault) so an unhandled 'error' can't crash the daemon.
  if (child.stdin) {
    child.stdin.on('error', () => {})
    try {
      child.stdin.end(input)
    } catch {
      // ignore — child may have exited before we wrote
    }
  }

  const timeoutHandle = setTimer(() => {
    timedOut = true
    killChild('SIGTERM')
  }, timeoutMs)

  const { code, sig, spawnError } = await new Promise((resolve) => {
    child.on('exit', (c, s) => resolve({ code: c, sig: s, spawnError: null }))
    child.on('error', (err) => resolve({ code: null, sig: null, spawnError: err }))
  })

  clearTimer(timeoutHandle)
  if (hardKillTimer !== null) clearTimer(hardKillTimer)

  return {
    stdout,
    stderr,
    exitCode: code,
    signal: sig,
    timedOut,
    truncated,
    durationMs: Date.now() - startedAt,
    error: spawnError ? (spawnError.message || 'spawn error') : null,
  }
}

/**
 * Reduce a raw execution result to the text a client should DISPLAY, following
 * Claude Code's rules: non-zero exit, no output, a timeout, or a spawn error
 * all render blank (empty string). Trailing whitespace is trimmed; the ANSI in
 * the payload is left intact for the renderer to strip/interpret.
 *
 * @param {object} result - a runStatusLineCommand result
 * @returns {string} the display text ('' == blank)
 */
export function statusLineDisplayText(result) {
  if (!result || result.error || result.timedOut) return ''
  if (result.exitCode !== 0) return ''
  const text = (result.stdout || '').replace(/\s+$/, '')
  return text
}

/**
 * Orchestrates statusLine reads/execs for live sessions and emits an `output`
 * event ({ sessionId, active, text, truncated, timedOut, exitCode }) whenever a
 * session's rendered status text CHANGES. Owns all timers (each unref'd + cleared
 * on stopSession/stopAll) so the daemon can self-exit and tests leak nothing.
 *
 * Every side-effecting dependency (spawn, timers, clock, file read, env) is
 * injectable so the whole thing is deterministic under test.
 */
export class StatusLineManager extends EventEmitter {
  constructor({
    homeDir = homedir(),
    readFileFn = readFile,
    spawnFn = spawn,
    buildEnv = defaultBuildEnv,
    now = Date.now,
    setTimer = unrefTimer,
    clearTimer = clearTimeout,
    timeoutMs = STATUSLINE_DEFAULT_TIMEOUT_MS,
    maxOutputBytes = STATUSLINE_MAX_OUTPUT_BYTES,
    minRefreshIntervalMs = STATUSLINE_MIN_REFRESH_INTERVAL_MS,
    defaultRefreshIntervalMs = STATUSLINE_DEFAULT_REFRESH_INTERVAL_MS,
    configCacheTtlMs = STATUSLINE_CONFIG_CACHE_TTL_MS,
  } = {}) {
    super()
    this._homeDir = homeDir
    this._readFileFn = readFileFn
    this._spawnFn = spawnFn
    this._buildEnv = buildEnv
    this._now = now
    this._setTimer = setTimer
    this._clearTimer = clearTimer
    this._timeoutMs = timeoutMs
    this._maxOutputBytes = maxOutputBytes
    this._minRefreshIntervalMs = minRefreshIntervalMs
    this._defaultRefreshIntervalMs = defaultRefreshIntervalMs
    this._configCacheTtlMs = configCacheTtlMs

    /** @type {Map<string, {config: object|null, expiresAt: number}>} keyed by cwd */
    this._configCache = new Map()
    /** @type {Map<string, {getContext: Function, timer: any, lastRunAt: number, running: boolean, lastText: string|null}>} */
    this._sessions = new Map()
    this._stopped = false
  }

  /**
   * Resolve the effective statusLine config for a cwd (project > project-settings
   * > user; first match wins), cached per cwd with a short TTL. Returns null when
   * no location configures a usable command. Never throws — a missing/malformed
   * settings file is skipped.
   *
   * @param {string} cwd
   * @returns {Promise<{command:string, refreshIntervalMs:number|null}|null>}
   */
  async resolveConfig(cwd) {
    const cached = this._configCache.get(cwd)
    if (cached && cached.expiresAt > this._now()) return cached.config

    let config = null
    for (const path of statusLineSettingsPaths(cwd, this._homeDir)) {
      let raw
      try {
        raw = await this._readFileFn(path, 'utf8')
      } catch {
        continue // file absent / unreadable — try the next scope
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue // malformed JSON — skip this scope, don't fail the whole read
      }
      const found = parseStatusLineConfig(parsed)
      if (found) {
        config = found
        break
      }
    }

    this._configCache.set(cwd, { config, expiresAt: this._now() + this._configCacheTtlMs })
    return config
  }

  /** Drop any cached config (e.g. session ended) so a re-read is forced. */
  invalidateConfig(cwd) {
    this._configCache.delete(cwd)
  }

  /**
   * Run the configured script once for a context and return the raw result plus
   * `active` (false == no statusLine configured for this cwd). Does not emit or
   * throttle — that's `refresh`.
   *
   * @param {object} ctx - session context (must include `cwd`)
   * @returns {Promise<{active:boolean, text:string, result:object|null}>}
   */
  async run(ctx) {
    const config = await this.resolveConfig(ctx?.cwd)
    if (!config) return { active: false, text: '', result: null }

    let env
    try {
      env = this._buildEnv()
    } catch (err) {
      log.warn(`statusLine env build failed: ${err?.message || err}`)
      env = undefined
    }

    const result = await runStatusLineCommand({
      command: config.command,
      cwd: ctx.cwd,
      input: JSON.stringify(buildStatusLineInput(ctx)),
      env,
      timeoutMs: this._timeoutMs,
      maxOutputBytes: this._maxOutputBytes,
      spawnFn: this._spawnFn,
      setTimer: this._setTimer,
      clearTimer: this._clearTimer,
    })
    return { active: true, text: statusLineDisplayText(result), result }
  }

  /**
   * Throttled single-shot refresh for a session: skips if a run is already in
   * flight or the last run was under the debounce floor (unless `force`), runs
   * the script, and emits `output` only when the rendered text CHANGED. Clearing
   * (config removed after prior output) emits once with an empty string.
   *
   * @param {string} sessionId
   * @param {object} ctx - session context (must include `cwd`)
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<{active:boolean, text:string, emitted:boolean}|null>} null == skipped
   */
  async refresh(sessionId, ctx, { force = false } = {}) {
    if (this._stopped) return null
    let session = this._sessions.get(sessionId)
    if (!session) {
      // Refresh for a session we aren't tracking a loop for is still valid
      // (event-driven trigger before startSession); create a lightweight record.
      session = { getContext: null, timer: null, lastRunAt: 0, running: false, lastText: null }
      this._sessions.set(sessionId, session)
    }
    if (session.running) return null
    if (!force && session.lastRunAt && (this._now() - session.lastRunAt) < this._minRefreshIntervalMs) {
      return null
    }

    session.running = true
    session.lastRunAt = this._now()
    let outcome
    try {
      outcome = await this.run(ctx)
    } catch (err) {
      log.warn(`statusLine run failed for ${sessionId}: ${err?.message || err}`)
      outcome = { active: false, text: '', result: null }
    } finally {
      // The session may have been stopped mid-run.
      const still = this._sessions.get(sessionId)
      if (still) still.running = false
    }

    const still = this._sessions.get(sessionId)
    if (!still) return outcome ? { ...outcome, emitted: false } : null

    let emitted = false
    if (outcome.active) {
      if (outcome.text !== still.lastText) {
        still.lastText = outcome.text
        this.emit('output', {
          sessionId,
          active: true,
          text: outcome.text,
          truncated: Boolean(outcome.result?.truncated),
          timedOut: Boolean(outcome.result?.timedOut),
          exitCode: outcome.result?.exitCode ?? null,
        })
        emitted = true
      }
    } else if (still.lastText) {
      // Config removed after we had shown something — clear it once.
      still.lastText = null
      this.emit('output', { sessionId, active: false, text: '', truncated: false, timedOut: false, exitCode: null })
      emitted = true
    }
    return { active: outcome.active, text: outcome.text, emitted }
  }

  /**
   * Begin tracking a session: store its context provider and start the periodic
   * refresh loop (a self-rescheduling, unref'd timer — never setInterval, so an
   * in-flight run never overlaps the next tick). Idempotent — a second call just
   * updates the context provider.
   *
   * @param {string} sessionId
   * @param {Function} getContext - () => session context object (read fresh each tick)
   */
  startSession(sessionId, getContext) {
    if (this._stopped) return
    let session = this._sessions.get(sessionId)
    if (!session) {
      session = { getContext, timer: null, lastRunAt: 0, running: false, lastText: null }
      this._sessions.set(sessionId, session)
    } else {
      session.getContext = getContext
    }
    if (session.timer === null) this._scheduleTick(sessionId, 0)
  }

  _scheduleTick(sessionId, delayMs) {
    const session = this._sessions.get(sessionId)
    if (!session || this._stopped) return
    session.timer = this._setTimer(() => this._tick(sessionId), delayMs)
  }

  async _tick(sessionId) {
    const session = this._sessions.get(sessionId)
    if (!session || this._stopped) return
    session.timer = null
    let intervalMs = this._defaultRefreshIntervalMs
    try {
      const ctx = session.getContext ? session.getContext() : null
      if (ctx) {
        const config = await this.resolveConfig(ctx.cwd)
        if (config?.refreshIntervalMs) intervalMs = config.refreshIntervalMs
        await this.refresh(sessionId, ctx)
      }
    } catch (err) {
      log.warn(`statusLine tick failed for ${sessionId}: ${err?.message || err}`)
    }
    // Reschedule only if the session is still tracked and we weren't stopped.
    if (this._sessions.has(sessionId) && !this._stopped) this._scheduleTick(sessionId, intervalMs)
  }

  /** Stop tracking a session and clear its timer. Safe to call for an unknown id. */
  stopSession(sessionId) {
    const session = this._sessions.get(sessionId)
    if (!session) return
    if (session.timer !== null) this._clearTimer(session.timer)
    this._sessions.delete(sessionId)
  }

  /** Stop everything (server shutdown). Clears every timer; further calls are no-ops. */
  stopAll() {
    this._stopped = true
    for (const session of this._sessions.values()) {
      if (session.timer !== null) this._clearTimer(session.timer)
    }
    this._sessions.clear()
    this._configCache.clear()
  }
}
