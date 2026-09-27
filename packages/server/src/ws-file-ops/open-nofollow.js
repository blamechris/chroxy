import { open as fsOpen, lstat as fsLstat } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { createLogger } from '../logger.js'

const log = createLogger('open-nofollow')

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
 *
 * ── #7874 — a volume with no file index is REFUSED, and says so ────────────
 *
 * Policy, decided by the owner on 2026-09-26: when either inode in step 3 is
 * `0`, the open is refused. It does not degrade.
 *
 * libuv fills a win32 `st_ino` from `FILE_INTERNAL_INFORMATION.IndexNumber`.
 * NTFS supplies a real index; FAT/exFAT and some network redirectors and
 * virtual file systems report `0`. On such a volume `dev` + `ino` equality is
 * true for ANY two files, so the step-3 comparison would pass whatever the fd
 * points at. The alternative was to skip step 3 there and keep only step 1's
 * pre-open lstat. That drops the half of this guard that catches a swap
 * between check and open, and it drops it on exactly the volumes nobody
 * tests. A Windows workspace on such a volume is rare, so it is refused.
 *
 * The cost is that every file-ops open on that volume fails, and the caller's
 * wire message ("Access denied: … restricted to the project directory")
 * names a cause that is not the cause. So this refusal, and only this one,
 * logs a warn line of its own naming the file-index cause, the path, both
 * inodes and the volume's `dev`, and tags the error `reason: 'no-file-index'`
 * (a `dev` mismatch is checked first and refused as a swap: two volumes
 * prove the files differ whatever index either reports)
 * ({@link NO_FILE_INDEX}). The wire contract stays `code: 'ELOOP'`, so the
 * distinction lives in the server log, where a support report can find it.
 * `trusted-file-read.js` carries the same refusal and uses the same line.
 *
 * Revisit if a Windows Dev Drive (ReFS) user reports this line. If ReFS
 * reports index `0` through libuv, the affected set is a common developer
 * setup rather than a rare one, and the trade-off above changes.
 *
 * ── #7938 — O_NONBLOCK, so a planted FIFO can't hang the open() itself ─────
 *
 * `O_NOFOLLOW` refuses a symlink; it says nothing about a FIFO, character
 * device, or other non-regular file an attacker plants at the same path.
 * POSIX `open(2)` for a FIFO opened `O_RDONLY` with no `O_NONBLOCK` blocks the
 * calling thread until a writer connects — forever, if none ever does. Three
 * independent call sites in this codebase (claude-hooks `resolveIngestSecret`,
 * `trusted-file-read.js`'s credential-store read, claude-tui's
 * `_hookReadFile`) shipped exactly this hang, each caught only by adversarial
 * review after the fact. `O_NONBLOCK` is now ORed into every open this helper
 * performs, on both branches, so the fix lives in the ONE place instead of
 * being re-discovered per caller. It is a POSIX no-op for a regular file (the
 * open still succeeds and reads normally) but changes semantics for a
 * FIFO/device: the open returns immediately regardless of a writer, and a
 * subsequent blocking `read()` on an empty FIFO would then fail with `EAGAIN`
 * rather than hang. Every caller that reads the returned handle's CONTENT
 * (not just its identity) must therefore check `isFile()` via `fstat` on the
 * handle BEFORE reading, so a FIFO/device is refused with a clear error
 * instead of surfacing as a confusing `EAGAIN` from the read call — see
 * `reader.js`/`memory.js`'s post-open checks. `O_NONBLOCK` is undefined on
 * win32 (same `#ifdef`-gated story as `O_NOFOLLOW`), so `O_NONBLOCK` below is
 * `0` there and the OR is a no-op, matching `HAS_O_NOFOLLOW`'s idiom.
 */

/** True when this platform's Node exports a usable `O_NOFOLLOW`. */
const HAS_O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' && fsConstants.O_NOFOLLOW !== 0

/** True when this platform's Node exports a usable `O_NONBLOCK` (#7938). */
const HAS_O_NONBLOCK = typeof fsConstants.O_NONBLOCK === 'number' && fsConstants.O_NONBLOCK !== 0
const O_NONBLOCK = HAS_O_NONBLOCK ? fsConstants.O_NONBLOCK : 0

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
 * #7874 — the `reason` on a refusal caused by a volume that reports file
 * index 0. See the module header for the policy.
 */
export const NO_FILE_INDEX = 'no-file-index'

/**
 * #7874 — the one log line for an index-0 refusal, shared with
 * `trusted-file-read.js` so both refusal sites read the same in a support
 * report. It names the cause and says that no symlink was seen, because the
 * wire message the user saw says "access denied" and a reader of the log
 * would otherwise go looking for one. Both callers compare `dev` BEFORE the
 * index-0 check, so this line is only reached for two stats on the SAME
 * volume; a one-sided 0 across volumes is refused as a swap instead.
 *
 * @param {string} who - The refusing function, for the log line
 * @param {string} path - The path that was refused
 * @param {{ dev: bigint, ino: bigint }} onFd - fstat of the opened fd
 * @param {{ dev: bigint, ino: bigint }} onPath - lstat of the path after open
 * @returns {string}
 */
export function describeNoFileIndex(who, path, onFd, onPath) {
  return `${who} refused ${path}: the fd-identity check read file index 0 (fd ino=${onFd.ino}, path ino=${onPath.ino}, volume dev=${onFd.dev}), so it cannot prove the opened file is the one at the path. No symlink was seen. A volume without file indexes (FAT/exFAT, some network or virtual volumes) reports 0 for every file and cannot be opened through a symlink-refusing open; use an NTFS volume (#7874).`
}

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
 * @param {object} deps - `{ hasONoFollow, oNofollow, platform, open, lstat, fstat, log? }`.
 *   `log` defaults to this module's logger, so a test that injects only the
 *   fs seam still reaches the real log sink.
 * @returns {Promise<import('fs/promises').FileHandle>}
 */
export async function _openNoFollowImpl(path, flags, mode, deps) {
  const { hasONoFollow, oNofollow, platform, open, lstat, fstat } = deps
  const logger = deps.log || log

  if (hasONoFollow) {
    // POSIX: one atomic, kernel-enforced decision for the symlink refusal,
    // PLUS O_NONBLOCK (#7938) so a FIFO/device planted at the path can't hang
    // this open() forever waiting for a counterpart end. No-op for a regular
    // file; see the module header for what callers must do differently now
    // that a FIFO's open returns instead of blocking.
    return open(path, flags | oNofollow | O_NONBLOCK, mode)
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

  // #7938 — O_NONBLOCK here too, belt-and-suspenders: win32 has no `mkfifo`-
  // planted-FIFO attack surface (O_NONBLOCK is undefined there, so this ORs
  // in 0), but nothing about the win32 emulation branch's own reasoning
  // depends on blocking-open semantics, so there is no reason to special-case
  // it out.
  const fh = await open(path, flags | O_NONBLOCK, mode)

  // Step 3 — prove the fd we hold is the file the path names. `{ bigint: true }`
  // because a Windows file index does not fit in a Number.
  let ok = false
  try {
    const [onFd, onPath] = await Promise.all([fstat(fh), lstat(path)])
    if (onPath.isSymbolicLink()) throw eloop(path, 'a symlink appeared at the path after open')
    // #7874: volumes first. Two different volumes prove a swap whatever file
    // index either reports, so a one-sided index 0 across volumes is refused
    // as the swap it is, not logged as an index-less volume.
    if (onFd.dev !== onPath.dev) {
      throw eloop(path, 'the opened file is on a different volume than the file at this path — swapped between check and open')
    }
    if (onFd.ino === 0n || onPath.ino === 0n) {
      // #7874: refused, per the module header's policy, and logged so the
      // refusal cannot be mistaken for a symlink or containment rejection.
      // Best-effort: this line sits inside the try below, so a throwing log
      // sink would otherwise be rethrown as "identity check failed" and lose
      // both the reason and the diagnostic.
      try { logger.warn(describeNoFileIndex('openNoFollow', path, onFd, onPath)) } catch { /* best-effort */ }
      throw Object.assign(
        eloop(path, 'no usable file index — the identity check would be vacuous'),
        { reason: NO_FILE_INDEX }
      )
    }
    if (onFd.ino !== onPath.ino) {
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
