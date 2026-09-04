// Orphaned-child reaper (#7606).
//
// A session's provider CLI spawns work (`bash -c` → `node --test`, …). When
// the session ends — destroy, respawn, tool timeout, daemon crash — the direct
// child is killed but anything it spawned is reparented to pid 1 and keeps
// running. On 2026-09-03 four such `node --test` runners, orphaned from a
// chroxy worktree on 2026-08-26, had run 7.5 days at 91% CPU and ~50 GB each
// before macOS ran out of application memory. `killProcessTree` (#7606) now
// signals the whole tree at the kill sites, but that only covers a kill the
// daemon performs: a daemon that crashed, or a child that outlived a
// `--test-force-exit`, still leaves orphans. This sweep is the backstop.
//
// The predicate is deliberately narrow — a process is reaped only when ALL of:
//   - it is reparented to pid 1 (no live parent, so no session owns it)
//   - it is owned by this uid (never signal another user's process)
//   - its cwd is INSIDE chroxy's own session-worktree root
//     (`configPath('worktrees')`), a directory only chroxy creates entries in
//   - it has been alive for at least `minAgeMs` (a fresh orphan is usually a
//     respawn in flight, and a real leak is measured in hours)
//   - it is not this daemon
// "Cannot check" is never "nothing to check" (docs/false-safety-guards.md): a
// cwd lookup that is unavailable disables the sweep LOUDLY rather than
// reaping on a partial view, and an unresolvable pid is skipped, never guessed.
//
// Default ON (`config.orphanReap.enabled !== false`) — unlike the worktree
// auto-reaper, whose failure mode is a deleted directory, this one's is a
// SIGKILL to a process that by construction nothing is waiting on.
//
// POSIX only. Windows has no ppid-1 reparenting convention and `taskkill /T`
// at the kill sites already reaps the tree there; the sweep is a no-op.

import { execFileSync } from 'child_process'
import { readlinkSync, realpathSync } from 'fs'
import { resolve, sep } from 'path'
import { configPath } from './config-dir.js'

export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000
export const DEFAULT_MIN_AGE_MS = 10 * 60 * 1000

/**
 * Parse a `ps` `etime` column — `[[dd-]hh:]mm:ss` — into milliseconds.
 * Returns null for anything unparseable (a null age never satisfies the
 * min-age check, so a malformed row is skipped rather than reaped).
 */
export function parseEtime(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return null
  const days = Number(m[1] || 0)
  const hours = Number(m[2] || 0)
  const mins = Number(m[3])
  const secs = Number(m[4])
  return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000
}

/**
 * Parse the raw table from `ps -axo pid=,ppid=,uid=,etime=,args=` into rows.
 * `args` is everything after the fourth column (it contains spaces). Rows
 * that do not have four leading numeric/etime columns are dropped.
 */
export function parseProcessTable(text) {
  const rows = []
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!m) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      ageMs: parseEtime(m[4]),
      args: m[5],
    })
  }
  return rows
}

/**
 * Parse `lsof -a -d cwd -p <pids> -Fpn` output (`p<pid>` then `n<path>`
 * lines) into a pid → cwd map. A pid line with no following `n` line is
 * absent from the map (lsof could not resolve it), never defaulted.
 */
export function parseLsofCwd(text) {
  const out = new Map()
  let cur = null
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('p')) { cur = Number(line.slice(1)); continue }
    if (line.startsWith('n') && cur !== null) { out.set(cur, line.slice(1)); cur = null }
  }
  return out
}

function defaultListProcesses() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,uid=,etime=,args='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  })
}

/**
 * Resolve cwds with one `lsof` call for the whole batch (macOS: no procfs).
 * Exported for tests; `exec` is the `execFileSync` seam.
 *
 * `lsof` exits 1 whenever ANY pid in `-p <list>` has vanished or cannot be
 * opened — even though it resolved and printed every other pid. With ~300
 * ppid-1 candidates on a real Mac, one of them exiting between the `ps`
 * listing and this call is routine, so a nonzero exit with stdout present is
 * a PARTIAL result to parse, not a failure. Only a spawn failure (ENOENT), a
 * timeout, or a signal death means the mechanism is unavailable (#7608 review).
 */
export function resolveCwdsViaLsof(pids, exec = execFileSync) {
  const args = ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }
  let text
  try {
    text = exec('lsof', args, opts)
  } catch (err) {
    if (err && typeof err.status === 'number' && err.stdout != null) text = String(err.stdout)
    else throw err
  }
  return parseLsofCwd(text)
}

/**
 * Resolve cwds from procfs (Linux). Exported for tests; `readlink` is the
 * seam. A single unreadable pid is skipped (it exited, or is not ours) — but
 * if NOTHING resolved out of a non-empty batch, procfs itself is unavailable
 * (`hidepid=2`, a minimal container) and that is "cannot check", which must
 * be loud (docs/false-safety-guards.md), not a quiet empty sweep.
 */
export function resolveCwdsViaProcfs(pids, readlink = readlinkSync) {
  const out = new Map()
  for (const pid of pids) {
    try { out.set(pid, readlink(`/proc/${pid}/cwd`)) } catch { /* gone or unreadable */ }
  }
  if (pids.length > 0 && out.size === 0) {
    throw new Error('/proc/<pid>/cwd unreadable for every candidate (procfs unavailable or hidden)')
  }
  return out
}

/**
 * Resolve the cwd of each pid. Returns a Map; a pid whose cwd cannot be read
 * is absent. Throws only when the MECHANISM is unavailable, which the caller
 * treats as "cannot check".
 */
function defaultCwdOf(pids) {
  if (pids.length === 0) return new Map()
  return process.platform === 'linux' ? resolveCwdsViaProcfs(pids) : resolveCwdsViaLsof(pids)
}

function isUnder(path, base) {
  const p = resolve(path)
  const b = resolve(base)
  return p === b || p.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * One sweep. Pure aside from the injected seams. Never throws.
 *
 * @param {object} args
 * @param {string} args.worktreeBase - chroxy's session-worktree root
 * @param {number} [args.minAgeMs]
 * @param {object} [args.deps] - test seams: listProcesses (called twice: list, then
 *   re-verify before signalling), cwdOf, kill, uid, selfPid, platform, realpath
 * @returns {{ scanned: number, candidates: number, unresolved: number, reaped: object[], skipped: object[], error: string|null }}
 */
export function sweepOrphans({ worktreeBase, minAgeMs = DEFAULT_MIN_AGE_MS, deps = {} } = {}) {
  const report = { scanned: 0, candidates: 0, unresolved: 0, reaped: [], skipped: [], error: null }
  const platform = deps.platform || process.platform
  if (platform === 'win32') return report
  if (!worktreeBase) { report.error = 'no worktree base'; return report }

  const listProcesses = deps.listProcesses || defaultListProcesses
  const cwdOf = deps.cwdOf || defaultCwdOf
  const kill = deps.kill || process.kill
  const uid = Number.isInteger(deps.uid) ? deps.uid : (typeof process.getuid === 'function' ? process.getuid() : -1)
  const selfPid = deps.selfPid || process.pid
  // As root the uid predicate matches EVERY process, and inside a container
  // pid 1 is a live entrypoint whose children are owned, not orphaned — the
  // remaining cwd check would be the only guard. Refuse rather than widen.
  if (uid === 0) { report.error = 'running as root: the uid predicate cannot distinguish orphans'; return report }
  // lsof and /proc report REAL paths; compare against the real base, or a
  // symlink anywhere in the chain (/tmp → /private/tmp, a linked $HOME) makes
  // every comparison fail and the sweep a permanent silent no-op.
  const realpath = deps.realpath || realpathSync
  let base = worktreeBase
  try { base = realpath(worktreeBase) } catch { /* base does not exist yet — nothing can be under it */ }

  let rows
  try { rows = parseProcessTable(listProcesses()) } catch (err) {
    report.error = `process listing failed: ${(err && err.message) || err}`
    return report
  }
  report.scanned = rows.length

  const candidates = rows.filter((r) =>
    r.ppid === 1 &&
    r.uid === uid &&
    r.pid !== selfPid &&
    r.ageMs !== null && r.ageMs >= minAgeMs,
  )
  report.candidates = candidates.length
  if (candidates.length === 0) return report

  let cwds
  try { cwds = cwdOf(candidates.map((r) => r.pid)) } catch (err) {
    // "Cannot check" must not become "nothing to check": surface it and reap
    // nothing this tick.
    report.error = `cwd lookup unavailable: ${(err && err.message) || err}`
    return report
  }

  const targets = candidates.filter((r) => {
    const cwd = cwds.get(r.pid)
    // Unresolvable is routine (exited since listing, or not ours to read) and
    // most of these have nothing to do with chroxy — count, never warn per pid.
    if (!cwd) { report.unresolved += 1; return false }
    return isUnder(cwd, base)
  })
  if (targets.length === 0) return report

  // PID-reuse safety (same invariant as user-shell-registry.js): re-list
  // immediately before signalling and require each target to STILL be
  // reparented to pid 1 with an age no younger than first seen. A pid the OS
  // recycled between the first listing and now shows a fresh etime and is
  // skipped — never signal a pid we cannot positively re-identify.
  let recheck
  try { recheck = new Map(parseProcessTable(listProcesses()).map((r) => [r.pid, r])) } catch (err) {
    report.error = `re-verification listing failed: ${(err && err.message) || err}`
    return report
  }

  for (const r of targets) {
    const now = recheck.get(r.pid)
    if (!now) continue // exited on its own between listings
    if (now.ppid !== 1 || now.ageMs === null || now.ageMs < r.ageMs) {
      report.skipped.push({ pid: r.pid, reason: 'pid changed identity between listings' })
      continue
    }
    const cwd = cwds.get(r.pid)
    try {
      kill(r.pid, 'SIGKILL')
      report.reaped.push({ pid: r.pid, ageMs: r.ageMs, cwd, args: r.args })
    } catch (err) {
      report.skipped.push({ pid: r.pid, reason: `kill failed: ${(err && err.code) || (err && err.message) || err}` })
    }
  }
  return report
}

function isEnabled(config) {
  if (!config || !config.orphanReap) return true
  return config.orphanReap.enabled !== false
}

/**
 * Run one sweep against the configured worktree root and log a manifest.
 * Returns null when disabled by config or on Windows.
 *
 * @param {object} config - merged server config
 * @param {{ info: Function, warn: Function }} log
 * @param {object} [deps] - sweepOrphans seams plus `worktreeBase`
 */
export function maybeReapOrphans(config, log, deps = {}) {
  if (!isEnabled(config)) return null
  if ((deps.platform || process.platform) === 'win32') return null
  const cfgMinAge = config && config.orphanReap ? config.orphanReap.minAgeMs : undefined
  const minAgeMs = Number.isFinite(cfgMinAge) && cfgMinAge >= 0 ? cfgMinAge : DEFAULT_MIN_AGE_MS
  const worktreeBase = deps.worktreeBase || configPath('worktrees')
  const report = sweepOrphans({ worktreeBase, minAgeMs, deps })
  if (report.error) {
    log.warn(`orphan-reaper: sweep skipped — ${report.error}`)
    return report
  }
  for (const r of report.reaped) {
    log.warn(`orphan-reaper: killed pid ${r.pid} (ppid 1, ${Math.round(r.ageMs / 60000)} min, cwd ${r.cwd}): ${r.args}`)
  }
  for (const s of report.skipped) {
    log.warn(`orphan-reaper: skipped pid ${s.pid}: ${s.reason}`)
  }
  if (report.reaped.length > 0) {
    log.info(`orphan-reaper: reaped ${report.reaped.length} orphan(s) under ${worktreeBase} (${report.candidates} candidate(s) of ${report.scanned} scanned, ${report.unresolved} cwd-unresolved)`)
  }
  return report
}

/**
 * Start the reaper for the lifetime of the daemon: one sweep now, then every
 * `config.orphanReap.sweepIntervalMs` (default 5 min). Mirrors
 * `startPeriodicAutoReap` in worktree-reaper.js: unref'd interval, reentrancy
 * guard, a failing sweep is logged and never propagates. Returns null when
 * disabled or on Windows.
 *
 * @returns {ReturnType<typeof setInterval>|null}
 */
export function startPeriodicOrphanReap(config, log, deps = {}) {
  if (!isEnabled(config)) return null
  if ((deps.platform || process.platform) === 'win32') return null

  const run = deps.run || maybeReapOrphans
  let sweeping = false
  const sweep = () => {
    if (sweeping) return
    sweeping = true
    try {
      run(config, log, deps)
    } catch (err) {
      log.warn(`orphan-reaper failed: ${(err && err.message) || err}`)
    } finally {
      sweeping = false
    }
  }

  sweep()

  const configured = config && config.orphanReap ? config.orphanReap.sweepIntervalMs : undefined
  const intervalMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SWEEP_INTERVAL_MS
  const setIntervalFn = deps.setIntervalFn || setInterval
  const timer = setIntervalFn(sweep, intervalMs)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}
