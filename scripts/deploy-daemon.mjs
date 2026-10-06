#!/usr/bin/env node
/**
 * deploy-daemon.mjs — idle-only automatic deploy of `main` to the daily daemon
 * (#8324).
 *
 * The daily daemon is `node packages/server/src/cli.js start --no-supervisor`
 * under launchd (KeepAlive=true), running out of a dedicated checkout. The
 * existing `chroxy deploy` command drives a SUPERVISOR over SIGUSR2 and runs
 * the full test suite; neither exists here, so this is a separate, small
 * mechanism built around three promises:
 *
 *   1. It never restarts the daemon while anything would be lost. "Idle" is
 *      asked of the daemon itself (GET /api/daemon/idle: no busy session, no
 *      pending permission or question, no parked hook permission). Every
 *      uncertainty — daemon unreachable, route missing, bad JSON — is "do not
 *      deploy", never "probably fine".
 *   2. It never leaves the checkout in a state the daemon was not started from
 *      without telling you. A failed build, a daemon that turns busy during the
 *      build, or a failed health check resets to the previous commit and
 *      rebuilds (and, for health, restarts again). A target that has already
 *      rolled back is not retried until main moves or --retry is passed.
 *   3. It is quiet. A tick with nothing to do prints one console line and
 *      writes nothing to deploy.log; a deferral is logged once per target, not
 *      once per tick.
 *
 * Everything outside this file's own logic is injected (`run`, `fetch`, `fs`,
 * `now`, `sleep`, `log`, ...) so scripts/__tests__/deploy-daemon.test.mjs
 * drives the whole flow without git, launchctl or a network. Imports are all
 * STATIC and resolved at process start: a fast-forward of this very checkout
 * mid-run cannot change what is already loaded.
 *
 * Usage:  node scripts/deploy-daemon.mjs [options]   (see --help)
 */

import { spawnSync } from 'node:child_process'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isEntryPoint } from './lib/is-entry-point.mjs'
import { isGitShaRef } from '../packages/server/src/utils/argv-safety.js'

export const DEFAULT_PORT = 8765
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
  --port <n>             daemon's local HTTP port (default: port in connection.json, else 8765)
  --health-timeout <s>   seconds to wait for the daemon to come back (default 90)
  --npm <path>           npm binary (default: npm, found via a PATH that starts with this node's directory)
  --dry-run              fetch, then report what would happen; change nothing
  --force                skip the idle checks (still does everything else)
  --no-tunnel-check      do not require the tunnel URL to answer /health
  --settle <s>           seconds to wait after health passes, then re-confirm the same pid
                         is alive and healthy (default 15)
  --retry                try a target that already rolled back (it is skipped otherwise)
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--checkout': opts.checkout = resolve(valueOf(i++, a)); break
      case '--config-dir': opts.configDir = resolve(valueOf(i++, a)); break
      case '--label': opts.label = valueOf(i++, a); break
      case '--branch': opts.branch = valueOf(i++, a); break
      case '--remote': opts.remote = valueOf(i++, a); break
      case '--npm': opts.npm = valueOf(i++, a); break
      case '--port': {
        const n = Number(valueOf(i++, a))
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port must be 1-65535')
        opts.port = n
        break
      }
      case '--health-timeout': {
        const n = Number(valueOf(i++, a))
        if (!Number.isFinite(n) || n <= 0) throw new Error('--health-timeout must be a positive number of seconds')
        opts.healthTimeoutS = n
        break
      }
      case '--dry-run': opts.dryRun = true; break
      case '--force': opts.force = true; break
      case '--no-tunnel-check': opts.tunnelCheck = false; break
      case '--retry': opts.retry = true; break
      case '--settle': {
        const n = Number(valueOf(i++, a))
        if (!Number.isFinite(n) || n < 0) throw new Error('--settle must be a non-negative number of seconds')
        opts.settleS = n
        break
      }
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
    run(cmd, args, { cwd, timeoutMs } = {}) {
      const r = spawnSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        env: { ...process.env, PATH: `${nodeDir}:${process.env.PATH || '/usr/bin:/bin'}` },
      })
      return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        error: r.error ? String(r.error.message || r.error) : null,
      }
    },
    fetch: globalThis.fetch,
    fs: { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    pid: process.pid,
    isPidAlive(pid) {
      try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
    },
  }
}

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 12) : '?')
const tail = (text, n = 12) => String(text || '').trim().split('\n').slice(-n).join('\n')

/**
 * Run one deploy attempt.
 * @returns {Promise<{ exitCode: number, outcome: string }>}
 *   outcome is one of: up-to-date, deployed, dry-run, deferred-busy,
 *   deferred-unavailable, restart-deferred, locked, refused, fetch-failed,
 *   rolled-back-build, rolled-back-health, rollback-failed, failed.
 */
export async function deploy(opts, deps = defaultDeps()) {
  const d = { ...defaultDeps(), ...deps }
  const { fs } = d
  const p = {
    lock: join(opts.configDir, 'deploy.lock'),
    log: join(opts.configDir, 'logs', 'deploy.log'),
    last: join(opts.configDir, 'last-deploy.json'),
    // Retired marker (a busy daemon after the build now rolls back instead of
    // parking a built checkout). Only ever deleted.
    legacyPending: join(opts.configDir, 'deploy-pending-restart.json'),
    state: join(opts.configDir, 'deploy-state.json'),
    conn: join(opts.configDir, 'connection.json'),
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
  const writeJson = (file, value) => {
    fs.mkdirSync(dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
  }

  // deploy.log gets one line per EVENT. `key` dedupes a repeating event (the
  // same deferral on every ten-minute tick) against the previous logged key.
  const state = readJson(p.state) || {}
  const saveState = () => { if (!opts.dryRun) { try { writeJson(p.state, state) } catch { /* best effort */ } } }
  function event(msg, { range = null, key = null } = {}) {
    const line = range ? `${range} ${msg}` : msg
    d.log(line)
    if (opts.dryRun) return
    if (key) {
      if (state.lastKey === key) return
      state.lastKey = key
    } else {
      state.lastKey = null
    }
    saveState()
    try {
      fs.mkdirSync(dirname(p.log), { recursive: true })
      fs.appendFileSync(p.log, `${iso()} ${range || '-'} ${msg}\n`)
    } catch { /* a log that cannot be written must not abort a deploy */ }
  }
  const rangeOf = (a, b) => `${short(a)}..${short(b)}`

  // ---- lock ---------------------------------------------------------------
  function readLockPid() {
    try {
      const n = Number(String(fs.readFileSync(p.lock, 'utf8')).trim())
      return Number.isInteger(n) && n > 0 ? n : null
    } catch { return null }
  }
  // Not airtight: two processes both reclaiming the SAME stale lock can race
  // between unlink and create. The agent ticks every ten minutes and the lock
  // exists to stop an overlapping tick or a hand-run beside it, so the window
  // is a pair of syscalls wide and the loser's `wx` open still fails.
  function acquireLock() {
    fs.mkdirSync(opts.configDir, { recursive: true })
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(p.lock, 'wx')
        fs.writeSync(fd, String(d.pid))
        fs.closeSync(fd)
        return { ok: true }
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
      const holder = readLockPid()
      if (holder !== null) {
        if (holder !== d.pid && d.isPidAlive(holder)) return { ok: false, holder }
      } else {
        // Empty/garbled lock: its owner may be between open() and write().
        let ageMs = Infinity
        try { ageMs = d.now() - fs.statSync(p.lock).mtimeMs } catch { /* gone: fall through */ }
        if (ageMs < 30_000) return { ok: false, holder: null }
      }
      try { fs.unlinkSync(p.lock) } catch { /* someone else reclaimed it */ }
    }
    return { ok: false, holder: null }
  }
  function releaseLock() {
    if (readLockPid() === d.pid) { try { fs.unlinkSync(p.lock) } catch { /* already gone */ } }
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

  // -> { kind: 'idle' | 'busy' | 'unavailable', reasons: string[] }
  async function checkIdle() {
    const conn = readConn()
    if (!conn || !conn.apiToken) return { kind: 'unavailable', reasons: ['no connection.json (daemon not running?)'] }
    if (conn.pid && !d.isPidAlive(conn.pid)) return { kind: 'unavailable', reasons: [`connection.json names pid ${conn.pid}, which is not running`] }
    let r
    try {
      r = await getJson(`http://127.0.0.1:${portOf(conn)}/api/daemon/idle`, { Authorization: `Bearer ${conn.apiToken}` })
    } catch (e) {
      return { kind: 'unavailable', reasons: [`daemon unreachable: ${e?.message || e}`] }
    }
    if (r.status === 404) {
      return { kind: 'unavailable', reasons: ['daemon has no /api/daemon/idle (it predates the route; deploy once by hand or with --force)'] }
    }
    if (r.status !== 200) return { kind: 'unavailable', reasons: [`/api/daemon/idle answered HTTP ${r.status}`] }
    if (!r.body || typeof r.body !== 'object' || typeof r.body.idle !== 'boolean') {
      return { kind: 'unavailable', reasons: ['/api/daemon/idle returned an unreadable body'] }
    }
    const reasons = Array.isArray(r.body.reasons) ? r.body.reasons.map(String) : []
    return r.body.idle === true ? { kind: 'idle', reasons } : { kind: 'busy', reasons: reasons.length ? reasons : ['busy'] }
  }

  // ---- build / restart ----------------------------------------------------
  const LONG = 20 * 60 * 1000
  function npmCi() {
    const r = d.run(npmBin, ['ci', '--no-audit', '--no-fund'], { cwd: opts.checkout, timeoutMs: LONG })
    return r.status === 0 ? { ok: true } : { ok: false, reason: `npm ci failed: ${tail(r.stderr || r.stdout || r.error)}` }
  }
  function buildDashboard() {
    const r = d.run(npmBin, ['run', 'build', '-w', '@chroxy/dashboard'], { cwd: opts.checkout, timeoutMs: LONG })
    return r.status === 0 ? { ok: true } : { ok: false, reason: `dashboard build failed: ${tail(r.stderr || r.stdout || r.error)}` }
  }
  function restartDaemon() {
    const r = d.run('launchctl', ['kill', 'SIGTERM', `gui/${d.uid}/${opts.label}`])
    return r.status === 0 ? { ok: true } : { ok: false, reason: `launchctl kill failed: ${tail(r.stderr || r.error)}` }
  }
  // The daemon is "back" only when connection.json names a DIFFERENT pid than
  // the one we signalled AND local /health answers 200: an old process that has
  // not exited yet can answer /health perfectly well, and that must not count.
  async function waitForHealthOnce(oldPid) {
    const timeoutMs = opts.healthTimeoutS * 1000
    const deadline = d.now() + timeoutMs
    let conn = null
    let lastWhy = 'daemon did not restart'
    while (d.now() < deadline) {
      conn = readConn()
      if (conn?.pid && conn.pid !== oldPid) {
        try {
          const r = await d.fetch(`http://127.0.0.1:${portOf(conn)}/health`, { signal: AbortSignal.timeout(5000) })
          if (r.status === 200) break
          lastWhy = `local /health answered HTTP ${r.status}`
        } catch (e) { lastWhy = `local /health: ${e?.message || e}` }
      } else {
        lastWhy = conn?.pid === oldPid ? `connection.json still names the old pid ${oldPid}` : 'connection.json not rewritten yet'
      }
      conn = null
      await d.sleep(1000)
    }
    if (!conn) return { ok: false, reason: lastWhy }

    const mode = conn.tunnelMode
    let tunnelHost = null
    try { tunnelHost = conn.httpUrl ? new URL(conn.httpUrl).hostname : null } catch { /* unparseable: skip */ }
    const localHost = !tunnelHost || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(tunnelHost)
    if (!opts.tunnelCheck || !mode || mode === 'none' || localHost) return { ok: true, pid: conn.pid }
    // The tunnel answers 530 for several seconds after a restart; retry through
    // that and through connection errors until the same budget runs out again.
    const tunnelDeadline = d.now() + timeoutMs
    while (d.now() < tunnelDeadline) {
      try {
        const r = await d.fetch(`${conn.httpUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(8000) })
        if (r.status === 200) return { ok: true, pid: conn.pid }
        lastWhy = `tunnel /health answered HTTP ${r.status}`
      } catch (e) { lastWhy = `tunnel /health: ${e?.message || e}` }
      await d.sleep(2000)
    }
    return { ok: false, reason: lastWhy }
  }

  // A build that answers /health and then dies seconds later must not count as
  // deployed. After health passes, wait out the settle window and re-confirm
  // that connection.json still names the SAME pid, that pid is alive, and local
  // /health still answers 200.
  async function settle(pid) {
    await d.sleep(opts.settleS * 1000)
    const conn = readConn()
    if (!conn?.pid || conn.pid !== pid) return { ok: false, reason: `after settling ${opts.settleS}s connection.json names pid ${conn?.pid ?? 'none'}, not ${pid} (the daemon restarted or exited)` }
    if (!d.isPidAlive(pid)) return { ok: false, reason: `after settling ${opts.settleS}s pid ${pid} is no longer running` }
    try {
      const r = await d.fetch(`http://127.0.0.1:${portOf(conn)}/health`, { signal: AbortSignal.timeout(5000) })
      if (r.status !== 200) return { ok: false, reason: `after settling ${opts.settleS}s local /health answered HTTP ${r.status}` }
    } catch (e) { return { ok: false, reason: `after settling ${opts.settleS}s local /health: ${e?.message || e}` } }
    return { ok: true }
  }
  async function waitForHealth(oldPid) {
    const up = await waitForHealthOnce(oldPid)
    return up.ok ? settle(up.pid) : up
  }

  // Remember a target that rolled back so later ticks do not retry it forever.
  function markFailed(target, outcome) {
    state.failedTarget = target
    state.failedOutcome = outcome
  }

  function recordResult(from, to, result) {
    let subject = ''
    try { subject = gitOut(['log', '-1', '--format=%s', to]) } catch { /* cosmetic */ }
    if (!opts.dryRun) {
      try { writeJson(p.last, { from, to, at: iso(), result, subject }) } catch { /* best effort */ }
    }
  }

  // Put the checkout (and its build) back to `old`. Used by both rollbacks.
  function rollbackCheckout(old, lockChanged) {
    if (!isGitShaRef(old)) return { ok: false, reason: `refusing to reset to a non-SHA ref` }
    const reset = git(['reset', '--hard', old])
    if (reset.status !== 0) return { ok: false, reason: `git reset --hard failed: ${tail(reset.stderr || reset.error)}` }
    if (lockChanged) {
      const ci = npmCi()
      if (!ci.ok) return ci
    }
    return buildDashboard()
  }

  // ======================================================================
  // main flow
  // ======================================================================
  if (opts.dryRun) d.log('[dry-run] no merge, build, restart or log write will happen')

  let held = false
  if (!opts.dryRun) {
    const lock = acquireLock()
    if (!lock.ok) {
      event(`another deploy holds ${p.lock}${lock.holder ? ` (pid ${lock.holder})` : ''}; skipping this run`, { key: 'locked' })
      return { exitCode: 0, outcome: 'locked' }
    }
    held = true
  }

  try {
    if (!opts.dryRun) { try { fs.unlinkSync(p.legacyPending) } catch { /* none */ } }
    // -- 2. clean tree on the branch ---------------------------------------
    if (!d.fs.existsSync(join(opts.checkout, '.git'))) {
      event(`refused: ${opts.checkout} is not a git checkout`, { key: 'not-a-checkout' })
      return { exitCode: 1, outcome: 'refused' }
    }
    const porcelain = git(['status', '--porcelain'])
    if (porcelain.status !== 0) {
      event(`refused: git status failed: ${tail(porcelain.stderr || porcelain.error)}`, { key: 'status-failed' })
      return { exitCode: 1, outcome: 'refused' }
    }
    if (porcelain.stdout.trim() !== '') {
      const head = (git(['rev-parse', 'HEAD']).stdout || '').trim()
      event(`refused: checkout has uncommitted changes (${porcelain.stdout.trim().split('\n').length} path(s)); not deploying over them`, { key: `dirty:${head}` })
      return { exitCode: 1, outcome: 'refused' }
    }
    const branchNow = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branchNow.status !== 0 || branchNow.stdout.trim() !== opts.branch) {
      event(`refused: checkout is on '${branchNow.stdout.trim() || '?'}', not '${opts.branch}'`, { key: `branch:${branchNow.stdout.trim()}` })
      return { exitCode: 1, outcome: 'refused' }
    }

    // -- 3. fetch + compare -------------------------------------------------
    const fetched = git(['fetch', opts.remote, opts.branch], { timeoutMs: 5 * 60 * 1000 })
    if (fetched.status !== 0) {
      event(`fetch failed: ${tail(fetched.stderr || fetched.error, 3)}`, { key: 'fetch-failed' })
      return { exitCode: 1, outcome: 'fetch-failed' }
    }
    const head = gitOut(['rev-parse', 'HEAD'])
    const remoteSha = gitOut(['rev-parse', '--verify', `refs/remotes/${opts.remote}/${opts.branch}^{commit}`])
    if (!FULL_SHA.test(head) || !FULL_SHA.test(remoteSha)) {
      event(`refused: could not resolve HEAD / ${opts.remote}/${opts.branch} to commit SHAs`, { key: 'unresolved' })
      return { exitCode: 1, outcome: 'refused' }
    }

    const old = head
    const target = remoteSha
    // A newer main clears a remembered failure.
    if (state.failedTarget && state.failedTarget !== target) {
      delete state.failedTarget
      delete state.failedOutcome
      saveState()
    }
    if (old === target) {
      d.log(`up to date at ${short(old)}`)
      return { exitCode: 0, outcome: 'up-to-date' }
    }
    const anc = git(['merge-base', '--is-ancestor', old, target])
    if (anc.status === 1) {
      event(`refused: local ${short(old)} is not an ancestor of ${opts.remote}/${opts.branch} ${short(target)} (diverged or ahead); fast-forward only`, { range: rangeOf(old, target), key: `non-ff:${old}:${target}` })
      return { exitCode: 1, outcome: 'refused' }
    }
    if (anc.status !== 0) {
      event(`refused: git merge-base failed: ${tail(anc.stderr || anc.error)}`, { key: 'merge-base-failed' })
      return { exitCode: 1, outcome: 'refused' }
    }
    const knownBad = state.failedTarget === target && !opts.retry
    const skipMsg = `skipped: ${short(target)} already rolled back (${state.failedOutcome || 'unknown'}); waiting for a newer main or --retry`
    if (knownBad && !opts.dryRun) {
      event(skipMsg, { range: rangeOf(old, target), key: `skipped:${target}` })
      return { exitCode: 0, outcome: 'skipped-failed-target' }
    }
    const range = rangeOf(old, target)
    const changed = gitOut(['diff', '--name-only', old, target]).split('\n').filter(Boolean)
    const lockChanged = changed.some((f) => LOCKFILE.test(f))

    // -- dry run -------------------------------------------------------------
    if (opts.dryRun) {
      const commits = gitOut(['log', '--format=%h %s', `${old}..${target}`])
      const idle = opts.force ? { kind: 'idle', reasons: ['--force'] } : await checkIdle()
      if (knownBad) d.log(`[dry-run] a real run would SKIP this target: ${skipMsg}`)
      d.log(`[dry-run] ${commits.split('\n').filter(Boolean).length} commit(s) ahead (${range}):`)
      if (commits) d.log(commits.split('\n').map((l) => `  ${l}`).join('\n'))
      d.log(`[dry-run] package-lock.json changed: ${lockChanged ? 'yes (npm ci will run)' : 'no'}`)
      d.log(`[dry-run] idle verdict: ${idle.kind}${idle.reasons.length ? ` (${idle.reasons.join('; ')})` : ''}`)
      d.log('[dry-run] commands, in order:')
      const steps = []
      steps.push(`git -C ${opts.checkout} merge --ff-only ${target}`)
      if (lockChanged) steps.push(`${npmBin} ci --no-audit --no-fund   (cwd ${opts.checkout})`)
      steps.push(`${npmBin} run build -w @chroxy/dashboard   (cwd ${opts.checkout})`)
      steps.push('idle check again; if busy now: reset to the old commit, rebuild, defer')
      steps.push(`launchctl kill SIGTERM gui/${d.uid}/${opts.label}`)
      steps.push(`wait for a NEW pid in ${p.conn} + GET /health${opts.tunnelCheck ? ' + tunnel /health' : ''} (${opts.healthTimeoutS}s), then settle ${opts.settleS}s and re-confirm the same pid`)
      for (const s of steps) d.log(`  ${s}`)
      return { exitCode: 0, outcome: 'dry-run' }
    }

    // -- 4. idle check -------------------------------------------------------
    async function gateOnIdle() {
      if (opts.force) return null
      const idle = await checkIdle()
      return idle.kind === 'idle' ? null : { idle }
    }
    const first = await gateOnIdle()
    if (first) {
      if (first.idle.kind === 'busy') {
        event(`deferred: busy (${first.idle.reasons.join('; ')})`, { range, key: `busy:${target}` })
        return { exitCode: 0, outcome: 'deferred-busy' }
      }
      event(`deferred: cannot confirm idle (${first.idle.reasons.join('; ')})`, { range, key: `unavailable:${target}` })
      return { exitCode: 0, outcome: 'deferred-unavailable' }
    }

    // -- 5. merge, install, build ---------------------------------------------
    if (!isGitShaRef(target)) { event('refused: target is not a SHA', { key: 'bad-target' }); return { exitCode: 1, outcome: 'refused' } }
    const merged = git(['merge', '--ff-only', target])
    if (merged.status !== 0) {
      event(`merge --ff-only failed: ${tail(merged.stderr || merged.stdout || merged.error, 3)}`, { range })
      return { exitCode: 1, outcome: 'failed' }
    }
    let built = lockChanged ? npmCi() : { ok: true }
    if (built.ok) built = buildDashboard()
    if (!built.ok) {
      const back = rollbackCheckout(old, lockChanged)
      if (back.ok) {
        markFailed(target, 'rolled-back-build')
        recordResult(old, target, 'rolled-back-build')
        event(`rolled-back (build failed: ${built.reason})`, { range })
        return { exitCode: 1, outcome: 'rolled-back-build' }
      }
      markFailed(target, 'rollback-failed')
      recordResult(old, target, 'rollback-failed')
      event(`ROLLBACK-FAILED after a failed build (${built.reason}); rollback error: ${back.reason}. The checkout may not match what the daemon is running; the daemon itself was not touched.`, { range })
      return { exitCode: 1, outcome: 'rollback-failed' }
    }

    // -- 6. idle again: the build took time ---------------------------------
    // A turn that started during the build must not be left running under a
    // daemon whose dashboard dist (served from disk) and files no longer match
    // it, possibly for hours. Put the old tree back and try again next tick.
    const second = await gateOnIdle()
    if (second) {
      const why = `${second.idle.kind === 'busy' ? 'busy' : 'cannot confirm idle'} (${second.idle.reasons.join('; ')})`
      const back = rollbackCheckout(old, lockChanged)
      if (!back.ok) {
        markFailed(target, 'rollback-failed')
        recordResult(old, target, 'rollback-failed')
        event(`ROLLBACK-FAILED after the daemon turned ${why}; rollback error: ${back.reason}. The checkout is at the new commit and the daemon was not restarted.`, { range })
        return { exitCode: 1, outcome: 'rollback-failed' }
      }
      event(`deferred after build: ${why}`, { range, key: `busy-after-build:${target}` })
      return { exitCode: 0, outcome: 'deferred-busy-after-build' }
    }

    // -- 7-10. restart, verify, roll back on failure ---------------------------
    const beforePid = readConn()?.pid ?? null
    const killed = restartDaemon()
    if (!killed.ok) {
      // Nothing was signalled, so the daemon still runs the OLD code. Put the
      // disk back to match it rather than leave a checkout the daemon is not on.
      const back = rollbackCheckout(old, lockChanged)
      markFailed(target, back.ok ? 'failed-restart' : 'rollback-failed')
      recordResult(old, target, back.ok ? 'rolled-back-restart' : 'rollback-failed')
      event(`${back.ok ? 'rolled-back' : 'ROLLBACK-FAILED'} (restart failed: ${killed.reason}${back.ok ? '' : `; ${back.reason}`})`, { range })
      return { exitCode: 1, outcome: back.ok ? 'failed-restart' : 'rollback-failed' }
    }
    const health = await waitForHealth(beforePid)
    if (health.ok) {
      delete state.failedTarget
      delete state.failedOutcome
      recordResult(old, target, 'ok')
      event('ok', { range })
      return { exitCode: 0, outcome: 'deployed' }
    }

    // Health failed: restore the previous build and restart onto it.
    const back = rollbackCheckout(old, lockChanged)
    if (!back.ok) {
      markFailed(target, 'rollback-failed')
      recordResult(old, target, 'rollback-failed')
      event(`ROLLBACK-FAILED (health failed: ${health.reason}; rollback error: ${back.reason}). The daemon may be down or on a half-built checkout.`, { range })
      return { exitCode: 1, outcome: 'rollback-failed' }
    }
    const pidNow = readConn()?.pid ?? null
    // A failed kill here does not end it: if the new build crashed, launchd is
    // already relaunching the service (now on the restored checkout) and there
    // may be nothing left to signal. Wait for a pid that is not `pidNow` either way.
    const again = restartDaemon()
    const healthAgain = await waitForHealth(pidNow)
    if (!healthAgain.ok && !again.ok) healthAgain.reason += ` (${again.reason})`
    if (healthAgain.ok) {
      markFailed(target, 'rolled-back-health')
      recordResult(old, target, 'rolled-back-health')
      event(`rolled-back (health failed: ${health.reason})`, { range })
      return { exitCode: 1, outcome: 'rolled-back-health' }
    }
    markFailed(target, 'rollback-failed')
    recordResult(old, target, 'rollback-failed')
    event(`ROLLBACK-FAILED (health failed: ${health.reason}; after rollback: ${healthAgain.reason}). The daemon is not healthy; check launchd and ${p.log}.`, { range })
    return { exitCode: 1, outcome: 'rollback-failed' }
  } catch (e) {
    event(`failed: ${e?.message || e}`, { key: `error:${e?.message}` })
    return { exitCode: 1, outcome: 'failed' }
  } finally {
    if (held) releaseLock()
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
