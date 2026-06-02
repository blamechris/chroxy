import { writeFileSync, chmodSync, renameSync, unlinkSync } from 'fs'
import { createLogger } from './logger.js'

const log = createLogger('platform')

export const isWindows = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'

export function defaultShell() {
  if (isWindows) return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/zsh'
}

/**
 * Write `data` to `filePath` atomically on both POSIX and Windows. The
 * write goes to a sibling temp file `<filePath><tmpSuffix>` first and is
 * then `rename`d over the destination. `rename` is atomic on the same
 * filesystem on both POSIX (POSIX.1 `rename(2)`) and Windows (Node's
 * `fs.renameSync` calls `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING |
 * MOVEFILE_WRITE_THROUGH` since v16), so a concurrent reader sees either
 * the previous version or the new one — never a half-written file. This
 * matters when the process is killed mid-write (SIGKILL / OOM); it is
 * the file-level analogue of the "SIGTERM not SIGKILL for Chroxy"
 * memory note. See #4850 (the original POSIX gap for `connection.json`
 * and `device-preferences.json`) and #4913 (extension of the same
 * crash-safety contract to Windows, after #4874 collapsed manual
 * tmp+rename wrappers in `environment-manager.js` and `models.js` onto
 * this helper).
 *
 * The temp file lives in the same directory as `filePath` (not
 * `os.tmpdir()`) so the rename always stays within the same filesystem /
 * volume. A cross-volume rename would fail with EXDEV on POSIX and
 * ERROR_NOT_SAME_DEVICE on Windows and silently defeat the atomic
 * guarantee.
 *
 * On POSIX the temp file is created with `0o600` and `chmod`ed for
 * defence-in-depth before the rename. On Windows we deliberately do NOT
 * pass `mode` to `writeFileSync` — Node maps the integer mode argument
 * through `_open` on Windows where only the write bit (`0o200`) toggles
 * the read-only attribute; the read / group / other bits are silently
 * ignored. ACL inheritance from the parent directory is the correct
 * mechanism on NTFS, and our existing storage paths (`~/.chroxy/`,
 * `%APPDATA%/Chroxy/`) inherit user-only ACLs from the per-user profile
 * directory that Chroxy creates them under. See #4913 for the threat
 * model discussion.
 *
 * Options:
 *   - `tmpSuffix` (default `.tmp`): suffix appended to `filePath` for
 *     the intermediate atomic-write file. Callers that may collide on
 *     the same target path from multiple processes (e.g. the models
 *     cache rewritten by both the test runner and the main daemon)
 *     should pass a per-process suffix such as `.tmp-${process.pid}`
 *     so the intermediate files never overwrite each other. Honoured
 *     on POSIX since #4874, and on Windows since #4913.
 *   - `_isWindowsOverride` (test-only): force the Windows branch
 *     regardless of host platform. Mirrors the same hook in
 *     `SessionStatePersistence` and lets the cross-platform atomicity
 *     test exercise the Windows path on a POSIX runner (we cannot rely
 *     on a Windows CI runner being available — see #4913).
 *
 * On rename failure, the intermediate `<filePath><tmpSuffix>` file is
 * unlinked before the error is rethrown so it does not leak across
 * retries. The rename error is what the caller needs to surface, so it
 * is always re-thrown; a non-ENOENT cleanup-unlink failure is logged via
 * `log.warn` so the orphan `.tmp` is not invisible (#4906 — the bespoke
 * cleanup wrappers in environment-manager.js / session-state-persistence.js
 * had this warn before the hoist in #4874).
 */
export function writeFileRestricted(
  filePath,
  data,
  { tmpSuffix = '.tmp', _isWindowsOverride } = {},
) {
  const onWindows = _isWindowsOverride ?? isWindows
  const tmpPath = `${filePath}${tmpSuffix}`
  // POSIX: the `mode: 0o600` arg to `writeFileSync` is ONLY honoured on
  // file CREATION (`O_CREAT`). When `tmpPath` already exists — e.g. a
  // prior run crashed before the rename and left a stale sidecar at a
  // looser mode, or another local user pre-created the path under a
  // permissive umask — `writeFileSync` opens with `O_TRUNC` and
  // preserves the existing mode bits. The explicit `chmodSync`
  // afterward guarantees the FINAL file is 0o600, but does NOT
  // eliminate the transient exposure window between the write and the
  // chmod — during that window, a pre-existing looser mode means
  // another local user could read the freshly-written bytes. Full
  // mitigation would require openSync(O_CREAT|O_EXCL) + fchmodSync
  // before write; the current belt-and-braces is intentional but only
  // covers the at-rest final perms, not the in-flight window. These
  // files may carry secrets (session bearer tokens, push subscriptions,
  // BYOK creds). Same defensive pattern is in `logger.js` (dir mode),
  // `byok-credentials.js`, `byok-mcp-trust.js`, and
  // `notification-prefs.js`. See #4907 for the cleanup discussion that
  // ended in "keep with comment + regression test".
  //
  // Windows: no POSIX mode bits — ACLs are the correct mechanism and
  // `writeFileSync`'s `mode` is mostly a no-op on Win32. The temp+rename
  // pattern still applies for atomicity (#4913).
  if (onWindows) {
    writeFileSync(tmpPath, data)
  } else {
    writeFileSync(tmpPath, data, { mode: 0o600 })
    chmodSync(tmpPath, 0o600)
  }
  try {
    renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch (cleanupErr) {
      if (cleanupErr && cleanupErr.code !== 'ENOENT') {
        log.warn(`Failed to remove orphaned ${tmpPath}: ${cleanupErr.message}`)
      }
    }
    throw err
  }
}

export function forceKill(child) {
  if (isWindows) {
    child.kill('SIGKILL')
  } else {
    child.kill('SIGKILL')
  }
}
