import { writeFileSync, chmodSync, renameSync } from 'fs'

export const isWindows = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'

export function defaultShell() {
  if (isWindows) return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/zsh'
}

/**
 * Write `data` to `filePath` atomically on POSIX (write to `<path>.tmp`
 * then `rename` over the target). `rename` is atomic on the same
 * filesystem, so a concurrent reader sees either the previous version
 * or the new one — never a half-written file. This matters when the
 * process is killed mid-write (SIGKILL / OOM); it is the file-level
 * analogue of the "SIGTERM not SIGKILL for Chroxy" memory note. See
 * #4850, which surfaced this gap for `connection.json` (pre-existing)
 * and `device-preferences.json` (added in #4847).
 *
 * On Windows we keep the direct `writeFileSync` path — `rename`
 * semantics differ (it fails when the destination exists unless you
 * use `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`) and there is no ACL
 * machinery here that needs the atomic guarantee yet.
 */
export function writeFileRestricted(filePath, data) {
  if (isWindows) {
    writeFileSync(filePath, data)
  } else {
    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, data, { mode: 0o600 })
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, filePath)
  }
}

export function forceKill(child) {
  if (isWindows) {
    child.kill('SIGKILL')
  } else {
    child.kill('SIGKILL')
  }
}
