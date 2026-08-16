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

  // Reaching here means realpath could not answer for at least one side, so
  // whether a symlink still joins the two paths is unknowable and `false` is
  // the only defensible return. It is not, however, an excuse for silence —
  // that combination is what made #7198 and #7214 expensive (#7226).
  //
  // An earlier version of this warned only when the errno was something other
  // than ENOENT, on the theory that a non-existent argv[1] was a DECIDED false
  // and warning on it would cry wolf during ordinary imports. Both halves were
  // wrong. An ordinary import never reaches this line at all — argv[1] is the
  // script node is running, so it exists, both realpaths succeed, and the
  // comparison above returns. And ENOENT is not decided: argv[1] existed at
  // exec time by construction, so ENOENT means it was REMOVED SINCE. Swap a
  // `current -> releases-v1` symlink mid-run and you get exactly that — self
  // resolves, invoked is ENOENT, and the module genuinely IS the entry point.
  // The carve-out bought nothing and hid that case.
  const why = failures.map(({ path, code }) => `${path}: ${code}`).join('; ')
  console.warn(
    `[is-entry-point] ${basename(self)}: cannot determine whether this module was run ` +
    `directly — realpath failed (${why}). Assuming it was imported, so its command-line ` +
    'behaviour did NOT run. If you invoked it directly, it did nothing.',
  )
  return false
}
