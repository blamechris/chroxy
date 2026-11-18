/**
 * PID liveness, classified honestly (#9074).
 *
 * `process.kill(pid, 0)` sends no signal; it only asks the OS whether `pid` can be
 * signalled by this caller. Only one of its outcomes is conclusive:
 *
 *   ESRCH     -> 'dead'        no process has this PID. The only proof of absence.
 *   succeeds  -> 'alive'       some process with this PID exists and this caller
 *                              may signal it. That is all it shows. It does NOT
 *                              prove the process is the daemon that wrote the
 *                              record (a PID can be reused after an unclean exit),
 *                              nor that anything is listening on the record's port.
 *   EPERM     -> 'unverified'  the probe was not permitted. This often means a
 *                              process exists that this caller may not signal
 *                              (another user's, or one a sandbox hides), but a
 *                              sandbox may also deny the probe outright, so it
 *                              proves neither existence nor absence.
 *   any other -> 'unverified'  the probe failed for a reason that proves nothing.
 *
 * A PID that is not a positive safe integer is never probed and is 'unverified':
 * `kill(0, 0)` and `kill(-n, 0)` address process GROUPS (the caller's own, for 0),
 * so a malformed record with pid 0 would otherwise read as alive.
 *
 * Callers must treat 'unverified' as "do not know": never as healthy (do not send
 * credentials on it) and never as dead (do not delete what it describes).
 */

export const PID_ALIVE = 'alive'
export const PID_DEAD = 'dead'
export const PID_UNVERIFIED = 'unverified'

/**
 * @param {unknown} pid
 * @param {{ kill?: (pid: number, signal: number) => void }} [deps] - probe seam for
 *   tests; defaults to `process.kill`, looked up at call time
 * @returns {'alive' | 'dead' | 'unverified'}
 */
export function probePidLiveness(pid, deps = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return PID_UNVERIFIED
  const kill = typeof deps.kill === 'function' ? deps.kill : (p, s) => process.kill(p, s)
  try {
    kill(pid, 0)
    return PID_ALIVE
  } catch (err) {
    return err && err.code === 'ESRCH' ? PID_DEAD : PID_UNVERIFIED
  }
}
