import { join } from 'path'
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { writeFileRestricted } from './platform.js'
import { configDir, configPath } from './config-dir.js'
import { probePidLiveness, PID_ALIVE } from './utils/pid-liveness.js'

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
 * This read never deletes the file, whatever it finds. A read-time unlink races a
 * restarting daemon: the reader can probe the old record's dead PID, the new daemon
 * can write its own record, and the unlink then removes the LIVE one. The record's
 * lifecycle belongs to its writer, which overwrites it at start (supervisor,
 * startup display) and removes it at shutdown (`removeConnectionInfo`). A stale
 * record left by a crash is replaced by the next start.
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
  return probe(info.pid) === PID_ALIVE ? info : null
}

export function removeConnectionInfo() {
  try { unlinkSync(getConnectionInfoPath()) } catch {}
}
