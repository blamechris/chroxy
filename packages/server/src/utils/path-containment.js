// path-containment.js — the shared answer to "is this path inside that
// directory?" (#7273). Intended to be the only one; see the scope caveat below
// for where copies still survive (#7287).
//
// ── Why this file exists ────────────────────────────────────────────────────
//
// The question "does `target` live inside `root`?" was hand-rolled at fifteen
// call sites across the server, in THREE spellings — and every one of them is
// wrong in at least one way:
//
//   target.startsWith(root + '/')      ws-file-ops/common.js (x2), reader.js, browser.js
//   target.startsWith(root + sep)      ws-file-ops/common.js, memory.js
//   rel.startsWith('..')               handler-utils.js (x2)
//   rel.startsWith('..' + sep)         ide/search.js, ide/symbols.js
//
// This module replaces all of them, for the same reason
// `utils/componentwise-resolver.js` exists: a security-relevant path predicate
// must have exactly one implementation, or the copies drift and only some of
// them get fixed. #6928 was a bug present in BOTH copies of the component-wise
// walk; this is the same lesson applied to containment.
//
// ── What this module does NOT yet cover ─────────────────────────────────────
//
// Be honest about the boundary, because "one implementation" is a claim that
// rots quietly. #7273 converted the ws-file-ops, attachment, conversation-scope
// and IDE surfaces. These hand-rolled copies survive elsewhere and are tracked
// in #7287:
//
//   docker-byok-session.js  remapToContainerPath — `root + '/'` on a HOST path;
//                           breaks docker-byok on a Windows host outright
//   devcontainer-config.js  validateMounts — an `endsWith(sep) ? : + sep` variant
//   pages-store.js          resolveFile — `root + sep`, twice
//   server-cli.js           isWithinHome — a default-SELECTION heuristic, not a
//                           containment gate; converting it would CHANGE behaviour
//   permission-{floor,manager}.js  already carry the correct `isAbsolute(rel)`
//                           term, so they are consistent but are still a second
//                           implementation of this predicate
//
// There is no lint stopping a sixteenth copy from being written. That is the
// most valuable unbuilt piece of this work; also #7287.

// ── The three defects, and why the obvious fixes do not work ────────────────
//
// (1) `root + '/'` assumes the POSIX separator. On Windows every path that
//     comes back from `realpath()` / `resolve()` is backslash-separated, so the
//     prefix NEVER matches and the check rejects every legitimate in-project
//     path. This is the visible half of #7273: 63 assertions across 15 server
//     test files, all reporting some variant of "Access denied: ... restricted
//     to the project directory" for a path that is plainly inside the project.
//
// (2) `root + sep` — the "obvious" fix — is ALSO wrong, on both platforms, and
//     this is why the fix is a helper rather than a sed. Concatenating a
//     separator breaks for any root that ALREADY ends in one, i.e. every
//     filesystem root:
//
//       'C:\\Documents'.startsWith('C:\\' + '\\')  ->  false   (win32)
//       '/tmp'.startsWith('/' + '/')               ->  false   (posix)
//
//     A daemon whose session cwd is a drive root or `/` would deny everything.
//     `root + sep` also stays case-SENSITIVE, so on NTFS it rejects
//     `c:\proj\a.js` against a root recorded as `C:\Proj` — two spellings of
//     one real directory.
//
// (3) `rel.startsWith('..')` — the `relative()`-based family — fails OPEN on
//     Windows, which is the security half of #7273 and the reason this landed
//     as a fix rather than a cleanup. `path.win32.relative()` only emits a
//     `..`-prefixed path when both sides share a ROOT. When the roots DIFFER —
//     a second drive letter, a UNC share, or the `\\?\` device namespace — it
//     returns the target VERBATIM, as an absolute path, which does not start
//     with `..`:
//
//       path.win32.relative('C:\\proj', 'D:\\secrets\\x')  ->  'D:\\secrets\\x'
//
//     so the guard passes and the caller reads a file on another volume. The
//     companion round-trip check some call sites paired with it,
//     `resolve(root, rel) !== target`, does not help: for a cross-root target
//     `resolve(root, target) === target` by definition, so the test is a
//     tautology. `isAbsolute(rel)` is the term that closes it.
//
//     The same `startsWith('..')` spelling ALSO fails CLOSED on both platforms
//     for a legitimate top-level directory whose name merely begins with two
//     dots — `..hidden/f.js` is not traversal, but `startsWith('..')` says it
//     is. Testing `rel === '..' || rel.startsWith('..' + sep)` keeps the
//     traversal rejection while letting `..hidden` through.
//
// ── What this module does instead ───────────────────────────────────────────
//
// `path.relative()` already handles every one of the above, because it is
// root-aware and (on win32) case-insensitive by construction — it is the
// platform's own answer to the question. The helper is a thin, correct reading
// of its result. See `path-containment.test.js`, which runs the whole table
// against BOTH `path.posix` and `path.win32` on every host, so a POSIX-only CI
// run still catches a Windows regression.
//
// ── Scope: this answers containment, NOT symlink resolution ─────────────────
//
// `isPathWithin` is a pure STRING predicate over two already-resolved absolute
// paths. It does not touch the filesystem and it does not follow symlinks.
// Callers that need symlink-faithful containment must resolve first —
// `realpath()`, `realpathOfDeepestAncestor()` or `resolveTargetComponentwiseAsync()`
// — and hand the resolved paths in. That division is deliberate: mixing the two
// is what produced the TOCTOU and symlink-escape bugs documented in
// `ws-file-ops/common.js`.

import path from 'path'

/**
 * Build a containment predicate bound to a specific `path` implementation.
 *
 * This factory is not indirection for its own sake — it is what makes the
 * Windows behaviour TESTABLE from a POSIX host. The alternative is to
 * transcribe the predicate into the test and assert against the copy, which
 * proves only that the copy behaves; `docs/false-safety-guards.md` catalogues
 * what that is worth. `path-containment.test.js` drives THIS function with
 * `path.win32` and `path.posix` in turn, so the exact code that ships is the
 * code under test on both platforms, on every host.
 *
 * @param {typeof import('path')} pathImpl - `path`, `path.win32` or `path.posix`
 * @returns {(target: string, root: string) => boolean}
 */
export function makeIsPathWithin(pathImpl) {
  const { relative, isAbsolute, sep } = pathImpl
  return function isPathWithin(target, root) {
    if (typeof target !== 'string' || typeof root !== 'string') {
      throw Object.assign(
        new Error(`isPathWithin requires two strings, got ${typeof target} and ${typeof root}`),
        { code: 'EINVAL' }
      )
    }
    if (!isAbsolute(target) || !isAbsolute(root)) {
      throw Object.assign(
        new Error(`isPathWithin requires absolute paths, got target=${target} root=${root}`),
        { code: 'EINVAL' }
      )
    }
    const rel = relative(root, target)
    // Identical paths — `relative()` returns ''. `root` contains itself.
    if (rel === '') return true
    // Different ROOT (other drive letter, UNC share, \\?\ device namespace).
    // `relative()` gives back the target verbatim; it is not under `root` at
    // all. This is the term that closes the Windows fail-open (defect 3 above).
    if (isAbsolute(rel)) return false
    // Real traversal. `rel === '..'` is the parent itself; `'..' + sep` is a
    // path THROUGH the parent. A leading `..` that is part of a longer NAME
    // (`..hidden`) is neither, and stays allowed.
    if (rel === '..' || rel.startsWith('..' + sep)) return false
    return true
  }
}

/**
 * Whether `target` is `root` itself, or lives underneath it.
 *
 * BOTH arguments must be ABSOLUTE and already symlink-resolved to whatever
 * degree the caller requires — see the module header. A relative argument is a
 * caller bug: `path.relative()` would silently resolve it against the SERVER
 * process's cwd, which has nothing to do with the intended boundary, so we
 * refuse rather than answer a question nobody asked.
 *
 * @param {string} target - Absolute path under test
 * @param {string} root - Absolute directory that should contain it
 * @returns {boolean}
 * @throws {Error} EINVAL if either argument is not an absolute string
 */
export const isPathWithin = makeIsPathWithin(path)
