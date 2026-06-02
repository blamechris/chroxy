import { writeFileSync, chmodSync, renameSync, unlinkSync } from 'fs'

export const isWindows = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'

export function defaultShell() {
  if (isWindows) return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/zsh'
}

/**
 * Write `data` to `filePath` atomically on POSIX (write to
 * `<filePath><tmpSuffix>` then `rename` over the target). `rename` is
 * atomic on the same filesystem, so a concurrent reader sees either the
 * previous version or the new one — never a half-written file. This
 * matters when the process is killed mid-write (SIGKILL / OOM); it is
 * the file-level analogue of the "SIGTERM not SIGKILL for Chroxy"
 * memory note. See #4850, which surfaced this gap for `connection.json`
 * (pre-existing) and `device-preferences.json` (added in #4847).
 *
 * On Windows we keep the direct `writeFileSync` path — `rename`
 * semantics differ (it fails when the destination exists unless you
 * use `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`) and there is no ACL
 * machinery here that needs the atomic guarantee yet.
 *
 * Options (POSIX only):
 *   - `tmpSuffix` (default `.tmp`): suffix appended to `filePath` for
 *     the intermediate atomic-write file. Callers that may collide on
 *     the same target path from multiple processes (e.g. the models
 *     cache rewritten by both the test runner and the main daemon)
 *     should pass a per-process suffix such as `.tmp-${process.pid}`
 *     so the intermediate files never overwrite each other. See #4874.
 *
 * On rename failure, the intermediate `<filePath><tmpSuffix>` file is
 * unlinked before the error is rethrown so it does not leak across
 * retries. Cleanup errors are suppressed — the original rename error is
 * what the caller needs to surface. See #4874 — environment-manager.js
 * and session-state-persistence.js had identical bespoke cleanup
 * wrappers before this was hoisted into the shared helper.
 */
export function writeFileRestricted(filePath, data, { tmpSuffix = '.tmp' } = {}) {
  if (isWindows) {
    writeFileSync(filePath, data)
    return
  }
  const tmpPath = `${filePath}${tmpSuffix}`
  // The `mode: 0o600` arg to `writeFileSync` is ONLY honoured on file
  // CREATION (`O_CREAT`). When `tmpPath` already exists — e.g. a prior
  // run crashed before the rename and left a stale sidecar at a looser
  // mode, or another local user pre-created the path under a permissive
  // umask — `writeFileSync` opens with `O_TRUNC` and preserves the
  // existing mode bits. The explicit `chmodSync` afterward guarantees
  // 0o600 even in that case. These files may carry secrets (session
  // bearer tokens, push subscriptions, BYOK creds), so the
  // belt-and-braces is intentional. Same defensive pattern is in
  // `logger.js` (dir mode), `byok-credentials.js`, `byok-mcp-trust.js`,
  // and `notification-prefs.js`. See #4907 for the cleanup discussion
  // that ended in "keep with comment + regression test".
  writeFileSync(tmpPath, data, { mode: 0o600 })
  chmodSync(tmpPath, 0o600)
  try {
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
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
