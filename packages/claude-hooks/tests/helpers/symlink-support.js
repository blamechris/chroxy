// Does THIS account, on THIS host, get to create a symlink?
//
// Same probe as packages/server/tests/helpers/symlink-support.js (#7273),
// duplicated here on purpose: that helper has ~46 importers inside the server
// package, so moving it is not a small change, and claude-hooks tests must not
// import across from packages/server/tests/. See that file for the rationale.
//
// The capability is PROBED, never inferred from the platform: on Windows
// fs.symlink needs SeCreateSymbolicLinkPrivilege, which an interactive
// developer account usually has and a CI service account usually lacks.
//
// Use it as an explicit skip, never as `try { symlinkSync() } catch { return }`:
// that shape reports a PASS having asserted nothing. A `{ skip }` prints
// `# SKIP <reason>` and counts under `# skipped`.

import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function probeSymlinkSupport() {
  let dir = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'hooks-symlink-probe-'))
    const target = join(dir, 'target')
    mkdirSync(target)
    symlinkSync(target, join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

/** True when this account can create a symlink. Probed once, at import. */
export const SYMLINK_SUPPORTED = probeSymlinkSupport()

/** Pass into a node:test options bag: `it('...', { skip: SKIP_NO_SYMLINK }, fn)`. */
export const SKIP_NO_SYMLINK = SYMLINK_SUPPORTED
  ? false
  : 'needs symlink creation privilege (fs.symlink -> EPERM for this account); the assertion runs on POSIX CI'
