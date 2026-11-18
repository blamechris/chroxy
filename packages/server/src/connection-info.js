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
 * Known debt (#9074, deferred): CLI callers get null for "unverified" exactly as for
 * "not running", so they fail closed but still word it as "not running". Reporting
 * unverified liveness truthfully in those CLIs and in `status` is follow-up work.
 * This reader does not claim to fix status semantics.
 *
 * @param {{ probePidLiveness?: (pid: unknown) => 'alive' | 'dead' | 'unverified' }} [deps]
 * @returns {object|null}
 */
export function readConnectionInfo(deps = {}) {
  const probe = typeof deps.probePidLiveness === 'function' ? deps.probePidLiveness : probePidLiveness
  const connFile = getConnectionInfoPath()
  if (!existsSync(connFile)) return null
  let info
  try {
    info = JSON.parse(readFileSync(connFile, 'utf-8'))
  } catch {
    return null
  }
  if (!info || typeof info !== 'object') return null
  const liveness = probe(info.pid)
  if (liveness === PID_DEAD) {
    removeConnectionInfo() // the existing ESRCH cleanup, retained (see above)
    return null
  }
  return liveness === PID_ALIVE ? info : null
}

export function removeConnectionInfo() {
  try { unlinkSync(getConnectionInfoPath()) } catch {}
}
