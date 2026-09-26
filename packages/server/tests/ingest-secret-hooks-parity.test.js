// #7894 — the daemon's read-time trust boundary on ~/.chroxy/ingest-secret
// and the hook emitters' OWN read of that same file
// (`resolveIngestSecret` in packages/claude-hooks/src/config.js) must
// enforce the IDENTICAL mode+owner rule, duplicated as a literal on the hook
// side because that package carries zero runtime deps and cannot import
// this package's (unexported) trust-check internals.
//
// This is a BEHAVIORAL parity test, not a shared-constant pin: it drives
// each side's REAL, stable, public entry point —
// `loadOrCreateIngestSecret(secretPath)` (daemon) and
// `resolveIngestSecret(env)` (hook) — against the SAME on-disk fixture at
// each point on an accept/reject matrix, and asserts both land on the same
// side of the boundary. Deliberately not pinned to `assertIngestSecretFileTrusted`
// or any other internal daemon symbol: #7893 (a separate, concurrently-landing
// PR) refactors the daemon's internal trust check onto a new shared
// `trusted-file-read.js` helper and removes `assertIngestSecretFileTrusted`
// entirely, but `loadOrCreateIngestSecret`'s name, signature, and
// accept/reject behavior are unchanged by that refactor — so this test does
// not care which internal implementation is live when it runs, and survives
// #7893 landing before OR after this one.
//
// The claude-hooks import is by relative filesystem path, not the
// `@chroxy/claude-hooks` package name — deliberately: adding a workspace
// dependency from server → claude-hooks (even a devDependency) would invert
// the real relationship (claude-hooks is the leaf-most package; nothing
// should depend on it to build or test). A relative path resolves as plain
// ESM without touching either package.json.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateIngestSecret } from '../src/event-ingest.js'
import { resolveIngestSecret } from '../../claude-hooks/src/config.js'

describe('ingest-secret trust boundary parity — daemon vs. claude-hooks (#7894)', () => {
  let dir
  let secretPath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-secret-parity-'))
    secretPath = join(dir, 'ingest-secret')
  })

  /** Daemon side: true if the file is TRUSTED (returns its own content unchanged, i.e. does not throw and does not mint a replacement). */
  function daemonTrusts(content) {
    try {
      return loadOrCreateIngestSecret(secretPath) === content
    } catch {
      return false
    }
  }

  /** Hook side: true if the file is TRUSTED (resolveIngestSecret returns its content). */
  function hookTrusts(content) {
    return resolveIngestSecret({ CHROXY_CONFIG_DIR: dir }) === content
  }

  const CONTENT = 'shared-fixture-secret'

  it('both ACCEPT a 0600, self-owned file', () => {
    writeFileSync(secretPath, CONTENT + '\n', { mode: 0o600 })
    assert.equal(daemonTrusts(CONTENT), true, 'daemon must trust a 0600 self-owned file')
    assert.equal(hookTrusts(CONTENT), true, 'hook must trust the identical file')
  })

  for (const mode of [0o644, 0o640, 0o400, 0o666]) {
    it(`both REJECT a ${mode.toString(8)} self-owned file (same mode, same verdict)`, { skip: process.platform === 'win32' }, () => {
      writeFileSync(secretPath, CONTENT + '\n', { mode: 0o600 })
      chmodSync(secretPath, mode)
      assert.equal(daemonTrusts(CONTENT), false, `daemon must refuse mode ${mode.toString(8)}`)
      assert.equal(hookTrusts(CONTENT), false, `hook must refuse mode ${mode.toString(8)}`)
    })
  }

  it('both REJECT a 0600 file owned by a different uid', { skip: typeof process.getuid !== 'function' }, () => {
    writeFileSync(secretPath, CONTENT + '\n', { mode: 0o600 })
    // Neither side takes the uid to compare AS an argument — both call
    // process.getuid() directly — so mocking it globally affects both
    // readers identically, simulating "this process is not the file's real
    // owner" without needing root to chown the fixture.
    const realGetuid = process.getuid
    const realUid = realGetuid.call(process)
    process.getuid = () => realUid + 1
    try {
      assert.equal(daemonTrusts(CONTENT), false, 'daemon must refuse a foreign-owned file')
      assert.equal(hookTrusts(CONTENT), false, 'hook must refuse the identical file')
    } finally {
      process.getuid = realGetuid
    }
  })

  // The daemon's mode check is applied BEFORE the owner check in both the
  // current implementation and #7893's refactor, so a NARROWER mode (0400)
  // is refused for "wrong mode", never silently accepted because it happens
  // to also be self-owned — covered by the 0o400 case in the mode loop
  // above; this test only exists to make that intent explicit rather than
  // incidental.
  it('a narrower-than-required mode is refused, not treated as "safe enough"', { skip: process.platform === 'win32' }, () => {
    writeFileSync(secretPath, CONTENT + '\n', { mode: 0o600 })
    chmodSync(secretPath, 0o400)
    assert.equal(daemonTrusts(CONTENT), false)
    assert.equal(hookTrusts(CONTENT), false)
  })
})
