// Does THIS account, on THIS host, get to create a symlink? (#7273)
//
// On Windows `fs.symlink` needs SeCreateSymbolicLinkPrivilege, granted by
// Developer Mode or by holding the privilege outright. An interactive developer
// account usually has it; the GitHub Actions service account usually does not,
// and gets EPERM. Same physical box, different answer — which is exactly how
// this got missed: every one of the fifteen #7273 files was measured over SSH as
// the interactive user, where symlinks work, while `Server Windows Tests` runs
// as NETWORK SERVICE, where they do not. The failure surfaced only in CI, as
//
//   EPERM: operation not permitted, symlink
//     'C:\WINDOWS\SERVIC~1\NETWOR~1\AppData\Local\Temp\...'
//
// so the capability must be PROBED, never inferred from the platform.
//
// ── Why this is a probe and not a try/catch around each test ────────────────
//
// The tempting shape is `try { symlinkSync(...) } catch { return }` — several
// tests in this repo already do it. That is `docs/false-safety-guards.md` mode
// (4): "cannot check this" silently becoming "nothing to check". The test
// reports a PASS having asserted nothing, and would keep reporting a pass if the
// behaviour it guards were deleted.
//
// A `{ skip }` says so out loud instead: node prints `# SKIP <reason>` and
// counts it under `# skipped`, so the TAP output distinguishes "verified" from
// "could not verify". The security assertions these guard still RUN in full on
// every Linux CI job, which is where the coverage actually lives — Windows
// merely cannot build the fixture.

import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function probeSymlinkSupport() {
  let dir = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-symlink-probe-'))
    // Mirror what the guarded tests actually do: link to a real DIRECTORY with
    // no explicit type, so node picks 'dir'. A junction would succeed without
    // the privilege and would make this probe lie.
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

/**
 * Pass straight into a node:test `it`/`describe` options bag:
 *   it('...', { skip: SKIP_NO_SYMLINK }, async () => { ... })
 * `false` runs the test; a string skips it and prints the reason.
 */
export const SKIP_NO_SYMLINK = SYMLINK_SUPPORTED
  ? false
  : 'needs symlink creation privilege (fs.symlink -> EPERM for this account); the assertion runs on POSIX CI'
