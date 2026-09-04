import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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

  it('NEVER prunes a worktree-backed failed-restore, even when stale (#2954 protection)', () => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-'))
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json') })
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    // Both 90d stale; only the worktree-less one may be pruned. Pruning the
    // worktree-backed one would expose its worktree to the orphan sweep, which
    // can't see committed-but-unreachable --detach commits and would reclaim them.
    sm._failedRestores.set('wt', { saved: { id: 'wt', name: 'WT', lastActivityAt: now - 90 * DAY, worktreePath: '/some/wt/dir' }, error: new Error('x') })
    sm._failedRestores.set('plain', { saved: { id: 'plain', name: 'Plain', lastActivityAt: now - 90 * DAY }, error: new Error('x') })

    const pruned = sm._pruneStaleFailedRestores(now)

    assert.equal(pruned, 1)
    assert.equal(sm._failedRestores.has('wt'), true, 'worktree-backed entry kept regardless of age')
    assert.equal(sm._failedRestores.has('plain'), false, 'plain stale entry still pruned')
  })

  it('is a no-op on an empty failed-restore set', () => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-'))
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json') })
    assert.equal(sm._pruneStaleFailedRestores(Date.now()), 0)
  })
})

/**
 * #7627 — the 24h SESSION staleness filter deleted failed restores 29 days
 * before their own TTL.
 *
 * `SessionStatePersistence.restoreState()` drops entries whose `lastActivityAt`
 * is older than `_stateTtlMs` (24h by default, never overridden in production),
 * and `SessionManager.restoreState()` calls it as its FIRST statement — before
 * the restore loop. `serializeState` re-pushes a failed restore VERBATIM, so its
 * `lastActivityAt` stays frozen at the session's last real turn and never
 * advances. Any boot more than 24h after that turn therefore deleted the entry
 * before it could be registered: no `session_restore_failed`, no needs-attention
 * entry, and the preserved history gone — while `_pruneStaleFailedRestores`
 * advertised 30 days for exactly that entry.
 *
 * Drives the REAL restoreState() against a REAL state file, because the defect
 * lives in the ordering of two components and is invisible to either alone.
 */
describe('#7627 a failed restore is governed by its OWN TTL, not the 24h session filter', () => {
  let sm
  let dir
  const DAY = 24 * 60 * 60 * 1000
  const HOUR = 60 * 60 * 1000

  afterEach(() => {
    try { sm?.destroy?.() } catch { /* ignore */ }
    // `dir` MUST be cleared, not just removed: bootWith reuses it when truthy,
    // so a stale path would have it writing into a deleted directory.
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
  })

  // An environment that reports a DIFFERENT container than the one persisted —
  // the #7619 refusal, chosen because it is the arm that can never self-clear.
  const rebuiltEnv = () => ({
    getContainerInfo: () => ({ containerId: 'ctr-REBUILT' }),
    addSession() {}, removeSession() {},
  })

  function bootWith({ ageMs, extra = {} }) {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-7627-'))
    const statePath = join(dir, 'state.json')
    const lastActivityAt = Date.now() - ageMs
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      timestamp: lastActivityAt,
      sessions: [{
        id: 'a'.repeat(32), name: 'Important', cwd: '/tmp',
        environmentId: 'env-1', containerId: 'ctr-created',
        lastActivityAt,
        history: [{ role: 'user', content: 'hours of work' }],
        ...extra,
      }],
    }))
    sm = new SessionManager({ stateFilePath: statePath, environmentManager: rebuiltEnv() })
    const events = []
    sm.on('session_restore_failed', (e) => events.push(e))
    sm.restoreState()
    return { events, statePath }
  }

  it('POSITIVE CONTROL: a failure 1h after the last turn registers and preserves its history', () => {
    const { events, statePath } = bootWith({ ageMs: 1 * HOUR })
    assert.equal(events.length, 1, 'the refusal surfaced')
    assert.equal(sm.getFailedRestores().length, 1, 'and registered for the needs-attention list')
    sm._flushPersist()
    const disk = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.equal(disk.sessions.length, 1, 're-pushed to disk')
    assert.equal(disk.sessions[0].history.length, 1, 'with its history')
  })

  it('a failure 25h after the last turn STILL registers — the 24h session filter must not eat it', () => {
    const { events, statePath } = bootWith({ ageMs: 25 * HOUR })
    assert.equal(events.length, 1, 'a day-old session that CANNOT be restored is still reported, not silently dropped')
    assert.equal(sm.getFailedRestores().length, 1, 'it reaches the needs-attention list')
    sm._flushPersist()
    const disk = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.equal(disk.sessions.length, 1, 'and survives on disk')
    assert.equal(disk.sessions[0].history.length, 1, 'with the history the docs promise is preserved')
  })

  it('a failure 40 DAYS old is NOT resurrected — its own 30-day TTL still bounds it', () => {
    const { events } = bootWith({ ageMs: 40 * DAY })
    assert.deepEqual(events, [], 'past its own TTL it is not re-registered')
    assert.equal(sm.getFailedRestores().length, 0, 'so the needs-attention list stays bounded')
  })

  it('REGRESSION: an all-stale boot still COLLECTS the cost map of the sessions it dropped', () => {
    // Removing persistence's null return let the tail of restoreState() run on a
    // boot where it never used to. `_costBudget.restore()` then re-loads the cost
    // entries of sessions dropped in that same flush — and the all-stale boot is
    // the ONLY occasion those dead entries are collected, since every other boot
    // round-trips the whole map. Without the early return, `costs` grows forever.
    dir = mkdtempSync(join(tmpdir(), 'chroxy-7627c-'))
    const statePath = join(dir, 'state.json')
    const stale = Date.now() - 25 * HOUR
    const DEAD = 'd'.repeat(32)
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      timestamp: stale,
      // No environmentId — it would have restored fine, so it is merely stale.
      sessions: [{ id: DEAD, name: 'Session 1', cwd: '/tmp', lastActivityAt: stale, history: [] }],
      costs: { [DEAD]: 4.25 },
      budgetPaused: [DEAD],
    }))
    sm = new SessionManager({ stateFilePath: statePath })
    sm.restoreState()
    sm._flushPersist()
    const disk = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.equal(disk.sessions.length, 0, 'the stale session is dropped, as before')
    assert.deepEqual(disk.costs ?? {}, {}, 'and its cost entry is collected, not carried forever')
    assert.deepEqual(disk.budgetPaused ?? [], [], 'likewise its budget-paused flag')
  })

  it('REGRESSION: a PRESERVED stale refusal advances _sessionCounter, so a new session cannot take its name', () => {
    // Every other restore outcome advances the counter (#2338). A preserved
    // refusal leaves a "Session N" name on disk exactly as they do, so skipping
    // it made the needs-attention entry and the next live session share a name —
    // degrading the visibility this whole fix restores.
    const { events } = bootWith({ ageMs: 25 * HOUR, extra: { name: 'Session 1' } })
    assert.equal(events.length, 1, 'control: the refusal really was preserved')
    assert.equal(sm._sessionCounter, 1, 'the counter moved past the preserved name')
    assert.equal(
      sm.getFailedRestores().some(f => f.name === `Session ${sm._sessionCounter + 1}`), false,
      'so the next auto-named session cannot collide with it',
    )
  })

  it('a WORKTREE-backed stale refusal is preserved at ANY age — matching the prune (#2954)', () => {
    // _pruneStaleFailedRestores never drops a worktree-backed entry, because
    // removing its id exposes the worktree to the orphan sweep. The sweep's
    // bound must agree, or one silently overrides the other — which is the
    // defect this issue is about, one layer down.
    const { events } = bootWith({ ageMs: 40 * DAY, extra: { worktreePath: '/some/wt' } })
    assert.equal(events.length, 1, 'kept despite being far past the TTL')
    assert.equal(sm.getFailedRestores().length, 1)
  })

  it('an ORDINARY stale session is still dropped at 24h — the filter is narrowed, not removed', () => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-7627b-'))
    const statePath = join(dir, 'state.json')
    const lastActivityAt = Date.now() - 25 * HOUR
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      timestamp: lastActivityAt,
      // No environmentId: this one would RESTORE fine, so the 24h policy applies.
      sessions: [{ id: 'b'.repeat(32), name: 'Ordinary', cwd: '/tmp', lastActivityAt, history: [] }],
    }))
    sm = new SessionManager({ stateFilePath: statePath })
    let created = 0
    sm.createSession = () => { created++; return 'c'.repeat(32) }
    sm.restoreState()
    assert.equal(created, 0, 'a plain stale session is still not restored')
    assert.deepEqual(sm.getFailedRestores(), [], 'and is not turned into a needs-attention entry either')
  })
})
