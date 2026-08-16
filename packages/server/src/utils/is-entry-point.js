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
 * Both sides are realpath'd so a symlinked invocation path still matches.
 * Anything that cannot be resolved to a real file — argv[1] absent (an `-e`
 * eval, a REPL), a deleted script, a path we lack permission to stat — is
 * simply not this module, so the guard is false and the caller behaves as if
 * imported. That is the safe direction: a missed CLI run is loud (nothing
 * happens and the user notices), whereas side effects firing during an import
 * would corrupt a test run.
 *
 * @param {string} importMetaUrl - the calling module's `import.meta.url`
 * @returns {boolean}
 */
export function isEntryPoint(importMetaUrl) {
  if (!process.argv[1]) return false
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  const self = real(fileURLToPath(importMetaUrl))
  const invoked = real(resolve(process.argv[1]))
  return self !== null && self === invoked
}
