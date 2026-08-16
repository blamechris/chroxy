// is-entry-point.js — "was this module run directly, or imported?"
//
// Every hand-rolled version of this check in the repo was wrong the same way,
// so there is one implementation now (#7213, after #7198).
//
// The trap: Node's ESM loader RESOLVES SYMLINKS in `import.meta.url`, but
// `process.argv[1]` is whatever the caller typed. Neither `resolve()` nor
// `pathToFileURL()` follows symlinks, so every one of these compares a
// realpath against a non-realpath:
//
//   resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
//   import.meta.url === pathToFileURL(process.argv[1]).href
//   process.argv[1] === fileURLToPath(import.meta.url)
//
// On macOS /tmp is a symlink to /private/tmp, so running a script by a /tmp
// path gives 'file:///private/tmp/x.mjs' on one side and 'file:///tmp/x.mjs'
// on the other. The guard reads false, main() never runs, and the process
// exits 0 having done nothing — the failure is silence, which is why it
// survived in four separate files.
//
// Demonstrated:
//   import.meta.url        : file:///private/tmp/ptfu/probe.mjs
//   pathToFileURL(argv[1]) : file:///tmp/ptfu/probe.mjs
//   guard would be         : false
//
// Usage:
//   import { isEntryPoint } from './utils/is-entry-point.js'
//   if (isEntryPoint(import.meta.url)) { main() }

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
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
 * (#7217 review). Doing the cheap comparison first means no filesystem error
 * can reach the common case at all.
 *
 * The one genuinely undecidable case is left: paths that differ AND cannot be
 * realpath'd. Whether a symlink joins them is unknowable without the
 * filesystem call that just failed, and `false` is the only defensible answer
 * — it is also strictly better than the pre-#7213 behaviour, which got that
 * case wrong even when realpath would have succeeded.
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
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  const realSelf = real(self)
  const realInvoked = real(invoked)
  return realSelf !== null && realSelf === realInvoked
}
