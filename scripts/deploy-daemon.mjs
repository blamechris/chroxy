#!/usr/bin/env node
/**
 * deploy-daemon.mjs — idle-only automatic deploy of `main` to the daily daemon
 * (#8324).
 *
 * The daily daemon is `node packages/server/src/cli.js start --no-supervisor`
 * under launchd (KeepAlive=true), running out of a dedicated checkout. The
 * existing `chroxy deploy` command drives a SUPERVISOR over SIGUSR2 and runs
 * the full test suite; neither exists here.
 *
 * THE MODEL IS CONVERGENCE, NOT A JOURNAL. Every tick compares what IS with
 * what SHOULD BE and does whatever closes the gap, so an interrupted run needs
 * no recovery code: the next tick sees the gap and closes it.
 *
 *   the daemon runs `desired`  — read back from the daemon itself
 *                                (GET /api/daemon/idle -> commit), never
 *                                inferred from pids or a record of what we did
 *   the checkout HEAD is `desired`
 *   the dashboard build is from `desired`  — `<configDir>/deploy-build.json`,
 *                                written only after a successful build and
 *                                deleted before any change to the tree
 *
 * `desired` is the owed rollback if there is one (`rollbackTo` in
 * deploy-state.json), else the remote branch tip, except a tip that already
 * failed is skipped until main moves or --retry. `rollbackTo` is set before
 * every forward restart and cleared only (a) when a restart is verified,
 * (b) when the tree is converged back WITHOUT a restart because the signal never
 * went out (failed-restart), (c) when the daemon already runs it and the tree is
 * repaired, or the owed rollback is found already satisfied, and (d) when the
 * daemon cannot report a commit, so a restart could never be certified: the tree
 * is restored and a manual restart is requested.
 *
 * Three promises:
 *   1. Nothing is mutated (tree, build, daemon) while the daemon is busy,
 *      uncertain, or cannot say what it runs. Every uncertainty is "do not",
 *      never "probably fine". The one exception is an owed rollback against a
 *      daemon that is DOWN: there is nothing to lose.
 *   2. A restart counts only when the daemon itself reports `desired`, with a
 *      pid other than the one signalled, healthy locally, and still the same
 *      pid/commit/health after a settle window and again after the tunnel wait.
 *   3. It is quiet. A tick with nothing to do prints one console line and writes
 *      nothing to deploy.log; a repeated condition is logged once.
 *
 * Mutual exclusion is a kernel-held TCP port (`--lock-port`), not a file: it
 * cannot go stale, needs no reclaim protocol, and dies with the process.
 *
 * Everything outside this file's own logic is injected (`run`, `fetch`, `fs`,
 * `now`, `sleep`, `log`, `acquireLock`, ...) so scripts/__tests__/
 * deploy-daemon.test.mjs drives the whole flow without git, launchctl or a
 * network. Imports are all STATIC and resolved at process start: a fast-forward
 * of this very checkout mid-run cannot change what is already loaded.
 *
 * Usage:  node scripts/deploy-daemon.mjs [options]   (see --help)
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isEntryPoint } from './lib/is-entry-point.mjs'
import { isGitShaRef } from '../packages/server/src/utils/argv-safety.js'

export const DEFAULT_PORT = 8765
export const DEFAULT_LOCK_PORT = 47651
const FULL_SHA = /^[0-9a-f]{40}$/i
// A ref/remote name that git would parse as an option, or that smuggles a
// revision expression, is refused before it reaches an argv (#7295's lesson:
// quoting stops the shell, not git's own option parser).
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const LOCKFILE = /^(package-lock\.json|packages\/[^/]+\/package-lock\.json)$/

export const USAGE = `Usage: node scripts/deploy-daemon.mjs [options]

  --checkout <path>      daemon checkout (default ~/Projects/chroxy-daemon)
  --config-dir <path>    chroxy config dir (default $CHROXY_CONFIG_DIR or ~/.chroxy)
  --label <label>        launchd label (default com.chroxy.server)
  --branch <name>        branch to follow (default main)
  --remote <name>        remote to fetch (default origin)
  --port <n>             daemon's local HTTP port. REQUIRED when the daemon is tunnelled
                         on a non-default port: connection.json then carries only the
                         tunnel URL, so the port cannot be read from it (default: a port
                         in connection.json, else 8765)
  --lock-port <n>        loopback TCP port held for the run as the mutual-exclusion lock
                         (default ${DEFAULT_LOCK_PORT})
  --health-timeout <s>   seconds to wait for the daemon to come back (default 90)
  --settle <s>           seconds to wait after the daemon reports the new commit, then
                         re-confirm the same pid, commit and health (default 15)
  --npm <path>           npm binary (default: npm, found via a PATH that starts with this node's directory)
  --dry-run              fetch, then report what would happen; change and write nothing
  --force                skip the idle checks and the need for the daemon to report its
                         commit (still does everything else). Use it to bootstrap onto a
                         daemon that predates /api/daemon/idle or its commit field
  --retry                try a target that already rolled back (it is skipped otherwise)
  --no-tunnel-check      do not require the tunnel URL to answer /health
  --help
`

/**
 * Parse argv into options. Throws an Error whose message is user-facing.
 * @param {string[]} argv - arguments after the script name
 * @param {object} [env]
 * @param {string} [home]
 */
export function parseArgs(argv, env = process.env, home = homedir()) {
  const opts = {
    checkout: join(home, 'Projects', 'chroxy-daemon'),
    configDir: env.CHROXY_CONFIG_DIR ? resolve(env.CHROXY_CONFIG_DIR) : join(home, '.chroxy'),
    label: 'com.chroxy.server',
    branch: 'main',
    remote: 'origin',
    port: null,
    lockPort: DEFAULT_LOCK_PORT,
    healthTimeoutS: 90,
    settleS: 15,
    retry: false,
    npm: null,
    dryRun: false,
    force: false,
    tunnelCheck: true,
    help: false,
  }
  const valueOf = (i, flag) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  const portOf = (i, flag) => {
    const n = Number(valueOf(i, flag))
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${flag} must be 1-65535`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--checkout': opts.checkout = resolve(valueOf(i++, a)); break
      case '--config-dir': opts.configDir = resolve(valueOf(i++, a)); break
      case '--label': opts.label = valueOf(i++, a); break
      case '--branch': opts.branch = valueOf(i++, a); break
      case '--remote': opts.remote = valueOf(i++, a); break
      case '--npm': opts.npm = valueOf(i++, a); break
      case '--port': opts.port = portOf(i++, a); break
      case '--lock-port': opts.lockPort = portOf(i++, a); break
      case '--health-timeout': {
        const n = Number(valueOf(i++, a))
        if (!Number.isFinite(n) || n <= 0) throw new Error('--health-timeout must be a positive number of seconds')
        opts.healthTimeoutS = n
        break
      }
      case '--settle': {
        const n = Number(valueOf(i++, a))
        if (!Number.isFinite(n) || n < 0) throw new Error('--settle must be a non-negative number of seconds')
        opts.settleS = n
        break
      }
      case '--dry-run': opts.dryRun = true; break
      case '--force': opts.force = true; break
      case '--retry': opts.retry = true; break
      case '--no-tunnel-check': opts.tunnelCheck = false; break
      case '--help': case '-h': opts.help = true; break
      default: throw new Error(`unknown option: ${a}`)
    }
  }
  if (!SAFE_REF.test(opts.branch) || opts.branch.includes('..')) throw new Error(`unsafe --branch: ${opts.branch}`)
  if (!SAFE_REF.test(opts.remote) || opts.remote.includes('..')) throw new Error(`unsafe --remote: ${opts.remote}`)
  if (!SAFE_LABEL.test(opts.label)) throw new Error(`unsafe --label: ${opts.label}`)
  return opts
}

/** Default (real) dependencies. Tests pass their own. */
export function defaultDeps() {
  const nodeDir = dirname(process.execPath)
  return {
    // argv-array only, never a shell string. PATH gets the running node's own
    // directory first so `npm` finds the same node under launchd's bare PATH.
    // GIT_TERMINAL_PROMPT=0: an unattended fetch must fail, never wait for a
    // credential nobody is there to type.
    run(cmd, args, { cwd, timeoutMs } = {}) {
      const r = spawnSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        env: { ...process.env, PATH: `${nodeDir}:${process.env.PATH || '/usr/bin:/bin'}`, GIT_TERMINAL_PROMPT: '0' },
      })
      return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        error: r.error ? String(r.error.message || r.error) : null,
      }
    },
    fetch: globalThis.fetch,
    fs: { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    pid: process.pid,
    isPidAlive(pid) {
      try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
    },
    // The mutual-exclusion lock: a listening socket the kernel hands to exactly
    // one process and takes back when it exits. Resolves { ok, release } or
    // { ok: false, inUse, reason }.
    acquireLock(port) {
      return new Promise((done) => {
        const srv = createServer((sock) => sock.destroy())
        srv.once('error', (e) => done({ ok: false, inUse: e.code === 'EADDRINUSE', reason: e.code || e.message }))
        srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          srv.on('error', () => {})
          done({ ok: true, release: () => new Promise((r) => srv.close(() => r())) })
        })
      })
    },
  }
}

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 12) : '?')
const tail = (text, n = 12) => String(text || '').trim().split('\n').slice(-n).join('\n')
// What a failed command says, for deploy.log: the first few lines that look like
// an error (vite and npm end with stack frames, which say where, not what), else
// the tail.
const explain = (r, n = 4) => {
  const text = `${r.stderr || ''}\n${r.stdout || ''}`
  const hits = text.split('\n').map((l) => l.trim()).filter((l) => /error/i.test(l) && !/^at\s/.test(l))
  return hits.length ? hits.slice(0, n).join('\n') : tail(r.stderr || r.stdout || r.error)
}

// Thrown wherever a write or delete carries SAFETY (rollbackTo, failedTarget,
// the build stamp): the run aborts before its next mutation rather than carry
// on with a record it could not keep.
class StateWriteError extends Error {}

/**
 * Run one deploy tick.
 * @returns {Promise<{ exitCode: number, outcome: string }>}
 *   outcome is one of: up-to-date, repaired, deployed, deployed-tunnel-unverified,
 *   dry-run, deferred-busy, deferred-unavailable, deferred-busy-after-build,
 *   skipped-failed-target, locked, refused, fetch-failed, rolled-back-build,
 *   rolled-back-health, rollback-completed, rollback-owed, rollback-failed,
 *   failed-restart, repair-failed, state-write-failed, failed.
 */
export async function deploy(opts, deps = defaultDeps()) {
  const d = { ...defaultDeps(), ...deps }
  const { fs } = d
  const p = {
    log: join(opts.configDir, 'logs', 'deploy.log'),
    last: join(opts.configDir, 'last-deploy.json'),
    state: join(opts.configDir, 'deploy-state.json'),
    stamp: join(opts.configDir, 'deploy-build.json'),
    conn: join(opts.configDir, 'connection.json'),
    // Retired by earlier designs; only ever deleted.
    legacy: ['deploy.lock', 'deploy.lock.reclaim', 'deploy-pending-restart.json'].map((f) => join(opts.configDir, f)),
  }
  const npmBin = opts.npm || 'npm'
  const iso = () => new Date(d.now()).toISOString()

  // ---- small helpers ------------------------------------------------------
  const git = (args, o = {}) => d.run('git', args, { cwd: opts.checkout, ...o })
  const gitOut = (args) => {
    const r = git(args)
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${tail(r.stderr || r.error)}`)
    return r.stdout.trim()
  }
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }
  // Atomic: a reader (or a crash) sees the old file or the new one, never half
  // of either. The tmp name carries the pid so two writers cannot share one.
  const writeJson = (file, value) => {
    fs.mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${d.pid}`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
    fs.renameSync(tmp, file)
  }
  const rangeOf = (a, b) => `${short(a)}..${short(b)}`

  // ---- state: { failedTarget, failedOutcome, rollbackTo, lastKey } --------
  // Read and written ONLY while holding the lock (a dry run takes none and reads
  // only). Writes that carry safety are mandatory: see StateWriteError.
  let held = false
  let state = {}
  function loadState() {
    let raw
    try {
      raw = fs.readFileSync(p.state, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: true }
      // Unreadable is not absent: `rollbackTo` may be in there.
      return { ok: false, reason: `cannot read deploy-state.json: ${e.message}` }
    }
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      // A file that PARSES but whose safety fields are malformed is not "corrupt,
      // start empty": an owed rollback must not silently become up-to-date.
      for (const k of ['failedTarget', 'rollbackTo']) {
        if (parsed[k] !== undefined && !(typeof parsed[k] === 'string' && FULL_SHA.test(parsed[k]))) {
          return { ok: false, reason: `deploy-state.json is malformed (${k} is not a commit); fix or delete it by hand` }
        }
      }
      state = {}
      for (const k of ['failedTarget', 'failedOutcome', 'rollbackTo', 'lastKey', 'deferredSince', 'deferredLoggedAt']) {
        if (parsed[k] !== undefined) state[k] = parsed[k]
      }
      return { ok: true }
    } catch {
      const keep = `${p.state}.corrupt-${d.now()}`
      if (opts.dryRun) {
        d.log(`deploy-state.json unreadable; a real run would keep a copy at ${keep}`)
        return { ok: true }
      }
      try { fs.renameSync(p.state, keep) } catch { /* best effort */ }
      state = {}
      event(`deploy-state.json unreadable; keeping a copy at ${keep}`)
      return { ok: true }
    }
  }
  function persist({ mandatory }) {
    if (!held || opts.dryRun) return
    try {
      writeJson(p.state, state)
    } catch (e) {
      if (mandatory) throw new StateWriteError(`cannot write deploy-state.json: ${e.message}`)
    }
  }
  const markFailed = (target, outcome) => { state.failedTarget = target; state.failedOutcome = outcome; persist({ mandatory: true }) }
  const clearFailed = () => { if (state.failedTarget) { delete state.failedTarget; delete state.failedOutcome; persist({ mandatory: true }) } }
  const setRollbackTo = (sha) => { state.rollbackTo = sha; persist({ mandatory: true }) }
  const clearRollbackTo = () => { if (state.rollbackTo) { delete state.rollbackTo; persist({ mandatory: true }) } }

  // deploy.log gets one line per EVENT. `key` dedupes a repeating event (the
  // same deferral on every ten-minute tick) against the previous logged key.
  function event(msg, { range = null, key = null, force = false } = {}) {
    const line = range ? `${range} ${msg}` : msg
    d.log(line)
    if (opts.dryRun) return
    if (key) {
      if (state.lastKey === key && !force) return
      state.lastKey = key
    } else {
      state.lastKey = null
    }
    persist({ mandatory: false })
    try {
      fs.mkdirSync(dirname(p.log), { recursive: true })
      // One event per line: a multi-line reason (an npm error tail) is folded
      // so deploy.log stays greppable by timestamp.
      const flat = String(msg).trim().split(/\s*\n\s*/).filter(Boolean).join(' | ')
      fs.appendFileSync(p.log, `${iso()} ${range || '-'} ${flat}\n`)
    } catch { /* a log that cannot be written must not abort a deploy */ }
  }
  // A deferral that never ends (a leaked background agent, an always-open shell
  // PTY) would otherwise be one log line for ever and look like nothing is
  // wrong. It is remembered from its first tick, and once it has lasted more
  // than 24h it logs again, once per 24h, bypassing the dedupe.
  const DAY_MS = 24 * 60 * 60 * 1000
  let deferredThisTick = false
  function deferral(msg, { range = null, key, reasons }) {
    deferredThisTick = true
    if (!state.deferredSince) { state.deferredSince = iso(); persist({ mandatory: false }) }
    const since = Date.parse(state.deferredSince)
    const lastLogged = state.deferredLoggedAt ?? since
    if (Number.isFinite(since) && d.now() - since > DAY_MS && d.now() - lastLogged > DAY_MS) {
      state.deferredLoggedAt = d.now()
      event(`still deferred since ${state.deferredSince}: ${reasons}`, { range, key, force: true })
      return
    }
    event(msg, { range, key })
  }
  function recordResult(from, to, result) {
    if (opts.dryRun) return
    let subject = ''
    try { subject = gitOut(['log', '-1', '--format=%s', to]) } catch { /* cosmetic */ }
    try { writeJson(p.last, { from, to, at: iso(), result, subject }) } catch { /* best effort */ }
  }

  // ---- build stamp: { sha, lockHash } -------------------------------------
  function readStamp() {
    const s = readJson(p.stamp)
    return s && FULL_SHA.test(s.sha || '') && typeof s.lockHash === 'string' ? s : null
  }
  // Deleted BEFORE any change to the tree or the build, mandatory: a stamp that
  // survived an interrupted change would certify a build that no longer exists.
  function deleteStamp() {
    try { fs.unlinkSync(p.stamp) } catch (e) {
      if (e.code !== 'ENOENT') throw new StateWriteError(`cannot delete deploy-build.json: ${e.message}`)
    }
  }
  function writeStamp(sha, lockHash) {
    try { writeJson(p.stamp, { sha, lockHash }) } catch (e) {
      throw new StateWriteError(`cannot write deploy-build.json: ${e.message}`)
    }
  }
  // sha256 over every package-lock.json in the working tree, in sorted path order.
  function computeLockHash() {
    const files = gitOut(['ls-files']).split('\n').filter((f) => LOCKFILE.test(f)).sort()
    const h = createHash('sha256')
    for (const f of files) {
      h.update(f)
      h.update('\0')
      h.update(fs.readFileSync(join(opts.checkout, f)))
      h.update('\0')
    }
    return h.digest('hex')
  }

  // ---- daemon probes ------------------------------------------------------
  function readConn() {
    const info = readJson(p.conn)
    return info && typeof info === 'object' ? info : null
  }
  function portOf(conn) {
    if (opts.port) return opts.port
    for (const u of [conn?.httpUrl, conn?.wsUrl]) {
      const m = typeof u === 'string' ? u.match(/:(\d+)(?:\/|$)/) : null
      if (m) return Number(m[1])
    }
    return DEFAULT_PORT
  }
  async function getJson(url, headers = {}) {
    const res = await d.fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    let body = null
    try { body = await res.json() } catch { /* not JSON */ }
    return { status: res.status, body }
  }
  async function localHealthy(conn) {
    try {
      const r = await d.fetch(`http://127.0.0.1:${portOf(conn)}/health`, { signal: AbortSignal.timeout(5000) })
      return r.status === 200
    } catch { return false }
  }

  // -> { kind, reasons, commit, pid, noRoute }
  //   idle / busy  the daemon answered and said so
  //   down         NOTHING is listening: no connection.json, a dead pid, or a refused/reset
  //                loopback connection. The only kind that has nothing to lose.
  //   unknown      something may be listening but cannot answer: a 404 (the route is
  //                missing), any other non-200, a timeout, an unreadable body. It may well
  //                be busy, so everywhere it is treated like busy.
  // `commit` is what the DAEMON says it started from (null when it cannot say).
  async function probe() {
    const conn = readConn()
    const make = (kind, why, extra = {}) => ({ kind, reasons: [why], commit: null, pid: null, noRoute: false, ...extra })
    if (!conn) return make('down', 'no connection.json (daemon not running?)')
    if (conn.pid && !d.isPidAlive(conn.pid)) return make('down', `connection.json names pid ${conn.pid}, which is not running`)
    if (!conn.apiToken) return make('unknown', 'connection.json has no apiToken')
    let r
    try {
      r = await getJson(`http://127.0.0.1:${portOf(conn)}/api/daemon/idle`, { Authorization: `Bearer ${conn.apiToken}` })
    } catch (e) {
      const refused = /ECONNREFUSED|ECONNRESET/.test(`${e?.cause?.code || ''} ${e?.code || ''} ${e?.message || ''}`)
      return make(refused ? 'down' : 'unknown', `daemon unreachable: ${e?.message || e}`)
    }
    if (r.status === 404) return make('unknown', 'daemon has no /api/daemon/idle (it predates the route; deploy once by hand or with --force)', { noRoute: true })
    if (r.status !== 200) return make('unknown', `/api/daemon/idle answered HTTP ${r.status}`)
    if (!r.body || typeof r.body !== 'object' || typeof r.body.idle !== 'boolean') return make('unknown', '/api/daemon/idle returned an unreadable body')
    const reasons = Array.isArray(r.body.reasons) ? r.body.reasons.map(String) : []
    const commit = typeof r.body.commit === 'string' && FULL_SHA.test(r.body.commit) ? r.body.commit.toLowerCase() : null
    const pid = Number.isInteger(r.body.pid) ? r.body.pid : null
    return { kind: r.body.idle === true ? 'idle' : 'busy', reasons: r.body.idle === true ? reasons : (reasons.length ? reasons : ['busy']), commit, pid, noRoute: false }
  }
  const describe = (pr) => `${pr.kind}${pr.reasons.length ? ` (${pr.reasons.join('; ')})` : ''}`

  // ---- tree, build, restart: ONE implementation each ----------------------
  const LONG = 20 * 60 * 1000
  function npmCi() {
    const r = d.run(npmBin, ['ci', '--no-audit', '--no-fund'], { cwd: opts.checkout, timeoutMs: LONG })
    return r.status === 0 ? { ok: true } : { ok: false, reason: `npm ci failed: ${explain(r)}` }
  }
  function buildDashboard() {
    const r = d.run(npmBin, ['run', 'build', '-w', '@chroxy/dashboard'], { cwd: opts.checkout, timeoutMs: LONG })
    return r.status === 0 ? { ok: true } : { ok: false, reason: `dashboard build failed: ${explain(r)}` }
  }
  // git merge-base --is-ancestor: true / false, anything else is an error.
  function isAncestor(a, b) {
    const r = git(['merge-base', '--is-ancestor', a, b])
    if (r.status === 0) return true
    if (r.status === 1) return false
    throw new Error(`git merge-base failed: ${tail(r.stderr || r.error)}`)
  }

  /**
   * Make the checkout, node_modules and dashboard build all be `desired`.
   * `allowReset` is false for a forward deploy, so a checkout that is AHEAD of
   * the remote (local commits) is refused rather than reset away.
   * @returns {{ ok: boolean, refused?: boolean, reason?: string }}
   */
  function convergeTree(desired, { allowReset }) {
    if (!isGitShaRef(desired)) return { ok: false, refused: true, reason: 'desired is not a SHA' }
    const head = gitOut(['rev-parse', 'HEAD'])
    let how = 'none'
    if (head !== desired) {
      if (isAncestor(head, desired)) how = 'ff'
      else if (!allowReset) return { ok: false, refused: true, reason: `local ${short(head)} is not an ancestor of ${short(desired)} (diverged or ahead); fast-forward only` }
      else if (isAncestor(desired, head)) how = 'reset'
      else return { ok: false, refused: true, reason: `${short(desired)} is neither HEAD, an ancestor nor a descendant of ${short(head)}` }
    }
    const prev = readStamp()
    deleteStamp() // mandatory, before ANY change
    if (how === 'ff') {
      const m = git(['merge', '--ff-only', desired])
      if (m.status !== 0) return { ok: false, reason: `merge --ff-only failed: ${tail(m.stderr || m.stdout || m.error, 3)}` }
    } else if (how === 'reset') {
      const m = git(['reset', '--hard', desired])
      if (m.status !== 0) return { ok: false, reason: `git reset --hard failed: ${tail(m.stderr || m.error)}` }
    }
    const lockHash = computeLockHash()
    if (!prev || prev.lockHash !== lockHash) {
      const ci = npmCi()
      if (!ci.ok) return ci
    }
    const b = buildDashboard()
    if (!b.ok) return b
    writeStamp(desired, lockHash)
    return { ok: true }
  }

  function signalDaemon() {
    const r = d.run('launchctl', ['kill', 'SIGTERM', `gui/${d.uid}/${opts.label}`])
    return r.status === 0 ? { ok: true } : { ok: false, reason: `launchctl kill failed: ${tail(r.stderr || r.error)}` }
  }
  // The daemon is confirmed only when IT says it runs `desired`, with the pid
  // we expect, alive, and answering /health. Never inferred from a pid alone.
  async function confirmLocal(desired, pid) {
    const pr = await probe()
    if (pr.kind === 'down' || pr.kind === 'unknown') return { ok: false, reason: `daemon not answering: ${pr.reasons.join('; ')}` }
    if (pr.commit !== desired) return { ok: false, reason: `daemon reports commit ${pr.commit ? short(pr.commit) : 'none'}, expected ${short(desired)}` }
    if (pid != null && pr.pid !== pid) return { ok: false, reason: `daemon pid is ${pr.pid}, expected ${pid} (it restarted or exited)` }
    if (pr.pid != null && !d.isPidAlive(pr.pid)) return { ok: false, reason: `pid ${pr.pid} is no longer running` }
    if (!(await localHealthy(readConn()))) return { ok: false, reason: 'local /health is not 200' }
    return { ok: true, pid: pr.pid }
  }
  // The tunnel answers 530 for several seconds after a restart; retry through
  // that and through connection errors until the budget runs out. A tunnel is
  // not the daemon: a failure here is reported, never a reason to roll back.
  // -> { ok: true, skipped?: why } | { ok: false, reason }. A skipped check says
  // so, so a success line can admit the tunnel was never looked at.
  async function checkTunnel() {
    if (!opts.tunnelCheck) return { ok: true, skipped: '--no-tunnel-check' }
    const conn = readConn()
    if (!conn) return { ok: true, skipped: 'no connection.json' }
    const mode = conn.tunnelMode
    if (!mode) return { ok: true, skipped: 'connection.json has no tunnelMode' }
    if (mode === 'none') return { ok: true, skipped: 'tunnel mode is none' }
    let host = null
    try { host = conn.httpUrl ? new URL(conn.httpUrl).hostname : null } catch { /* unparseable: skip */ }
    if (!host || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return { ok: true, skipped: 'connection.json has no tunnel URL (a local URL)' }
    const deadline = d.now() + opts.healthTimeoutS * 1000
    let lastWhy = 'tunnel never answered'
    while (d.now() < deadline) {
      try {
        const r = await d.fetch(`${conn.httpUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(8000) })
        if (r.status === 200) return { ok: true }
        lastWhy = `tunnel /health answered HTTP ${r.status}`
      } catch (e) { lastWhy = `tunnel /health: ${e?.message || e}` }
      await d.sleep(2000)
    }
    return { ok: false, reason: lastWhy }
  }
  /**
   * SIGTERM the daemon and wait for it to come back running `desired`.
   * -> { ok, signalled, tunnelUnverified?, reason? }.
   * ok:false with signalled:true is a LOCAL failure (never the tunnel's fault).
   */
  async function restartAndVerify(desired, prevPid, { tolerateSignalFailure }) {
    const sig = signalDaemon()
    if (!sig.ok && !tolerateSignalFailure) return { ok: false, signalled: false, reason: sig.reason }
    // Up: the daemon reports `desired`, from a pid other than the one signalled.
    const deadline = d.now() + opts.healthTimeoutS * 1000
    let why = 'daemon did not restart'
    let up = null
    while (d.now() < deadline) {
      const pr = await probe()
      if (pr.kind === 'down' || pr.kind === 'unknown') why = `daemon not answering: ${pr.reasons.join('; ')}`
      else if (pr.commit !== desired) why = `daemon reports commit ${pr.commit ? short(pr.commit) : 'none'}, expected ${short(desired)}`
      else if (prevPid != null && pr.pid === prevPid) why = `daemon still has the pre-signal pid ${prevPid}`
      else if (!(await localHealthy(readConn()))) why = 'local /health is not 200'
      else { up = pr; break }
      await d.sleep(1000)
    }
    if (!up) return { ok: false, signalled: sig.ok, reason: why + (sig.ok ? '' : ` (${sig.reason})`) }
    // A build that reports the right commit and then dies seconds later is not a
    // deploy: settle, then confirm the same pid, commit and health.
    await d.sleep(opts.settleS * 1000)
    const settled = await confirmLocal(desired, up.pid)
    if (!settled.ok) return { ok: false, signalled: true, reason: `after settling ${opts.settleS}s: ${settled.reason}` }
    const tunnel = await checkTunnel()
    // The tunnel wait can be long, and the daemon can die inside it: a tunnel
    // verdict is only ever reported on top of a CURRENT local one.
    const after = await confirmLocal(desired, up.pid)
    if (!after.ok) return { ok: false, signalled: true, reason: `after the tunnel check: ${after.reason}` }
    if (!tunnel.ok) return { ok: true, signalled: true, tunnelUnverified: tunnel.reason }
    return { ok: true, signalled: true, tunnelSkipped: tunnel.skipped }
  }

  // ======================================================================
  // main flow
  // ======================================================================
  if (opts.dryRun) d.log('[dry-run] no merge, build, restart, state or log write will happen')

  let lock = null
  if (!opts.dryRun) {
    lock = await d.acquireLock(opts.lockPort)
    if (!lock.ok) {
      // Console only: a run that lost the lock owns neither deploy-state.json
      // nor the dedupe key, so it touches neither.
      if (lock.inUse) {
        d.log(`another deploy is running (or port ${opts.lockPort} is in use); skipping this run`)
        return { exitCode: 0, outcome: 'locked' }
      }
      d.log(`cannot take the deploy lock on 127.0.0.1:${opts.lockPort} (${lock.reason}); not deploying`)
      return { exitCode: 1, outcome: 'failed' }
    }
    held = true
  }

  try {
    const loaded = loadState()
    if (!loaded.ok) {
      d.log(`ABORTED: ${loaded.reason}. Nothing was changed.`)
      return { exitCode: 1, outcome: 'state-write-failed' }
    }
    if (!opts.dryRun) for (const f of p.legacy) { try { fs.unlinkSync(f) } catch { /* none */ } }

    // -- 1. the checkout must be clean and on the branch ------------------------
    if (!fs.existsSync(join(opts.checkout, '.git'))) {
      event(`refused: ${opts.checkout} is not a git checkout`, { key: 'not-a-checkout' })
      return { exitCode: 1, outcome: 'refused' }
    }
    const porcelain = git(['status', '--porcelain'])
    if (porcelain.status !== 0) {
      event(`refused: git status failed: ${tail(porcelain.stderr || porcelain.error)}`, { key: 'status-failed' })
      return { exitCode: 1, outcome: 'refused' }
    }
    if (porcelain.stdout.trim() !== '') {
      const h = (git(['rev-parse', 'HEAD']).stdout || '').trim()
      event(`refused: checkout has uncommitted changes (${porcelain.stdout.trim().split('\n').length} path(s)); not deploying over them`, { key: `dirty:${h}` })
      return { exitCode: 1, outcome: 'refused' }
    }
    const branchNow = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branchNow.status !== 0 || branchNow.stdout.trim() !== opts.branch) {
      event(`refused: checkout is on '${branchNow.stdout.trim() || '?'}', not '${opts.branch}'`, { key: `branch:${branchNow.stdout.trim()}` })
      return { exitCode: 1, outcome: 'refused' }
    }
    const fetched = git(['fetch', opts.remote, opts.branch], { timeoutMs: 5 * 60 * 1000 })
    if (fetched.status !== 0) {
      event(`fetch failed: ${tail(fetched.stderr || fetched.error, 3)}`, { key: 'fetch-failed' })
      return { exitCode: 1, outcome: 'fetch-failed' }
    }
    const head = gitOut(['rev-parse', 'HEAD'])
    const target = gitOut(['rev-parse', '--verify', `refs/remotes/${opts.remote}/${opts.branch}^{commit}`])
    if (!FULL_SHA.test(head) || !FULL_SHA.test(target)) {
      event(`refused: could not resolve HEAD / ${opts.remote}/${opts.branch} to commit SHAs`, { key: 'unresolved' })
      return { exitCode: 1, outcome: 'refused' }
    }
    // A newer main forgives a remembered failure.
    if (state.failedTarget && state.failedTarget !== target && !opts.dryRun) clearFailed()

    // -- 2. what is, and what should be ------------------------------------------
    const pr = await probe()
    const reachable = pr.kind === 'idle' || pr.kind === 'busy'
    const running = reachable ? pr.commit : null // what the DAEMON says; null = cannot say
    const stamp = readStamp()
    const owed = state.rollbackTo || null
    const failedHere = !owed && state.failedTarget === target && !opts.retry
    let desired
    if (owed) desired = owed
    else if (failedHere) desired = running ?? head
    else desired = target
    const forward = !owed && !failedHere && desired !== running
    const oldForRollback = running ?? head // what to put back if a forward deploy fails
    const treeOk = head === desired && stamp?.sha === desired
    const needsWork = !(running === desired && treeOk)
    const skipMsg = `skipped: ${short(target)} already rolled back (${state.failedOutcome || 'unknown'}); waiting for a newer main or --retry`

    if (opts.dryRun) {
      d.log(`[dry-run] daemon runs: ${running ? short(running) : `unknown (${reachable ? 'it reports no commit' : pr.reasons.join('; ')})`}`)
      d.log(`[dry-run] checkout HEAD: ${short(head)}; build stamp: ${stamp ? short(stamp.sha) : 'none'}; ${opts.remote}/${opts.branch}: ${short(target)}`)
      d.log(`[dry-run] owed rollback: ${owed ? short(owed) : 'none'}; failed target: ${state.failedTarget ? `${short(state.failedTarget)} (${state.failedOutcome})` : 'none'}`)
      if (failedHere) d.log(`[dry-run] a real run would SKIP this target: ${skipMsg}`)
      d.log(`[dry-run] desired: ${short(desired)} (${owed ? 'owed rollback' : failedHere ? 'the running commit; target already failed' : 'the remote tip'})`)
      d.log(`[dry-run] idle verdict: ${describe(pr)}`)
      if (!needsWork) { d.log('[dry-run] nothing to do'); return { exitCode: 0, outcome: 'dry-run' } }
      if (forward) {
        let commits = ''
        try { commits = gitOut(['log', '--format=%h %s', `${head}..${desired}`]) } catch { /* unrelated */ }
        d.log(`[dry-run] ${commits.split('\n').filter(Boolean).length} commit(s) ahead:`)
        if (commits) d.log(commits.split('\n').map((l) => `  ${l}`).join('\n'))
      }
      d.log('[dry-run] steps, in order:')
      const steps = [`delete ${p.stamp}`, `git -C ${opts.checkout} ${head === desired ? '(HEAD already there)' : `move HEAD to ${desired}`}`,
        `${npmBin} ci --no-audit --no-fund   (only if the package-lock.json hash differs from the stamp's)`, `${npmBin} run build -w @chroxy/dashboard`, `write ${p.stamp}`]
      if (running !== desired) {
        steps.push('idle check again; if busy now: converge the tree back to what the daemon runs and defer')
        if (forward) steps.push(`record rollbackTo=${short(oldForRollback)} in deploy-state.json`)
        steps.push(`launchctl kill SIGTERM gui/${d.uid}/${opts.label}`)
        steps.push(`verify: the daemon reports ${short(desired)} from a NEW pid, healthy; settle ${opts.settleS}s; tunnel${opts.tunnelCheck ? '' : ' (skipped)'}; confirm again`)
        steps.push('on a local failure: mark the target failed and roll back the same way')
      }
      for (const s of steps) d.log(`  ${s}`)
      return { exitCode: 0, outcome: 'dry-run' }
    }

    // -- 3. can anything be done at all -------------------------------------------
    if (!owed) {
      // An owed rollback against a DOWN daemon proceeds (nothing is listening:
      // nothing to lose). Everything else needs a daemon that can say what it runs.
      if (!opts.force && (pr.kind === 'down' || pr.kind === 'unknown')) {
        deferral(`deferred: cannot confirm idle (${pr.reasons.join('; ')})`, { range: rangeOf(head, target), key: `unavailable:${target}`, reasons: pr.reasons.join('; ') })
        return { exitCode: 0, outcome: 'deferred-unavailable' }
      }
      if (!opts.force && reachable && pr.commit === null) {
        deferral('deferred: the daemon does not report the commit it runs (it predates the commit field; bootstrap once with --force)', { range: rangeOf(head, target), key: `no-commit:${target}`, reasons: 'no commit reported' })
        return { exitCode: 0, outcome: 'deferred-unavailable' }
      }
    }
    if (failedHere) event(skipMsg, { range: rangeOf(head, target), key: `skipped:${target}` })
    const skippedOutcome = (outcome) => (failedHere ? 'skipped-failed-target' : outcome)

    // -- 4. nothing to do ------------------------------------------------------------
    if (!needsWork) {
      if (owed) { clearRollbackTo(); event(`owed rollback to ${short(owed)} is already satisfied`) } else if (!failedHere) {
        // A genuinely healthy tick: forget the last logged condition so a repeat
        // of it later is news again.
        if (state.lastKey) { state.lastKey = null; persist({ mandatory: false }) }
      }
      d.log(`up to date at ${short(desired)}`)
      return { exitCode: 0, outcome: skippedOutcome('up-to-date') }
    }

    // -- 5. the busy gate, before ANY mutation ------------------------------------
    // `unknown` (a timeout, a 500, an unreadable body) may well be busy and is
    // treated exactly like busy; only `down` has nothing to lose. A 404 on an
    // owed rollback is the one exception: that daemon cannot report a commit at
    // all, and is handled below by restoring the tree without touching it.
    const owedNoRoute = owed && pr.noRoute
    if ((pr.kind === 'busy' || (pr.kind === 'unknown' && !owedNoRoute)) && !opts.force) {
      const owedNote = owed ? ` (rollback to ${short(owed)} is owed)` : ''
      deferral(pr.kind === 'busy' ? `deferred${owedNote}: busy (${pr.reasons.join('; ')})` : `deferred${owedNote}: cannot confirm idle (${pr.reasons.join('; ')})`,
        { range: rangeOf(head, desired), key: `busy:${desired}`, reasons: pr.reasons.join('; ') })
      return { exitCode: 0, outcome: skippedOutcome('deferred-busy') }
    }

    // -- 6. the daemon already runs `desired`: only the checkout is behind ---------
    if (running === desired) {
      const fix = convergeTree(desired, { allowReset: true })
      if (!fix.ok) {
        event(`repair failed: ${fix.reason}`, { range: rangeOf(head, desired), key: `repair-failed:${desired}` })
        return { exitCode: 1, outcome: 'repair-failed' }
      }
      if (owed) clearRollbackTo()
      event(`repaired checkout to ${short(desired)} (no restart needed)`, { range: rangeOf(head, desired) })
      return { exitCode: 0, outcome: skippedOutcome('repaired') }
    }

    // An owed rollback to a daemon that cannot report a commit (it answers 404, or
    // says commit: null — it predates the field): the tree can be restored, but a
    // restart could never be certified, so none is attempted. `rollbackTo` is
    // cleared, which is what stops this from looping: the next tick is not owed,
    // sees the same daemon, and only defers.
    if (owed && (owedNoRoute || (reachable && pr.commit === null)) && !opts.force) {
      const fix = convergeTree(desired, { allowReset: true })
      if (!fix.ok) { event(`ROLLBACK-FAILED: ${fix.reason}`, { range: rangeOf(head, desired) }); return { exitCode: 1, outcome: 'rollback-failed' } }
      clearRollbackTo()
      event(`restored the checkout to ${short(desired)}; the daemon ${owedNoRoute ? 'has no /api/daemon/idle route' : 'reports no commit'}, so a restart could not be certified and was NOT attempted. The running daemon may still be on the bad build: restart it by hand (or run once with --force).`, { range: rangeOf(head, desired) })
      return { exitCode: 0, outcome: 'rollback-completed' }
    }

    return await converge({ desired, kind: owed ? 'rollback' : 'forward', old: oldForRollback, pr, initiator: owed ? 'tick' : 'forward', target: owed ? null : target })

    // ---------------------------------------------------------------------
    // The one path that moves the daemon to `desired`: tree, re-check, restart,
    // verify. The forward deploy, the rollback after a failed one, and an owed
    // rollback on a later tick all run THIS code.
    // ---------------------------------------------------------------------
    async function converge({ desired: want, kind, old, pr: pre, initiator, target: fwdTarget }) {
      const isForward = kind === 'forward'
      // A rollback's range reads bad..good, not good..good.
      const range = isForward ? rangeOf(head, want) : rangeOf(fwdTarget || pre.commit || head, want)

      const built = convergeTree(want, { allowReset: !isForward })
      if (!built.ok) {
        if (built.refused) {
          event(`refused: ${built.reason}`, { range, key: `refused:${want}` })
          return { exitCode: 1, outcome: 'refused' }
        }
        if (!isForward) {
          event(`ROLLBACK-FAILED (${built.reason}). Rollback to ${short(want)} stays owed; the next tick retries.`, { range })
          return { exitCode: 1, outcome: 'rollback-failed' }
        }
        // The forward build failed. The daemon was never touched: put the tree
        // back to what it runs, and remember the target so it is not retried.
        markFailed(fwdTarget, 'rolled-back-build')
        const back = convergeTree(old, { allowReset: true })
        if (back.ok) {
          recordResult(old, fwdTarget, 'rolled-back-build')
          event(`rolled-back (build failed: ${built.reason})`, { range })
          return { exitCode: 1, outcome: 'rolled-back-build' }
        }
        setRollbackTo(old) // so the next tick keeps trying to restore the tree
        recordResult(old, fwdTarget, 'rollback-failed')
        event(`ROLLBACK-FAILED after a failed build (${built.reason}); restoring the checkout failed too (${back.reason}). Rollback to ${short(old)} is owed. node_modules may be replaced under the running daemon until the tree is converged back.`, { range })
        return { exitCode: 1, outcome: 'rollback-failed' }
      }

      // The build took time: the daemon may have turned busy.
      let prevPid = pre.pid ?? null
      // ALWAYS re-probe after the build. A daemon that was down when the tick
      // began may have been relaunched by launchd and be busy by now; only a
      // rollback that finds it STILL down may go ahead without an idle verdict.
      if (!opts.force) {
        const again = await probe()
        const stillDown = !isForward && again.kind === 'down'
        if (!stillDown && again.kind !== 'idle') {
          const why = `${again.kind === 'busy' ? 'busy' : 'cannot confirm idle'} (${again.reasons.join('; ')})`
          if (isForward) {
            const back = convergeTree(old, { allowReset: true })
            if (!back.ok) {
              setRollbackTo(old)
              event(`ROLLBACK-FAILED after the daemon turned ${why}; restoring the checkout failed (${back.reason}). Rollback to ${short(old)} is owed.`, { range })
              return { exitCode: 1, outcome: 'rollback-failed' }
            }
            deferral(`deferred after build: ${why}`, { range, key: `busy-after-build:${want}`, reasons: why })
            return { exitCode: 0, outcome: 'deferred-busy-after-build' }
          }
          deferral(`rollback restart deferred: ${why}; the checkout is already at ${short(want)} and the rollback stays owed`, { range, key: `rollback-busy:${want}`, reasons: why })
          return { exitCode: 0, outcome: 'deferred-busy' }
        }
        prevPid = again.pid
      }

      // Owed BEFORE the signal: an interruption anywhere after it leaves a
      // rollback owed instead of a false "up to date".
      if (isForward) setRollbackTo(old)
      const v = await restartAndVerify(want, prevPid, { tolerateSignalFailure: !isForward })

      if (v.ok) {
        clearRollbackTo()
        if (isForward) {
          clearFailed()
          if (v.tunnelUnverified) {
            recordResult(old, want, 'deployed-tunnel-unverified')
            event(`DEPLOYED-TUNNEL-UNVERIFIED: the new daemon is healthy locally but the tunnel never answered 200 (${v.tunnelUnverified}). Not rolled back: the daemon is serving and a rollback would not fix a tunnel. Check the tunnel.`, { range })
            return { exitCode: 1, outcome: 'deployed-tunnel-unverified' }
          }
          recordResult(old, want, 'ok')
          event(`ok${v.tunnelSkipped ? ` (tunnel not checked: ${v.tunnelSkipped})` : ''}`, { range })
          return { exitCode: 0, outcome: 'deployed' }
        }
        recordResult(fwdTarget || pre.commit || head, want, 'rolled-back')
        event(`${initiator === 'forward' ? 'rolled-back' : 'rollback completed'} to ${short(want)}${v.tunnelUnverified ? `; the tunnel is unverified (${v.tunnelUnverified})` : v.tunnelSkipped ? ` (tunnel not checked: ${v.tunnelSkipped})` : ''}`, { range })
        return { exitCode: initiator === 'forward' ? 1 : 0, outcome: initiator === 'forward' ? 'rolled-back-health' : 'rollback-completed' }
      }

      // ---- failure -------------------------------------------------------------
      if (!isForward) {
        event(`ROLLBACK-FAILED (${v.reason}). Rollback to ${short(want)} stays owed; the next tick retries. The daemon may be down; check launchd and ${p.log}.`, { range })
        return { exitCode: 1, outcome: 'rollback-failed' }
      }
      markFailed(fwdTarget, v.signalled ? 'rolled-back-health' : 'failed-restart')
      if (!v.signalled) {
        // Nothing was signalled: the daemon still runs the OLD code. Put the
        // disk back to match it.
        const back = convergeTree(old, { allowReset: true })
        if (back.ok) {
          clearRollbackTo()
          recordResult(old, want, 'rolled-back-restart')
          event(`rolled-back (restart failed: ${v.reason})`, { range })
          return { exitCode: 1, outcome: 'failed-restart' }
        }
        event(`ROLLBACK-FAILED (restart failed: ${v.reason}; restoring the checkout failed: ${back.reason}). Rollback to ${short(old)} is owed.`, { range })
        return { exitCode: 1, outcome: 'rollback-failed' }
      }
      event(`health failed: ${v.reason}. Rolling back to ${short(old)}.`, { range })
      // The running code is known-bad, but a health failure does not make its
      // accepted work disposable: if it is reachable and still busy, wait for
      // idle, and if it never is, leave the rollback owed for a later tick.
      const left = await waitForIdleOrGiveUp()
      if (left.busy) {
        event(`ROLLBACK-OWED to ${short(old)}: the daemon is still not idle after ${opts.healthTimeoutS}s (${left.reasons.join('; ')}); the next idle tick completes it`, { range })
        return { exitCode: 1, outcome: 'rollback-owed' }
      }
      const rb = await converge({ desired: old, kind: 'rollback', old: null, pr: left.pr, initiator: 'forward', target: fwdTarget })
      return rb
    }

    async function waitForIdleOrGiveUp() {
      if (opts.force) return { busy: false, pr: await probe() }
      const t0 = d.now()
      const deadline = t0 + opts.healthTimeoutS * 1000
      let waited = false
      for (;;) {
        const now = await probe()
        // Only an IDLE answer, or nothing listening at all, lets the rollback
        // restart. busy and unknown (a timeout, a 500, ...) both wait.
        if (now.kind === 'idle' || now.kind === 'down') {
          if (waited) event(`rollback waited ${Math.round((d.now() - t0) / 1000)}s for the daemon to go idle`)
          return { busy: false, pr: now }
        }
        waited = true
        if (d.now() >= deadline) return { busy: true, reasons: now.reasons }
        await d.sleep(5000)
      }
    }
  } catch (e) {
    if (e instanceof StateWriteError) {
      d.log(`ABORTED: ${e.message}. This run stopped before its next change.`)
      return { exitCode: 1, outcome: 'state-write-failed' }
    }
    event(`failed: ${e?.message || e}`, { key: `error:${e?.message}` })
    return { exitCode: 1, outcome: 'failed' }
  } finally {
    // A tick that did not defer ends the deferral streak (S8).
    if (held && !deferredThisTick && (state.deferredSince || state.deferredLoggedAt)) {
      delete state.deferredSince
      delete state.deferredLoggedAt
      try { persist({ mandatory: false }) } catch { /* best effort */ }
    }
    if (lock?.ok) { try { await lock.release() } catch { /* process exit frees it */ } }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    console.error(`deploy-daemon: ${e.message}\n\n${USAGE}`)
    return 2
  }
  if (opts.help) { console.log(USAGE); return 0 }
  const { exitCode } = await deploy(opts)
  return exitCode
}

if (isEntryPoint(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (e) => {
    console.error(`deploy-daemon: ${e?.stack || e}`)
    process.exitCode = 1
  })
}
