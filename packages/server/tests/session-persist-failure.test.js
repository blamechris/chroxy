import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../src/session-manager.js'

/**
 * #5701 — flush failures on session-list mutations must be surfaced, not
 * swallowed. Before this, a create/rename/destroy could succeed in memory but
 * silently fail to write to disk (disk full / locked file / read-only home)
 * and revert on the next restart with no signal. `_flushPersistOrWarn` now
 * logs loudly and emits `session_persist_failed`.
 */
function makeMgr() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sm-persist-fail-'))
  const mgr = new SessionManager({
    skipPreflight: true,
    maxSessions: 10,
    defaultCwd: '/tmp',
    stateFilePath: join(tmpDir, 'state.json'),
  })
  mgr._tmpDir = tmpDir
  return mgr
}

function cleanup(mgr) {
  mgr.destroyAll()
  rmSync(mgr._tmpDir, { recursive: true, force: true })
}

describe('session_persist_failed (#5701)', () => {
  let mgr
  afterEach(() => { if (mgr) { cleanup(mgr); mgr = null } })

  it('emits session_persist_failed and returns false when the flush fails', () => {
    mgr = makeMgr()
    // Force the underlying write to report failure (as on disk-full / EACCES).
    mgr._persistence.flushPersist = () => false

    const events = []
    mgr.on('session_persist_failed', (e) => events.push(e))

    const ok = mgr._flushPersistOrWarn('sess-x', 'My Session')

    assert.strictEqual(ok, false, 'returns false on a failed flush')
    assert.equal(events.length, 1, 'emits exactly one session_persist_failed')
    assert.deepEqual(events[0], { sessionId: 'sess-x', name: 'My Session' })
  })

  it('returns true and emits nothing when the flush succeeds', () => {
    mgr = makeMgr()
    mgr._persistence.flushPersist = () => true

    const events = []
    mgr.on('session_persist_failed', (e) => events.push(e))

    const ok = mgr._flushPersistOrWarn('sess-y', 'Fine')

    assert.strictEqual(ok, true)
    assert.equal(events.length, 0, 'no failure event on success')
  })
})
