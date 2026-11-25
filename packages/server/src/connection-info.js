import { join } from 'path'
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { writeFileRestricted } from './platform.js'
import { configDir, configPath } from './config-dir.js'
import { probePidLiveness, PID_ALIVE, PID_DEAD } from './utils/pid-liveness.js'

export function getConnectionInfoPath() {
  return configPath('connection.json')
}

export function writeConnectionInfo(info) {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  writeFileRestricted(join(dir, 'connection.json'), JSON.stringify(info, null, 2))
}

/**
 * The daemon's discovery record, returned ONLY when its recorded PID is verified
 * alive (#9074). Every other outcome returns null:
 * - no file, or an unreadable file;
 * - a record with a missing or malformed pid;
 * - a dead pid (ESRCH);
 * - an unverified pid (EPERM under a sandbox, or any other probe error; see
 *   utils/pid-liveness.js).
 *
 * Callers use the record to send the daemon's primary bearer to a loopback port, so
 * "could not verify" fails closed exactly like "not running". "Alive" is the probe's
 * claim only: some process with that PID exists. It is not proof that the process
 * is the daemon, or that the daemon listens on the recorded port.
 *
 * Deletion: before #9074 this read deleted the record on ANY probe error. The existing
 * cleanup for a pid proven dead (ESRCH) is retained. Every other failure (EPERM, any
 * other probe error, a missing or malformed pid) now preserves the record: "could not
 * verify" is not "dead".
 *
 * Known, pre-existing race (documented, not introduced here): a reader can probe the
 * old record's dead PID, a restarting daemon can then write its own record, and this
 * unlink removes the new one. What this call does in that case: it returns null and
 * transmits no credential. No claim is made here about what callers do next. Until
 * the daemon writes its record again, readers find none.
 *
 * This reader still collapses "unverified" and "not running" into null. A caller that
 * must word them differently uses `readConnectionState()` below (#9229).
 *
 * @param {{ probePidLiveness?: (pid: unknown) => 'alive' | 'dead' | 'unverified' }} [deps]
 * @returns {object|null}
 */
export function readConnectionInfo(deps = {}) {
  return readConnectionState(deps).info
}

/**
 * Why `readConnectionState()` returned no record (#9229). `info` is non-null only
 * for `CONNECTION_ALIVE`.
 */
export const CONNECTION_ALIVE = 'alive'
/** No file, an unreadable or unparseable file, or a non-object record. */
export const CONNECTION_NO_RECORD = 'no_record'
/** The recorded pid is proven gone (ESRCH); the stale record was removed. */
export const CONNECTION_DEAD = 'dead'
/** Liveness could not be established (EPERM, other probe error, missing/malformed pid). The record is kept. */
export const CONNECTION_LIVENESS_UNVERIFIED = 'liveness_unverified'

/**
 * `readConnectionInfo()` plus the reason, so a CLI can word "no daemon" and "could not
 * verify the daemon is running" differently. This is the ONE implementation:
 * `readConnectionInfo()` returns `.info` of this, so the two cannot disagree about
 * when a record (and with it the bearer token) is handed out. `info` is non-null ONLY
 * when the probe says `alive`; `dead` and `unverified` both carry `info: null`.
 * Deletion is unchanged: only `dead` unlinks.
 *
 * @param {{ probePidLiveness?: (pid: unknown) => 'alive' | 'dead' | 'unverified' }} [deps]
 * @returns {{ info: object, reason: 'alive' } | { info: null, reason: 'no_record'|'dead'|'liveness_unverified' }}
 */
export function readConnectionState(deps = {}) {
  const probe = typeof deps.probePidLiveness === 'function' ? deps.probePidLiveness : probePidLiveness
  const connFile = getConnectionInfoPath()
  if (!existsSync(connFile)) return { info: null, reason: CONNECTION_NO_RECORD }
  let info
  try {
    info = JSON.parse(readFileSync(connFile, 'utf-8'))
  } catch {
    return { info: null, reason: CONNECTION_NO_RECORD }
  }
  if (!info || typeof info !== 'object') return { info: null, reason: CONNECTION_NO_RECORD }
  const liveness = probe(info.pid)
  if (liveness === PID_DEAD) {
    removeConnectionInfo() // the existing ESRCH cleanup, retained (see above)
    return { info: null, reason: CONNECTION_DEAD }
  }
  if (liveness === PID_ALIVE) return { info, reason: CONNECTION_ALIVE }
  return { info: null, reason: CONNECTION_LIVENESS_UNVERIFIED }
}

export function removeConnectionInfo() {
  try { unlinkSync(getConnectionInfoPath()) } catch {}
}
