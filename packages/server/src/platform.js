import { writeFileSync, chmodSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'fs'
import { dirname } from 'path'
import { execFileSync } from 'child_process'
import { createLogger } from './logger.js'

const log = createLogger('platform')

export const isWindows = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'

// Windows rename failures worth one retry: an open handle held by antivirus or
// Windows Search briefly locks the destination (#6644 / #4927).
const WIN_RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST'])
// fsync error codes that mean "this filesystem cannot provide durability here"
// and are therefore BENIGN for the `{ durable: true }` path: the data already
// reached the OS page cache and the atomic rename still happened, we just can't
// force it further — exactly the guarantee of the non-durable default path. A
// GENUINE I/O failure (EIO / ENOSPC) is NOT in this set and propagates, so a
// durability-critical caller (the session-token revoke snapshot) reports the
// failure instead of a false success. EINVAL is the common member: a *directory*
// fsync on some virtual / network filesystems, or a regular-file fsync on a FS
// with no writeback to sync, surfaces EINVAL / ENOTSUP rather than succeeding.
const BENIGN_FSYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF', 'ENOSYS'])
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
 * fsync `target` so its buffered bytes — or, for a directory (`isDir`), the
 * rename that just changed its entries — are physically on disk before we
 * return (#6914). The fd is opened solely to drive the fsync and is ALWAYS
 * closed in the `finally`, so this leaks no descriptor even when fsync throws.
 *
 * A BENIGN fsync failure (`BENIGN_FSYNC_CODES` — e.g. EINVAL on a filesystem
 * that cannot sync a directory entry) is logged and swallowed: the write already
 * landed in the page cache and the rename happened, so we are no worse off than
 * the non-durable path. Any OTHER error (EIO / ENOSPC — a genuine durability
 * failure) propagates so the caller's durability contract fails loudly.
 *
 * `_fsync` is a test seam (default `fsyncSync`) so the durable + benign-error
 * paths are exercisable without a real disk fault.
 */
export function fsyncForDurability(target, { isDir = false, _fsync = fsyncSync } = {}) {
  let fd
  try {
    // Directories open read-only; regular files open `r+` so the handle is
    // writable — a strictly read-only fd is rejected by fsync on a few
    // platforms. The file/dir already exists (we just wrote/renamed it), so no
    // O_CREAT and no mode is needed.
    fd = openSync(target, isDir ? 'r' : 'r+')
    _fsync(fd)
  } catch (err) {
    if (err && BENIGN_FSYNC_CODES.has(err.code)) {
      log.warn(`durable-write: fsync of ${isDir ? 'directory' : 'file'} ${target} unsupported (${err.code}); continuing best-effort`)
      return
    }
    throw err
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* fd already invalid — nothing to reclaim */ }
    }
  }
}

/**
 * #7054 — the ONE implementation of "confirm a rename is durable, and REPORT
 * rather than throw when it is not".
 *
 * This policy lived in three places (`writeFileRestricted`,
 * `credential-store.writeStoreAtomically`, `byok-mcp-config.writeClaudeConfigAtomic`)
 * and drifted exactly as #7054 predicted: two of the three threw on a post-rename
 * directory-fsync failure, reporting a write that had ALREADY landed as failed
 * (#7067). Rename STRATEGY stays with each caller — they genuinely differ, and
 * credential-store's snapshot-and-restore retry is strictly more protective than a
 * plain rename — but the durability VERDICT is now shared.
 *
 * Never throws. By the time this runs the rename has published the file, so the
 * write succeeded; only the durability of its directory ENTRY is unproven.
 * Callers for whom that caveat must be operator-visible re-raise it themselves
 * (see server-cli's revoke persist, which feeds #6965's REVOKE_NOT_DURABLE frame).
 *
 * @param {string} filePath — the path whose DIRECTORY ENTRY changed; its dirname
 *   is fsynced. The entry may have been created (rename) or removed (unlink) —
 *   both are directory-metadata changes with the same durability requirement.
 * @param {{ durable?: boolean, fsync?: Function, onWindows?: boolean, change?: string }} [opts]
 *   `change` describes what happened to the entry, for the log only ('rename' by
 *   default, 'removal' for an unlink). The generic wording matters: this helper
 *   serves both, and telling an operator a REMOVED file is "written and live"
 *   would send them looking for the wrong thing.
 *   `fsync` is injected at the `fsyncForDurability(target, { isDir })` level so a
 *   test can pin ORDERING (which target, file-or-dir, whether the final file
 *   existed yet) rather than merely that a syscall happened.
 * @returns {{ durabilityUnconfirmed: string | null }}
 */
export function confirmRenameDurable(
  filePath,
  { durable = false, fsync = fsyncForDurability, onWindows = isWindows, change = 'rename' } = {},
) {
  // Windows has no directory fsync, and renameSync already passes
  // MOVEFILE_WRITE_THROUGH (a durable rename), so the temp-file fsync plus the
  // write-through rename cover the same guarantee.
  if (!durable || onWindows) return { durabilityUnconfirmed: null }
  try {
    fsync(dirname(filePath), { isDir: true })
    return { durabilityUnconfirmed: null }
  } catch (err) {
    const durabilityUnconfirmed = err?.message || String(err)
    // The only surviving artifact: nothing is thrown and callers that ignore the
    // return value see a plain success, so this must be `error`.
    log.error(
      `durable-write: the ${change} of ${filePath} IS in effect, but its directory entry could not be ` +
      `fsynced (${durabilityUnconfirmed}) — a power loss could roll that ${change} back. ` +
      `Treat its durability as unconfirmed.`,
    )
    return { durabilityUnconfirmed }
  }
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
 *   - `durable` (default `false`): when `true`, `fsync` the temp file
 *     BEFORE the rename (so its bytes are physically on disk) and, on
 *     POSIX, `fsync` the containing DIRECTORY AFTER the rename (so the
 *     rename itself is durable) — the standard atomic-durable-write recipe
 *     (#6914). The default is OFF: the ordinary config / state callers are
 *     fail-SAFE (a lost page-cache write on power loss merely reverts to a
 *     harmless earlier state, or re-pairs), and an fsync per write would add
 *     blocking disk I/O to hot state-persistence paths for no security gain.
 *     Only durability-CRITICAL callers opt in — specifically the session-token
 *     REVOKE snapshot (`_persistSessionTokensSnapshot` in `pairing.js`), where
 *     a power loss / kernel panic within the OS writeback window could
 *     otherwise resurrect a revoked token AFTER the operator was told the
 *     revoke succeeded. A genuine PRE-rename fsync failure (EIO / ENOSPC) is
 *     re-thrown so that caller reports the failure — nothing was published, so
 *     "the write failed" is true. A POST-rename DIRECTORY-fsync failure is NOT
 *     thrown (#7067): the rename already published the file, so the write
 *     SUCCEEDED and only its directory entry's durability is unproven; it is
 *     returned as `durabilityUnconfirmed` and logged at error. Callers for whom
 *     that caveat must be operator-visible re-raise it themselves — see
 *     server-cli's revoke persist, which feeds #6965's REVOKE_NOT_DURABLE frame.
 *     A benign fsync failure (EINVAL / ENOTSUP on a FS that cannot sync — see
 *     `BENIGN_FSYNC_CODES`) is logged and the write still succeeds. On Windows the directory fsync is skipped: there is no
 *     directory-fsync, and `renameSync` already passes `MOVEFILE_WRITE_THROUGH`
 *     (a durable rename), so the temp-file fsync plus the write-through rename
 *     cover the same guarantee.
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
/**
 * @returns {{ durabilityUnconfirmed: string | null }} `durabilityUnconfirmed` is
 *   the post-rename directory-fsync error message when the file is live but its
 *   directory entry's durability could not be confirmed; `null` otherwise —
 *   including every non-durable write, which makes no durability claim at all.
 *   Mirrors `credential-store.writeStoreAtomically`'s contract (#7067).
 */
export function writeFileRestricted(
  filePath,
  data,
  {
    tmpSuffix = '.tmp',
    durable = false,
    _isWindowsOverride,
    // Test seams (#6644): inject the ACL stamper / rename so the Windows ACL +
    // one-shot-retry paths are exercisable on a POSIX CI runner.
    _stampAcl = stampWindowsAcl,
    _rename = renameSync,
    // Test seam (#6914): inject the fsync used by the `durable` path so the
    // durable + benign-fsync-error branches are exercisable without a disk fault.
    _fsync = fsyncSync,
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
    // Create/truncate the temp file EMPTY, stamp the owner-only DACL, THEN write
    // the data — so the secret bytes only ever exist while the file is already
    // owner-only. Writing first would leave a window where the freshly-written
    // bytes carry the parent's (possibly group-readable) inherited ACL, and this
    // also re-restricts a stale, permissively-ACL'd temp left by a prior crash.
    // The DACL survives the same-directory rename (NTFS preserves explicit DACLs
    // across MoveFileEx), so the final file lands owner-only (#6644).
    writeFileSync(tmpPath, '')
    _stampAcl(tmpPath)
    writeFileSync(tmpPath, data)
  } else {
    writeFileSync(tmpPath, data, { mode: 0o600 })
    chmodSync(tmpPath, 0o600)
  }
  // #6914: durability-critical callers force the temp file's bytes to disk BEFORE
  // the rename, so a power loss / kernel panic within the OS writeback window can
  // never roll a reported-successful write back to its pre-write state. A genuine
  // fsync failure means we cannot promise durability — clean up the orphaned temp
  // and surface it, mirroring the rename-failure path below. (`fsyncForDurability`
  // has already swallowed the benign, filesystem-cannot-sync codes.)
  if (durable) {
    try {
      fsyncForDurability(tmpPath, { _fsync })
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
  try {
    _rename(tmpPath, filePath)
  } catch (err) {
    // Windows: an AV / Windows Search handle can briefly lock the destination
    // (EPERM/EACCES/EBUSY/EEXIST). Retry once before giving up (#6644 / #4927).
    if (onWindows && err && WIN_RENAME_RETRY_CODES.has(err.code)) {
      try {
        _rename(tmpPath, filePath)
        // Windows-only branch: no directory fsync (Windows has none; the durable
        // rename comes from MOVEFILE_WRITE_THROUGH). The temp file was already
        // fsynced above when `durable`.
        return { durabilityUnconfirmed: null }
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
  // #6914: after a successful rename, fsync the CONTAINING DIRECTORY so the rename
  // itself (a directory-metadata change) is durable — otherwise a crash could
  // leave the new file's data on disk but the directory entry still pointing at
  // the old inode. POSIX-only: Windows has no directory fsync, and its renameSync
  // already passes MOVEFILE_WRITE_THROUGH (a durable rename), so the temp-file
  // fsync above plus the write-through rename cover the same guarantee.
  //
  // #7067: this failure does NOT throw, unlike the PRE-rename fsync above. The
  // asymmetry is the point. Before the rename nothing is published, so "the write
  // failed" is TRUE and throwing is right. After it, the file is already live and
  // only the durability of its directory ENTRY is unproven — throwing there told
  // the caller a landed write had failed, and `pairing.js` turned that into "the
  // session-token revoke failed" for a revoke already on disk, sending the
  // operator to retry or to assume a revoked token was still live. Report the
  // caveat instead, matching `credential-store.writeStoreAtomically` (#6964/#7061),
  // which resolved this exact moment the same way.
  return confirmRenameDurable(filePath, {
    durable,
    onWindows,
    // Bind this call's `_fsync` seam into the shared helper's higher-level one.
    fsync: (target, opts) => fsyncForDurability(target, { ...opts, _fsync }),
  })
}

/**
 * #7606: every descendant pid of `pid`, from a `ps -axo pid=,ppid=` table.
 * Pure; exported for tests. Order is parents-before-children so a caller that
 * wants to kill deepest-first reverses it. Cycles are impossible in a real
 * process table but a corrupt/odd line could fake one, so `seen` guards it.
 */
export function parseDescendantPids(pid, psOutput) {
  const childrenOf = new Map()
  for (const line of String(psOutput || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const p = Number(m[1])
    const pp = Number(m[2])
    if (!childrenOf.has(pp)) childrenOf.set(pp, [])
    childrenOf.get(pp).push(p)
  }
  const out = []
  const seen = new Set([pid])
  const stack = [pid]
  while (stack.length) {
    const cur = stack.pop()
    for (const c of childrenOf.get(cur) || []) {
      if (seen.has(c)) continue
      seen.add(c)
      out.push(c)
      stack.push(c)
    }
  }
  return out
}

/**
 * #7606: list every live descendant of `pid` on POSIX via one `ps` call.
 * Best-effort and bounded (5s): an unavailable or wedged `ps` yields `[]`, so
 * the caller degrades to the pre-#7606 direct-child kill rather than hanging a
 * teardown path. `deps.ps` is the test seam (returns the raw table).
 */
export function listDescendantPids(pid, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return []
  let table
  try {
    table = deps.ps
      ? deps.ps()
      : execFileSync('ps', ['-axo', 'pid=,ppid='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      })
  } catch {
    return []
  }
  return parseDescendantPids(pid, table)
}

/**
 * Terminate `child` and its whole descendant TREE — `taskkill /T` on Windows,
 * a `ps`-enumerated walk on POSIX (#7606).
 *
 * POSIX: the tree is enumerated with {@link listDescendantPids} BEFORE the
 * direct child is signalled, because the moment the child dies its children
 * are reparented to pid 1 and the ppid links this walk depends on are gone.
 * Then `process.kill(pid, signal)` on every descendant, deepest-first, and
 * `child.kill(signal)` on the direct process last. `force:false` stays a graceful
 * SIGTERM so a caller's existing SIGTERM→SIGKILL escalation is unchanged.
 *
 * Why (#7606): before this, POSIX signalled ONLY the direct child. A provider
 * CLI (claude) that had spawned `bash -c` → `node --test` was killed on
 * respawn / destroy and its grandchildren survived, reparented to launchd —
 * four of them ran 7.5 days at 91% CPU and ~50 GB each before macOS ran out
 * of application memory. Enumerating first and signalling the whole tree is
 * what `detached` + negative-pid signalling was supposed to give callers, and
 * no caller had ever done it.
 *
 * `deps` — test seams: `ps` (raw table) and `kill` (`process.kill` shape).
 */
export function killProcessTree(child, { force = false, ...deps } = {}) {
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
  const signal = force ? 'SIGKILL' : 'SIGTERM'
  const kill = deps.kill || process.kill
  // A child that has already exited is NOT walked: Node keeps `child.pid` set
  // after exit while the OS may have recycled it, so a walk would enumerate —
  // and signal — an unrelated process's children. `child.kill()` itself is
  // safe here (Node drops the handle on exit and it becomes a no-op), which
  // is why the pre-#7606 code never had this hazard. Force-kill escalation
  // timers fire in exactly this window (#7608 review).
  if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) {
    try { child.kill(signal) } catch { /* already gone */ }
    return
  }
  // Enumerate BEFORE signalling anything (see the docstring): once a process
  // exits the ppid links below it are gone and its subtree is unreachable.
  const descendants = listDescendantPids(child.pid, deps)
  // Deepest-first, and the direct child LAST: killing a parent first frees
  // its children's pids mid-loop and reopens the reuse window above.
  for (let i = descendants.length - 1; i >= 0; i--) {
    try { kill(descendants[i], signal) } catch { /* already gone */ }
  }
  try { child.kill(signal) } catch { /* already gone */ }
}

/**
 * Force-kill `child` and its whole descendant tree (#6643, #7606). POSIX
 * SIGKILLs the enumerated tree; Windows reaps it via taskkill. See
 * {@link killProcessTree}. `deps` are the same test seams.
 */
export function forceKill(child, deps = {}) {
  killProcessTree(child, { ...deps, force: true })
}
