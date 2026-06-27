import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SessionManager } from '../src/session-manager.js'

/**
 * Swarm-audit leak fix: a session that chronically fails to restore re-fails +
 * re-persists on every boot, so _failedRestores + session-state.json grow
 * without bound (clearFailedRestore was only called on a user retry/dismiss).
 * _pruneStaleFailedRestores drops entries inactive past the TTL — conservatively
 * (recent + timestamp-less entries are kept).
 */
describe('SessionManager._pruneStaleFailedRestores (swarm-audit leak fix)', () => {
  let sm
  let dir

  afterEach(() => {
    try { sm?.destroy?.() } catch { /* ignore */ }
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('prunes failed-restores inactive > 30d; keeps recent + timestamp-less ones', () => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-'))
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json') })

    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    sm._failedRestores.set('old', { saved: { id: 'old', name: 'Old', lastActivityAt: now - 40 * DAY }, error: new Error('x') })
    sm._failedRestores.set('byCreated', { saved: { id: 'byCreated', name: 'ByCreated', createdAt: now - 40 * DAY }, error: new Error('x') })
    sm._failedRestores.set('recent', { saved: { id: 'recent', name: 'Recent', lastActivityAt: now - 5 * DAY }, error: new Error('x') })
    sm._failedRestores.set('noTime', { saved: { id: 'noTime', name: 'NoTime' }, error: new Error('x') })

    const pruned = sm._pruneStaleFailedRestores(now)

    assert.equal(pruned, 2)
    assert.equal(sm._failedRestores.has('old'), false, 'old (lastActivityAt > 30d) pruned')
    assert.equal(sm._failedRestores.has('byCreated'), false, 'old via createdAt fallback pruned')
    assert.equal(sm._failedRestores.has('recent'), true, 'recent failure kept for the needs-attention UI')
    assert.equal(sm._failedRestores.has('noTime'), true, 'timestamp-less entry kept (not guessed stale)')
  })

  it('is a no-op on an empty failed-restore set', () => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-'))
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json') })
    assert.equal(sm._pruneStaleFailedRestores(Date.now()), 0)
  })
})
