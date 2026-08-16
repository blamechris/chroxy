// is-entry-point.mjs — "was this module run directly, or imported?"
//
// The one implementation for `scripts/`. It is a deliberate second copy of
// packages/server/src/utils/is-entry-point.js: `scripts/` sits outside every
// workspace package, and no script in this directory reaches into
// `packages/*/src` for anything (#7217). A third copy is inlined in
// packages/server/sidecar/agent.js, which ships as a standalone in-pod bundle
// and cannot import either of the other two.
//
// Three copies of one guard is the shape #7213 was filed to remove, so the
// thing that keeps them honest is not a convention but a test: the drift gate
// in scripts/__tests__/is-entry-point.test.mjs extracts the guard from all
// three files, strips comments, and fails if any has diverged. Change one,
// change the others — and if you forget, that test says which (#7222).
//
// Why this is not `import.meta.main` (#7222). Node 22.18.0 shipped that as a
// native, symlink-correct replacement for the whole comparison below, and it
// would delete every copy of this. It is unusable here: the declared floor is
// `"node": ">=22"`, and on Node 22.0–22.17 `import.meta.main` is plain
// `undefined`. A falsy guard on an older-but-supported runtime is exactly the
// silent exit-0 no-op this module exists to prevent, reintroduced as a version
// skew that no CI job pinned to `node-version: 22` would ever show. Revisit
// when the engines floor moves to >=22.18.
//
// The trap this replaces: Node's ESM loader RESOLVES SYMLINKS in
// `import.meta.url`, but `process.argv[1]` is whatever the caller typed, and
// neither `resolve()` nor `pathToFileURL()` follows symlinks. On macOS /tmp is
// a symlink to /private/tmp, so running a script by a /tmp path gives
// 'file:///private/tmp/x.mjs' on one side and 'file:///tmp/x.mjs' on the other.
// The guard reads false, main() never runs, and the process exits 0 having done
// nothing — the failure is silence, which is why it survived in four files
// (#7198, #7213).
//
// Usage:
//   import { isEntryPoint } from './lib/is-entry-point.mjs'
//   if (isEntryPoint(import.meta.url)) { main() }

import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * True when `importMetaUrl`'s module is the script node was invoked with.
 *
 * Order matters. The plain (non-realpath) comparison runs FIRST and is
 * conclusive on its own: if the two paths are already identical, this module
 * is the entry point and no filesystem access is needed to say so. Only when
 * they differ is realpath consulted, because the sole reason they can differ
 * while still naming the same file is a symlink somewhere in the invocation
 * path.
 *
 * That ordering is the point, not an optimisation. Reaching for realpath
 * first and treating a failure as `false` recreates the very bug this module
 * exists to remove: an `EACCES` on some parent directory, or a script
 * unlinked after launch, would make a direct `node foo.js` evaluate false,
 * `main()` would never run, and the process would exit 0 having done nothing
 * (#7214). Doing the cheap comparison first means no filesystem error can
 * reach the common case at all.
 *
 * The one genuinely undecidable case is left: paths that differ AND cannot be
 * realpath'd. Whether a symlink joins them is unknowable without the
 * filesystem call that just failed, and `false` is the only defensible answer.
 * Undecidable does not have to mean quiet, though — that combination is what
 * made #7198 and #7214 expensive to find — so that branch warns on stderr
 * before returning (#7226). The ordinary "this module was imported" answer
 * stays silent; only the branch that could not tell says anything.
 *
 * argv[1] absent (an `-e` eval, a REPL) means there is no invoked script, so
 * nothing can be the entry point.
 *
 * @param {string} importMetaUrl - the calling module's `import.meta.url`
 * @returns {boolean}
 */
export function isEntryPoint(importMetaUrl) {
  if (!process.argv[1]) return false

  const self = fileURLToPath(importMetaUrl)
  const invoked = resolve(process.argv[1])
  if (self === invoked) return true

  // Paths differ — a symlink is the only thing that still makes them the same
  // file, so this is where realpath earns its keep.
  const failures = []
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch (err) {
      failures.push({ path: p, code: err.code || err.message })
      return null
    }
  }
  const realSelf = real(self)
  const realInvoked = real(invoked)
  if (realSelf !== null && realInvoked !== null) return realSelf === realInvoked

  // At least one side would not resolve, so the answer is `false` either way.
  // Whether that `false` is DECIDED or merely UNKNOWN is a different question,
  // and only the unknown one is worth a diagnostic (#7226). The two sides are
  // not symmetric:
  //
  //   `self`    node LOADED this module, so its path resolved moments ago. If
  //             it does not resolve now the ground moved underneath us — a
  //             symlinked invocation whose target was unlinked, a directory
  //             that lost its permissions — and whether a symlink still joins
  //             the two paths is genuinely unknowable. Always warn.
  //   `invoked` just a string the caller supplied. ENOENT/ENOTDIR means it
  //             definitively does not exist, and a path that does not exist
  //             cannot be the file we were loaded from — that is a DECIDED
  //             false. Warning on it would fire on ordinary imports, where
  //             argv[1] is some other script entirely, and a warning that
  //             cries wolf on every import is worse than no warning at all.
  //             Any other errno (EACCES, ELOOP, …) means the filesystem
  //             refused to answer rather than answered "no", so it could still
  //             be an inaccessible symlink to this very file: unknown, warn.
  const unknowable = realSelf === null ||
    failures.some(({ code }) => code !== 'ENOENT' && code !== 'ENOTDIR')
  if (unknowable) {
    const why = failures.map(({ path, code }) => `${path}: ${code}`).join('; ')
    console.warn(
      `[is-entry-point] ${basename(self)}: cannot determine whether this module was run ` +
      `directly — realpath failed (${why}). Assuming it was imported, so its command-line ` +
      'behaviour did NOT run. If you invoked it directly, it did nothing.',
    )
  }
  return false
}
