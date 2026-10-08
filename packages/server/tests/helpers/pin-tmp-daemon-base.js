// #8352 — pin a session class's tmpdir-rooted daemon base to a per-test temp dir.
//
// `ClaudeTuiSession.SINK_BASE`, `CliSession.PERMISSION_MODE_SIDECAR_BASE`,
// `CodexAppServerSession.ATTACH_BASE` and `DockerByokSession.ENV_FILE_BASE` are
// each `join(tmpdir(), 'chroxy-…')`. That is the SAME directory a live daemon on
// this machine uses and VALIDATES by dev/ino, so a test that creates, sweeps or
// `rmSync`s the real one breaks every running session on that daemon (the
// 2026-10-07 `sink_base_compromised` incident). `_setup.mjs` now refuses any
// mutation of the real ones with CHROXY_TEST_SANDBOX (#8352, same family as
// #4633); this is the one place that says how a test stays off them.
//
//   let unpin
//   beforeEach(() => { unpin = pinTmpDaemonBase(ClaudeTuiSession, 'SINK_BASE') })
//   afterEach(() => unpin())
//
// The leaf name is kept (`<temp root>/chroxy-claude-tui`) so assertions that
// compare against the class getter, or against the leaf, still hold.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

/**
 * @param {Function} Cls  Class carrying the static getter.
 * @param {string} prop   The static getter name (e.g. 'SINK_BASE').
 * @returns {() => void}  Restores the original descriptor and removes the temp
 *   root. Idempotent.
 */
export function pinTmpDaemonBase (Cls, prop) {
  const original = Object.getOwnPropertyDescriptor(Cls, prop)
  if (!original || typeof original.get !== 'function') {
    throw new Error(`pinTmpDaemonBase: ${Cls.name}.${prop} is not an own static getter`)
  }
  // Read the leaf off the REAL getter, not a spelling in the test, so a rename
  // in src cannot leave the pin pointing at a different name than production.
  const leaf = basename(original.get.call(Cls))
  const root = mkdtempSync(join(tmpdir(), 'chroxy-test-daemon-base-'))
  const pinned = join(root, leaf)
  Object.defineProperty(Cls, prop, { get: () => pinned, configurable: true })
  let done = false
  return function unpin () {
    if (done) return
    done = true
    Object.defineProperty(Cls, prop, original)
    rmSync(root, { recursive: true, force: true })
  }
}
