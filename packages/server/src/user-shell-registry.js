/**
 * user-shell-registry.js (#6276, epic #5982) — a durable sidecar that records
 * the OS pid of each live embedded user-shell so a boot-time reaper can clean up
 * shells orphaned by an ungraceful daemon death.
 *
 * Why this exists: a user-shell is a raw `$SHELL` PTY (host RCE over the tunnel).
 * UserShellSessions are deliberately NEVER persisted across a daemon restart
 * (session-manager.js — restoring one would re-spawn a shell and bypass the
 * `userShell.enabled` gate). So on a CLEAN shutdown the shells are SIGTERM'd by
 * destroySession and nothing leaks. But on a SIGKILL / crash the daemon dies
 * without running teardown, and its node-pty shell children are reparented to
 * init — a leaked process with NO `user_shell_destroy` audit entry (the gap this
 * closes, swarm-audit 2026-06-22 Guardian/Planner).
 *
 * The sidecar mirrors the live set: a record is added when a shell spawns and
 * removed on clean destroy, so after a graceful shutdown the file is empty/absent
 * and the boot reaper is a no-op. After an ungraceful death the file retains the
 * last-known shells, which the reaper then reconciles.
 *
 * PID-reuse safety: the reaper only signals a recorded pid that is BOTH still
 * alive AND whose process-command basename still matches the recorded shell
 * (`ps -p <pid> -o comm=`). A still-alive orphan holds its pid (it can't have
 * been reused); a reused pid is very unlikely to also be the same shell binary —
 * so we never SIGTERM an innocent reused pid.
 *
 * All I/O is best-effort and the seams (`isAlive`/`commOf`/`kill`) are injectable
 * so the kill path is unit-testable without spawning or signalling a real
 * process, and so tests point the sidecar at a temp path (never the real
 * ~/.chroxy — the test sandbox guard, #4633).
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { basename } from 'path'
import { createLogger } from './logger.js'

const log = createLogger('user-shell-registry')

/**
 * Read the sidecar. Tolerates a missing or corrupt file (returns `[]`) — a
 * malformed sidecar must never crash boot or a shell spawn.
 * @returns {Array<{sessionId: string, pid: number, shell: string|null}>}
 */
export function readRegistry(path) {
  try {
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r) => r && typeof r.sessionId === 'string' && Number.isInteger(r.pid) && r.pid > 0)
  } catch {
    return []
  }
}

function writeRegistry(path, records) {
  // Atomic replace (tmp + rename) at 0600 — the file names host pids tied to a
  // privileged capability; match the session-state secrecy posture.
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Record a freshly-spawned user-shell's pid. Replaces any prior record for the
 * same sessionId (idempotent on respawn). Best-effort — a write failure is
 * logged, never thrown (it must not fail the shell spawn).
 */
export function recordShell(path, { sessionId, pid, shell } = {}) {
  if (typeof sessionId !== 'string' || !Number.isInteger(pid) || pid <= 0) return
  try {
    const records = readRegistry(path).filter((r) => r.sessionId !== sessionId)
    records.push({ sessionId, pid, shell: shell ? basename(shell) : null })
    writeRegistry(path, records)
  } catch (err) {
    log.warn(`failed to record user-shell ${sessionId} (non-fatal): ${err?.message || err}`)
  }
}

/**
 * Drop a user-shell's record on clean destroy. Deletes the file once empty so a
 * graceful shutdown leaves no sidecar for the next boot to scan.
 */
export function forgetShell(path, sessionId) {
  try {
    const records = readRegistry(path)
    if (!records.some((r) => r.sessionId === sessionId)) return
    const next = records.filter((r) => r.sessionId !== sessionId)
    if (next.length === 0) {
      if (existsSync(path)) unlinkSync(path)
    } else {
      writeRegistry(path, next)
    }
  } catch (err) {
    log.warn(`failed to forget user-shell ${sessionId} (non-fatal): ${err?.message || err}`)
  }
}

// Default seams — overridden in tests so the kill path is exercised without
// signalling a real process.
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = alive but not signallable by us.
    return err?.code === 'EPERM'
  }
}

function defaultCommOf(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

function defaultKill(pid) {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

/**
 * Boot-time reap: for each recorded shell, SIGTERM it iff it is still alive AND
 * its process-command basename matches the recorded shell (the PID-reuse safety
 * gate). The sidecar is cleared afterwards regardless — this daemon instance
 * starts fresh and live shells re-record on spawn.
 *
 * @returns {{ reaped: Array, skipped: Array }} reaped = signalled orphans (the
 *   caller emits a destroy-audit entry per item); skipped carries a `why` so the
 *   reason a record was left alone (dead / comm-mismatch / comm-unknown /
 *   kill-failed) is observable.
 */
export function reapOrphanShells(path, { isAlive = defaultIsAlive, commOf = defaultCommOf, kill = defaultKill } = {}) {
  const records = readRegistry(path)
  const reaped = []
  const skipped = []
  for (const r of records) {
    if (!isAlive(r.pid)) {
      skipped.push({ ...r, why: 'dead' })
      continue
    }
    // PID-reuse safety: never signal a live pid we can't positively identify as
    // the same shell binary we recorded.
    if (r.shell) {
      const comm = commOf(r.pid)
      const commBase = comm ? basename(comm) : null
      if (!commBase) {
        skipped.push({ ...r, why: 'comm-unknown' })
        continue
      }
      if (commBase !== r.shell) {
        skipped.push({ ...r, why: 'comm-mismatch', comm: commBase })
        continue
      }
    }
    if (kill(r.pid)) reaped.push(r)
    else skipped.push({ ...r, why: 'kill-failed' })
  }
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* best-effort — a leftover sidecar is reconciled on the next boot */
  }
  return { reaped, skipped }
}
