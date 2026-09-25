/**
 * #7893 — the ONE TOCTOU-safe read for every credential-bearing file this
 * daemon trusts by path + mode (+ owner, for the one caller that checks it):
 * the ingest secret (event-ingest.js), the session-token store
 * (session-token-store.js), the provider credential store
 * (credential-store.js), and the MCP OAuth token store
 * (byok-mcp-oauth-store.js).
 *
 * ── The defect this closes ──────────────────────────────────────────────
 *
 * All four callers used to `statSync(path)` — check the mode is exactly
 * 0600 (and, for the ingest secret, the owning uid) — and THEN separately
 * `readFileSync(path)` the same path string a second time. Between those two
 * syscalls a process with write access to the containing directory can
 * rename a different file (or a symlink) over the path: the mode/owner that
 * was checked and the bytes that get read are no longer provably the same
 * file. `ws-file-ops/open-nofollow.js` closed this exact shape for the
 * async ws-file-ops surface (#7280); this is its SYNCHRONOUS counterpart
 * plus an fstat-based trust check, because all four credential readers this
 * closes are synchronous call sites and converting them to async would
 * ripple far outside this issue's scope.
 *
 * ── What it guarantees ──────────────────────────────────────────────────
 *
 * `openSync(path, O_RDONLY | O_NOFOLLOW)` (POSIX) is a single kernel-atomic
 * decision: the final path component is resolved and opened, and a symlink
 * there is refused with ELOOP, in one syscall — there is no window between
 * "check" and "open" because there is no separate check. The trust check
 * (regular-file, mode, owner uid) then runs against `fstatSync(fd)` — the
 * OPENED HANDLE — never the path again, and the content is read from that
 * SAME fd. Whatever this returns as `content`, its reported mode/uid were
 * fstat'd off the identical bytes.
 *
 * win32 has no `O_NOFOLLOW` (see open-nofollow.js's header for the measured
 * detail: Node exports the constant only under `#ifdef O_NOFOLLOW`, so on
 * win32 it is `undefined` and silently ORs to 0). The same lstat-before /
 * open / fstat+lstat-identity-recheck-after emulation that file uses is
 * ported here onto the synchronous fs surface — see its header for exactly
 * which race this closes (a swap between the pre-open lstat and the open)
 * and which it structurally cannot (a swap that also restores the original
 * inode before the post-open recheck wins both races — not reachable
 * without an OS primitive Windows doesn't expose here).
 *
 * The mode/owner boundary itself is unchanged from every store's existing
 * behaviour — POSIX only (win32 mode bits don't reflect NTFS ACLs, the
 * #4144 carve-out every sibling store already uses) and exactly-0600 by
 * `!==`, not "no wider than 0600".
 */
import { openSync, closeSync, fstatSync, lstatSync, readFileSync, constants as fsConstants } from 'node:fs'

/** True when this platform's Node exports a usable `O_NOFOLLOW`. */
const HAS_O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' && fsConstants.O_NOFOLLOW !== 0

/**
 * The real filesystem + platform seam. Tests inject a replacement to force
 * the win32 branch on macOS/Linux, to exercise races without winning them
 * for real, and to prove the read targets the fd rather than the path —
 * see `tests/trusted-file-read.test.js`.
 */
export const defaultTrustedFileReadDeps = Object.freeze({
  hasONoFollow: HAS_O_NOFOLLOW,
  oNofollow: HAS_O_NOFOLLOW ? fsConstants.O_NOFOLLOW : undefined,
  platform: process.platform,
  openSync: (path, flags) => openSync(path, flags),
  closeSync: (fd) => closeSync(fd),
  fstatSync: (fd) => fstatSync(fd, { bigint: true }),
  lstatSync: (path) => lstatSync(path, { bigint: true }),
  readFileSync: (fd, encoding) => readFileSync(fd, encoding),
})

/**
 * The one refusal for a symlink (or an identity check that could not prove
 * the opened fd is the file at the path). `code: 'ELOOP'` is the wire
 * contract, matching `ws-file-ops/open-nofollow.js`.
 */
function refusal(path, detail) {
  return Object.assign(
    new Error(`ELOOP: refusing ${path} — the open could not be proven symlink-free (${detail})`),
    { code: 'ELOOP', path },
  )
}

/**
 * Open `path` read-only, refusing a final-component symlink, then fstat the
 * OPENED HANDLE (never the path again). Mirrors `_openNoFollowImpl` in
 * `ws-file-ops/open-nofollow.js` — see that file's header for the full
 * per-platform reasoning — ported to the synchronous fs surface.
 *
 * @param {string} path
 * @param {object} deps - `{ hasONoFollow, oNofollow, platform, openSync, closeSync, fstatSync, lstatSync }`
 * @returns {{ fd: number, stat: import('fs').BigIntStats }}
 * @throws {Error} ENOENT (absent), ELOOP (symlink refused, or the identity
 *   check failed), ENOSYS (a platform with neither a real nor an emulated
 *   O_NOFOLLOW), or any other fs error unchanged.
 */
export function _openTrustedFdSync(path, deps) {
  const { hasONoFollow, oNofollow, platform, openSync: doOpen, closeSync: doClose, fstatSync: doFstat, lstatSync: doLstat } = deps
  const O_RDONLY = fsConstants.O_RDONLY

  if (hasONoFollow) {
    // POSIX: one atomic, kernel-enforced decision. No separate check — the
    // fd we get back IS the trust check's subject.
    const fd = doOpen(path, O_RDONLY | oNofollow)
    return { fd, stat: doFstat(fd) }
  }

  // No O_NOFOLLOW. win32 is the ONE platform where that is expected and
  // where the emulation below is known-correct (ported from open-nofollow.js).
  if (platform !== 'win32') {
    throw Object.assign(
      new Error(`readTrustedSecretFile: O_NOFOLLOW is unavailable on platform '${platform}' and only win32 has a verified fallback — refusing to open ${path} without symlink protection`),
      { code: 'ENOSYS', path },
    )
  }

  // Step 1 — refuse an already-planted symlink or junction before opening it.
  try {
    const pre = doLstat(path)
    if (pre.isSymbolicLink()) throw refusal(path, 'lstat reports a symlink before open')
  } catch (err) {
    if (err.code === 'ELOOP') throw err
    // ENOENT is not a refusal — the caller (below) reads it as "absent".
    if (err.code !== 'ENOENT') throw err
  }

  const fd = doOpen(path, O_RDONLY)

  // Step 3 — prove the fd we hold is the file the path names.
  let ok = false
  try {
    const onFd = doFstat(fd)
    const onPath = doLstat(path)
    if (onPath.isSymbolicLink()) throw refusal(path, 'a symlink appeared at the path after open')
    if (onFd.ino === 0n || onPath.ino === 0n) {
      throw refusal(path, 'no usable file index — the identity check would be vacuous')
    }
    if (onFd.dev !== onPath.dev || onFd.ino !== onPath.ino) {
      throw refusal(path, 'the opened file is not the file at this path — swapped between check and open')
    }
    ok = true
    return { fd, stat: onFd }
  } catch (err) {
    if (err.code === 'ELOOP') throw err
    // The verification itself failed (path vanished, access revoked). Fail
    // closed: we cannot show the fd is the file we checked.
    throw refusal(path, `identity check failed (${err.code || err.message})`)
  } finally {
    if (!ok) { try { doClose(fd) } catch { /* best-effort */ } }
  }
}

/**
 * Open, verify (regular-file / mode / owner), and read a trusted secret
 * file with NO window between the check and the bytes returned (#7893).
 *
 * Never throws for an expected outcome — absent / refused / ok are all
 * RETURNED — so each caller keeps its own throw-vs-return-null-vs-repair
 * behaviour and builds its own message text from the structured result.
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {number} [opts.mode] - required POSIX mode, default 0o600. Skipped
 *   entirely on win32 (mode bits don't reflect NTFS ACLs — the #4144
 *   carve-out every sibling store already uses).
 * @param {boolean} [opts.checkOwner] - also require the fd's uid equal
 *   `process.getuid()` (POSIX only). Off by default — only the ingest
 *   secret checks this today.
 * @param {object} [opts.deps] - test seam; defaults to
 *   `defaultTrustedFileReadDeps`.
 * @returns {
 *   | { status: 'absent' }
 *   | { status: 'refused', code: string, mode: number|null, uid: number|null, cause: Error|null }
 *   | { status: 'ok', content: string, mode: number, uid: number }
 * }
 */
export function readTrustedSecretFile(path, { mode = 0o600, checkOwner = false, deps = defaultTrustedFileReadDeps } = {}) {
  let opened
  try {
    opened = _openTrustedFdSync(path, deps)
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'absent' }
    return { status: 'refused', code: (err && err.code) || 'EUNKNOWN', mode: null, uid: null, cause: err }
  }

  const { fd, stat } = opened
  try {
    if (!stat.isFile()) {
      return {
        status: 'refused',
        code: 'ENOTFILE',
        mode: null,
        uid: null,
        cause: new Error(`${path} is not a regular file`),
      }
    }
    const actualMode = Number(stat.mode) & 0o777
    const actualUid = Number(stat.uid)
    if (deps.platform !== 'win32') {
      if (actualMode !== mode) {
        return { status: 'refused', code: 'EMODE', mode: actualMode, uid: actualUid, cause: null }
      }
      if (checkOwner && typeof process.getuid === 'function' && actualUid !== process.getuid()) {
        return { status: 'refused', code: 'EOWNER', mode: actualMode, uid: actualUid, cause: null }
      }
    }
    // Read from the SAME fd that was just fstat'd — never re-open or re-stat
    // the path. This is the line the whole module exists for.
    const content = deps.readFileSync(fd, 'utf8')
    return { status: 'ok', content, mode: actualMode, uid: actualUid }
  } finally {
    try { deps.closeSync(fd) } catch { /* best-effort */ }
  }
}
