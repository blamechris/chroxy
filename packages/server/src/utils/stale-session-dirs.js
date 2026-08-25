import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'

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
    const dir = join(base, name)
    let ownerPid = null
    try {
      // statSync + isFile() BEFORE the read: readFileSync on a FIFO blocks
      // forever with no timeout, so a planted `owner.pid` fifo would hang the
      // daemon's boot sweep. A non-regular pidfile is treated as garbage, which
      // routes to the grace-window branch below — the safe default for an orphan.
      const pidPath = join(dir, OWNER_PID_FILE)
      if (statSync(pidPath).isFile()) {
        const n = parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
        if (Number.isInteger(n) && n > 0) ownerPid = n
      }
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

/**
 * Create (or adopt) the shared BASE dir that per-session dirs live under, and
 * refuse to use one an attacker could have prepared.
 *
 * `mkdirSync(base, { recursive: true })` returns silently when `base` already
 * exists — INCLUDING when it is a symlink to a directory — and then creates
 * children through it. On Linux `os.tmpdir()` is the shared `/tmp`, so another
 * local user can pre-create `/tmp/chroxy-claude-cli` (or point it elsewhere)
 * and then substitute a session dir whose `permission-mode` reads `auto`. The
 * hook re-reads that file on every tool call, so the substitution decides
 * whether tool calls are prompted. macOS is unaffected — its `$TMPDIR` is a
 * per-user directory at 0700 — which is exactly why this needs an explicit
 * check rather than a platform assumption.
 *
 * Throws when the base is a symlink, is not ours, or is group/other-writable.
 * Callers are expected to treat that as "no sidecar" and degrade, not to fail
 * session start.
 *
 * @param {string} base Directory to create or adopt.
 * @returns {string} `base`, once it is safe to write into.
 */
export function ensureOwnedBaseDir(base) {
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const st = lstatSync(base)
  if (st.isSymbolicLink()) {
    throw new Error(`${base} is a symlink — refusing to write session state through it`)
  }
  if (!st.isDirectory()) {
    throw new Error(`${base} exists and is not a directory`)
  }
  // getuid is POSIX-only; on Windows there is no uid and the per-user profile
  // tmpdir already provides the isolation this check is standing in for.
  const uid = process.getuid?.()
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`${base} is owned by uid ${st.uid}, not ${uid} — refusing to adopt it`)
  }
  // mkdir's mode is masked by umask, and an ADOPTED dir keeps whatever mode it
  // already had — so re-assert rather than trust the create.
  if (st.mode & 0o077) chmodSync(base, 0o700)
  return base
}
