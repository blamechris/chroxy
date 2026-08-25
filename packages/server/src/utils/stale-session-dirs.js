import { readdirSync, readFileSync, rmSync, statSync } from 'fs'

/**
 * Boot-time reaper for per-session scratch dirs under the OS tmpdir.
 *
 * A session removes its own dir in destroy(), but a CRASH leaks it forever, so
 * a long-lived host accumulates one dir per crashed session. Introduced for
 * `claude-tui`'s hook-sink dirs (#5323); generalised in #7337 when `claude-cli`
 * gained a per-session dir of its own for the permission-mode sidecar. It is
 * ONE implementation on purpose — a second hand-written copy of a
 * "delete directories under /tmp" loop is exactly the drift `docs/false-safety-guards.md`
 * catalogues, and this one deletes things.
 *
 * The ownership rule mirrors the worktree reaper's dead-pid-lock logic: each
 * dir carries an `owner.pid` written at creation, and a dir is removed only
 * when its owner is DEAD. A live owner — this just-booted daemon, or another
 * chroxy on the host — keeps its dirs, so the sweep is safe to run
 * unconditionally at boot: our own pid is alive, so we never delete a dir we
 * are about to use.
 */

/** Default grace for a pidfile-less dir. See the race note in sweepStaleOwnedDirs. */
export const OWNED_DIR_SWEEP_GRACE_MS = 60_000

/** Filename each owner stamps inside its dir so the sweep can probe liveness. */
export const OWNER_PID_FILE = 'owner.pid'

/**
 * @param {string} base      Parent dir to scan (e.g. `/tmp/chroxy-claude-tui`).
 * @param {object} [opts]
 * @param {string} [opts.prefix='s-']  Only entries with this prefix are considered.
 * @param {number} [opts.graceMs]      Grace for pidfile-less dirs.
 * @param {object} [opts.logger]       Logger with info/warn.
 * @param {string} [opts.label]        Human name for the log line.
 * @returns {{swept:number, kept:number}}
 */
export function sweepStaleOwnedDirs(base, { prefix = 's-', graceMs = OWNED_DIR_SWEEP_GRACE_MS, logger, label = base } = {}) {
  let entries
  try { entries = readdirSync(base) } catch { return { swept: 0, kept: 0 } }
  let swept = 0
  let kept = 0
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    const dir = `${base}/${name}`
    let ownerPid = null
    try {
      const n = parseInt(readFileSync(`${dir}/${OWNER_PID_FILE}`, 'utf8').trim(), 10)
      if (Number.isInteger(n) && n > 0) ownerPid = n
    } catch { /* no/garbage pidfile → orphaned, subject to the grace below */ }
    if (ownerPid !== null) {
      let alive
      try {
        process.kill(ownerPid, 0) // signal 0 = existence probe
        alive = true
      } catch (err) {
        // ESRCH → dead; EPERM → exists but not ours → still alive, keep it.
        alive = err && err.code === 'EPERM'
      }
      if (alive) { kept++; continue }
    } else {
      // #5359 review — a pidfile-less dir might be another process's dir caught
      // BETWEEN its mkdir and its owner.pid write (a cross-process race; within
      // one process those are synchronous). Give brand-new pidfile-less dirs a
      // grace window before reaping so we can't delete one mid-creation; a
      // genuinely orphaned dir is older than the grace and still gets swept.
      try {
        // #5332: wall-clock deliberately — compared against the filesystem
        // mtime (also wall-clock). A monotonic clock would be meaningless here.
        if (Date.now() - statSync(dir).mtimeMs < graceMs) {
          kept++
          continue
        }
      } catch { /* stat failed (dir vanished) → fall through to rmSync (no-op) */ }
    }
    try {
      rmSync(dir, { recursive: true, force: true })
      swept++
    } catch (err) {
      logger?.warn?.(`stale-dir sweep: failed to remove ${dir}: ${err.message}`)
    }
  }
  if (swept > 0) logger?.info?.(`Swept ${swept} stale ${label} dir(s) from ${base} (kept ${kept} live)`)
  return { swept, kept }
}
