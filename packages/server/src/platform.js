import { writeFileSync, chmodSync, renameSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { createLogger } from './logger.js'

const log = createLogger('platform')

export const isWindows = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'

// Windows rename failures worth one retry: an open handle held by antivirus or
// Windows Search briefly locks the destination (#6644 / #4927).
const WIN_RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST'])
// Well-known SYSTEM SID — locale-independent (the NAME "SYSTEM" is localized, so
// icacls grants must use the SID form to work on non-English Windows).
const SID_SYSTEM = 'S-1-5-18'
// Absolute System32 dir so `whoami`/`icacls` resolve to the real Windows tools
// regardless of PATH order (a shell like Git Bash puts its own `whoami` first).
const WIN_SYSTEM32 = `${process.env.SystemRoot || process.env.windir || 'C:\\Windows'}\\System32`

let _cachedUserSid
/**
 * The current user's SID (e.g. `S-1-5-21-…`), resolved once via `whoami /user`
 * and cached for the process. SIDs (not account names) are used for icacls so
 * the grant is correct regardless of domain membership or OS display language.
 * Returns null if it can't be resolved (caller then leaves inherited ACLs).
 */
function currentUserSid() {
  if (_cachedUserSid !== undefined) return _cachedUserSid
  _cachedUserSid = null
  try {
    const out = execFileSync(`${WIN_SYSTEM32}\\whoami.exe`, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
    })
    const m = out.match(/S-1-[0-9-]+/)
    if (m) _cachedUserSid = m[0]
  } catch {
    // whoami unavailable / failed — leave null; the file keeps inherited ACLs.
  }
  return _cachedUserSid
}

/**
 * Stamp an owner-only DACL on a Windows file (#6644): strip inherited ACEs and
 * grant Full control to ONLY the current user + SYSTEM. This is the NTFS
 * analogue of POSIX 0o600 — without it, files under `%LOCALAPPDATA%` /
 * `~/.chroxy` inherit the parent directory's ACL, which the audit found could
 * include a secondary group able to read the secrets. Best-effort: an icacls
 * failure is logged, not thrown — the file is still written (just at inherited
 * perms), and the caller's write must not fail over a hardening step.
 */
function stampWindowsAcl(filePath) {
  // Real-Windows only: icacls/whoami don't exist elsewhere. The `_isWindowsOverride`
  // seam drives the write/rename path on POSIX CI runners, but must NOT shell out
  // to Windows tools there — those tests inject `_stampAcl` to assert this call.
  if (!isWindows) return
  const sid = currentUserSid()
  if (!sid) {
    log.warn(`could not resolve current-user SID — leaving inherited ACL on ${filePath}`)
    return
  }
  try {
    execFileSync(`${WIN_SYSTEM32}\\icacls.exe`, [
      filePath,
      '/inheritance:r',
      '/grant:r', `*${sid}:F`,
      '/grant:r', `*${SID_SYSTEM}:F`,
    ], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
  } catch (err) {
    log.warn(`icacls could not stamp owner-only ACL on ${filePath}: ${err.message}`)
  }
}

/**
 * Per-platform "how to install cloudflared" hint for user-facing errors:
 * Windows → winget, macOS → Homebrew, Linux → the Cloudflare package repo.
 * The tunnel adapter and doctor share this single source of truth; the desktop
 * app mirrors the same logic in Rust (`cloudflared_install_hint` in lib.rs), as
 * it can't call across the JS/Rust boundary (#6649).
 */
export function cloudflaredInstallHint() {
  if (isMac) return 'brew install cloudflared'
  if (isWindows) return 'winget install Cloudflare.cloudflared'
  return 'see https://pkg.cloudflare.com/ for installation'
}

/**
 * The OS default shell: Windows → `COMSPEC` (cmd.exe), POSIX → `$SHELL`
 * (falling back to zsh). `platform`/`env` are injectable so callers that resolve
 * a shell for a spawn (e.g. the embedded user-shell, #6646) can unit-test both
 * platform branches on any CI host; production calls pass no args.
 */
export function defaultShell({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return env.COMSPEC || 'cmd.exe'
  return env.SHELL || '/bin/zsh'
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
 *
 * AV-held-handle retry (#4927 / #6644). On Windows, an open handle held by
 * antivirus / Windows Search can cause `renameSync` to fail with EPERM /
 * EACCES / EBUSY / EEXIST. This helper now does a ONE-SHOT retry on those codes
 * (Windows only) before giving up — matching `session-state-persistence.js.
 * _rotateToBak`. The original #4927 decision was to NOT retry here, on the
 * grounds that every caller then had its own retry/fallback; that reasoning was
 * flagged for revisit "if a future site without its own retry adopts
 * `writeFileRestricted`", and #6644's DPAPI `_winSetToken` is exactly that site
 * (a keychain write with no outer retry). The retry is bounded to a single extra
 * attempt and to the transient-lock error codes, so a genuine failure (e.g.
 * ENOSPC, a bad path) still surfaces immediately. See `platform-windows.test.js`.
 */
export function writeFileRestricted(
  filePath,
  data,
  {
    tmpSuffix = '.tmp',
    _isWindowsOverride,
    // Test seams (#6644): inject the ACL stamper / rename so the Windows ACL +
    // one-shot-retry paths are exercisable on a POSIX CI runner.
    _stampAcl = stampWindowsAcl,
    _rename = renameSync,
  } = {},
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
    // Stamp an owner-only DACL on the temp file BEFORE the rename — NTFS
    // preserves an explicit DACL across a same-directory rename, so the final
    // file lands owner-only with no exposure window (#6644).
    _stampAcl(tmpPath)
  } else {
    writeFileSync(tmpPath, data, { mode: 0o600 })
    chmodSync(tmpPath, 0o600)
  }
  try {
    _rename(tmpPath, filePath)
  } catch (err) {
    // Windows: an AV / Windows Search handle can briefly lock the destination
    // (EPERM/EACCES/EBUSY/EEXIST). Retry once before giving up (#6644 / #4927).
    if (onWindows && err && WIN_RENAME_RETRY_CODES.has(err.code)) {
      try {
        _rename(tmpPath, filePath)
        return
      } catch {
        // fall through to cleanup + rethrow the original error below
      }
    }
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

/**
 * Terminate `child` — its whole descendant TREE on Windows (taskkill /T), or
 * just the DIRECT process on POSIX (see the per-platform notes below; callers
 * that need the whole POSIX group spawn `detached` and signal the negative pid).
 *
 * POSIX: `child.kill(force ? 'SIGKILL' : 'SIGTERM')` on the direct process —
 * the long-standing behaviour (callers that need the whole group spawn
 * `detached` and signal the negative pid themselves). `force:false` stays a
 * graceful SIGTERM so a caller's existing SIGTERM→SIGKILL escalation is
 * unchanged.
 *
 * Windows: there is no process-group signal and no graceful console-tree
 * termination — Node maps BOTH `SIGTERM` and `SIGKILL` to `TerminateProcess`
 * on the DIRECT pid, so descendants are orphaned. This is acute for Chroxy:
 * `.cmd`/`.bat` provider shims (claude, codex, gemini, …) run under
 * `cmd.exe /d /s /c`, so the real agent/node process is a GRANDCHILD of the
 * tracked pid. `cmd /c` waits for its child, so actively killing the wrapper
 * (respawn / model-switch / destroy) leaves node running — still editing files
 * and burning tokens — after Stop/teardown (#6643). Reap the whole tree with
 * `taskkill /PID <pid> /T /F`. The `force` flag is POSIX-only; on Windows the
 * kill is always forced (matching Node's existing TerminateProcess semantics,
 * where SIGTERM was never graceful anyway). Best-effort: an already-exited pid
 * or a taskkill failure falls back to a direct `child.kill()` — this never
 * throws, so it is safe to call from a teardown path.
 */
export function killProcessTree(child, { force = false } = {}) {
  if (!child) return
  if (isWindows) {
    const pid = child.pid
    if (pid) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          // Bound the teardown path: a wedged taskkill must not hang stop /
          // respawn. On timeout execFileSync throws and we fall back to the
          // direct child.kill() below (#6657 review).
          timeout: 5000,
        })
        return
      } catch {
        // pid already gone, or taskkill unavailable/failed — fall through to a
        // direct kill so teardown still makes progress.
      }
    }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    return
  }
  try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* already gone */ }
}

/**
 * Force-kill `child` and its whole descendant tree (#6643). POSIX sends
 * SIGKILL to the process; Windows reaps the tree via taskkill. See
 * {@link killProcessTree}.
 */
export function forceKill(child) {
  killProcessTree(child, { force: true })
}
