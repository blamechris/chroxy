import { open as fsOpen, lstat as fsLstat } from 'fs/promises'
import { constants as fsConstants } from 'fs'

/**
 * #7280 — the ONE symlink-refusing `open()` for the whole file-ops surface.
 *
 * ── The defect this exists to close ─────────────────────────────────────────
 *
 * `O_NOFOLLOW` is a POSIX flag. Node exports it only under `#ifdef O_NOFOLLOW`,
 * so on win32 `fsConstants.O_NOFOLLOW` is `undefined` — and `undefined` in a
 * bitwise OR coerces to `0`. Measured on the chroxy-win host (Win 11, Node
 * 22.23.1): `O_NOFOLLOW: undefined`, `O_WRONLY | O_NOFOLLOW | O_TRUNC === 513`
 * (the O_NOFOLLOW term contributed nothing). Every `open()` in this package
 * that relied on the flag to refuse a symlink therefore opened the symlink's
 * TARGET instead, silently, with no error and no log line, while the comments
 * around it asserted a protection that was not there. The ELOOP rejection
 * branch was unreachable, so the symlink-refusal tests PASSED on Windows by
 * never reaching the branch they meant to test — docs/false-safety-guards.md,
 * where success and not-checking are the same observable outcome.
 *
 * ── What this helper guarantees, per platform ───────────────────────────────
 *
 * POSIX (`O_NOFOLLOW` defined): `O_NOFOLLOW` is ORed into the caller's flags
 * exactly as before. Behaviour and error codes are byte-for-byte unchanged —
 * the kernel refuses a final-component symlink with ELOOP, atomically.
 *
 * win32 (`O_NOFOLLOW` undefined): the kernel gives us nothing, so the refusal
 * is assembled from three steps, and the result is reported with
 * `code: 'ELOOP'` so every existing caller's ELOOP handling keeps working
 * unchanged:
 *   1. `lstat(path)` BEFORE the open — a reparse-point symlink or a junction
 *      (Node reports both via `isSymbolicLink()`) is refused without the file
 *      ever being opened. `ENOENT` is not a refusal: the caller may be creating
 *      the file (O_CREAT), and a non-creating open will raise its own ENOENT a
 *      line later, exactly as POSIX would. Any OTHER lstat error propagates —
 *      "could not check" is never "nothing to check".
 *   2. `open(path, flags, mode)`.
 *   3. The post-open identity check, which is what closes the window step 1
 *      alone would leave open: `fstat(fd)` and a FRESH `lstat(path)`, both with
 *      `{ bigint: true }` (Windows file indexes exceed 2^53 and would lose
 *      precision as Numbers), compared on `dev` + `ino`. If they differ, or the
 *      fresh lstat now reports a symlink, or the fresh lstat fails, or either
 *      inode is 0 (no usable file index — the comparison would be vacuous), the
 *      fd is closed and the call is refused. Whatever the fd points at, it is
 *      not provably the non-symlink we checked, so it is refused.
 *
 * ── The window this closes, and the one it cannot ───────────────────────────
 *
 * CLOSES: the swap between step 1's lstat and step 2's open. A symlink planted
 * there is caught by step 3, because the fd's identity then no longer matches
 * whatever now sits at the path — the attacker cannot both redirect the path
 * and keep the identity we opened.
 *
 * CANNOT CLOSE: a swap performed AFTER step 3 and before the caller finishes
 * using the fd. That is inherent to every path-based open and is NOT specific
 * to win32 — on POSIX the fd is likewise pinned at open time, and a later
 * rename of the path does not disturb it. Where the two genuinely differ is
 * ATOMICITY: POSIX `O_NOFOLLOW` is a single kernel-enforced decision, while
 * this is check-open-recheck, so an attacker who wins BOTH races (swap in
 * between 1 and 2, then restore the original inode before 3) is not detected.
 * Detecting that requires an OS primitive Windows does not expose here.
 *
 * ONE win32-only SIDE EFFECT of check-open-recheck, stated because a refusal
 * that is not free is exactly the kind of thing a comment quietly omits: the
 * open happens BEFORE the verification, so a caller passing `O_TRUNC` has
 * already truncated the file by the time step 3 refuses. POSIX `O_NOFOLLOW`
 * decides before anything is touched. Today the difference is unreachable —
 * win32 rejects `O_WRONLY | O_TRUNC` with EINVAL outright, for an unrelated
 * reason (#7284, measured in docs/records/windows-path-containment-7273.md) —
 * but it goes live the moment #7284 is fixed by adding a create disposition.
 * A truncating win32 caller must then read a refusal as "the file may already
 * be empty", not as "nothing happened".
 *
 * NEITHER PLATFORM closes the non-final components: `O_NOFOLLOW` checks only
 * the FINAL path component, and so does this — a symlinked PARENT directory is
 * followed by both. That gap is closed a layer up, by the componentwise
 * resolution + containment check in `common.js` (see its
 * `realpathOfDeepestAncestor` note), which is why the callers here run that
 * first and this second.
 */

/** True when this platform's Node exports a usable `O_NOFOLLOW`. */
const HAS_O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' && fsConstants.O_NOFOLLOW !== 0

/**
 * The real filesystem seam. Tests inject a replacement to force the win32
 * branch on macOS/Linux (and to exercise the races without winning them for
 * real) — see `_openNoFollowImpl`.
 */
export const defaultOpenNoFollowDeps = Object.freeze({
  hasONoFollow: HAS_O_NOFOLLOW,
  oNofollow: HAS_O_NOFOLLOW ? fsConstants.O_NOFOLLOW : undefined,
  platform: process.platform,
  open: (path, flags, mode) => fsOpen(path, flags, mode),
  lstat: (path) => fsLstat(path, { bigint: true }),
  fstat: (fh) => fh.stat({ bigint: true }),
})

/**
 * The one refusal. `code: 'ELOOP'` is the WIRE contract — every caller keys on
 * it and maps it to "access denied" — but the MESSAGE must not claim more than
 * the refusal knows. Only some of these refusals saw a symlink; the rest are
 * "this open could not be proven symlink-free" (an identity mismatch, an lstat
 * that failed, a volume with no usable file index). Saying "symlink refused"
 * for all of them sends whoever reads the log hunting for a symlink that was
 * never there, so the detail carries the actual reason and the headline stays
 * generic.
 */
function eloop(path, detail) {
  return Object.assign(
    new Error(`ELOOP: refusing ${path} — the open could not be proven symlink-free (${detail})`),
    { code: 'ELOOP', path }
  )
}

/**
 * The implementation, with its filesystem + platform seam exposed so the win32
 * branch can be exercised on EVERY platform. Production code calls
 * {@link openNoFollow}, which supplies {@link defaultOpenNoFollowDeps}.
 *
 * @param {string} path - Absolute path to open
 * @param {number} flags - Caller's open flags, WITHOUT O_NOFOLLOW
 * @param {number} [mode] - Creation mode, forwarded unchanged
 * @param {object} deps - `{ hasONoFollow, oNofollow, platform, open, lstat, fstat }`
 * @returns {Promise<import('fs/promises').FileHandle>}
 */
export async function _openNoFollowImpl(path, flags, mode, deps) {
  const { hasONoFollow, oNofollow, platform, open, lstat, fstat } = deps

  if (hasONoFollow) {
    // POSIX: unchanged behaviour — one atomic, kernel-enforced decision.
    return open(path, flags | oNofollow, mode)
  }

  // No O_NOFOLLOW. win32 is the ONE platform where that is expected and where
  // the emulation below is known-correct. Anywhere else, REFUSE — a platform
  // we have not reasoned about must not get a plain open() that silently
  // follows symlinks, which is the exact no-op this module exists to delete.
  if (platform !== 'win32') {
    throw Object.assign(
      new Error(`openNoFollow: O_NOFOLLOW is unavailable on platform '${platform}' and only win32 has a verified fallback — refusing to open ${path} without symlink protection`),
      { code: 'ENOSYS', path }
    )
  }

  // Step 1 — refuse an already-planted symlink or junction before opening it.
  try {
    const pre = await lstat(path)
    if (pre.isSymbolicLink()) throw eloop(path, 'lstat reports a symlink before open')
  } catch (err) {
    if (err.code === 'ELOOP') throw err
    // ENOENT is not a refusal: an O_CREAT caller is about to create the file,
    // and a non-creating caller gets its own ENOENT from the open below —
    // identical to POSIX. Every other error is a failure to CHECK, and a
    // failure to check is a refusal.
    if (err.code !== 'ENOENT') throw err
  }

  const fh = await open(path, flags, mode)

  // Step 3 — prove the fd we hold is the file the path names. `{ bigint: true }`
  // because a Windows file index does not fit in a Number.
  let ok = false
  try {
    const [onFd, onPath] = await Promise.all([fstat(fh), lstat(path)])
    if (onPath.isSymbolicLink()) throw eloop(path, 'a symlink appeared at the path after open')
    if (onFd.ino === 0n || onPath.ino === 0n) {
      throw eloop(path, 'no usable file index — the identity check would be vacuous')
    }
    if (onFd.dev !== onPath.dev || onFd.ino !== onPath.ino) {
      throw eloop(path, 'the opened file is not the file at this path — swapped between check and open')
    }
    ok = true
  } catch (err) {
    if (err.code === 'ELOOP') throw err
    // The verification itself failed (the path vanished, access was revoked).
    // Fail closed: we cannot show the fd is the file we checked.
    throw eloop(path, `identity check failed (${err.code || err.message})`)
  } finally {
    if (!ok) await fh.close().catch(() => {})
  }

  return fh
}

/**
 * Open `path` refusing a final-component symlink, on every platform.
 *
 * Rejects with `code: 'ELOOP'` when the final component is (or becomes) a
 * symlink — on POSIX because the kernel said so, on win32 because the
 * lstat + fd-identity check above said so. See the module header for exactly
 * which race this closes and which it cannot.
 *
 * @param {string} path - Absolute path to open
 * @param {number} flags - Open flags, WITHOUT O_NOFOLLOW (this adds it)
 * @param {number} [mode] - Creation mode, forwarded unchanged
 * @returns {Promise<import('fs/promises').FileHandle>}
 */
export function openNoFollow(path, flags, mode) {
  return _openNoFollowImpl(path, flags, mode, defaultOpenNoFollowDeps)
}
