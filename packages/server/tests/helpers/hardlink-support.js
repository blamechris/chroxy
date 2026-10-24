// Can this account, on this filesystem, give one file two names? Probed once,
// at import, so a host that cannot reports a hard-link test as skipped (with the
// reason) instead of failing its setup. See symlink-support.js for why this is
// a probe and not a try/catch around each test.

import { mkdtempSync, writeFileSync, linkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function probeHardLinkSupport() {
  let dir = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-hardlink-probe-'))
    writeFileSync(join(dir, 'a'), 'x')
    linkSync(join(dir, 'a'), join(dir, 'b'))
    return true
  } catch {
    return false
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

/** Pass into a node:test options bag: `false` runs the test, a string skips it. */
export const SKIP_NO_HARDLINK = probeHardLinkSupport()
  ? false
  : 'this filesystem cannot create a hard link (fs.link failed); the assertion runs where it can'
