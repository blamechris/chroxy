import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { EventEmitter } from 'node:events'
import { SessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

// #7627 — a provider cheap enough to assert an auto-generated NAME against,
// so the counter test can check the real outcome instead of restating the
// counter it just asserted. Uniquely named: the registry is process-global and
// node --test runs files in parallel.
class Noop7627 extends EventEmitter {
  constructor(opts) { super(); this.cwd = opts.cwd; this.isRunning = false }
  static get capabilities() { return {} }
  start() {} destroy() {} sendMessage() {} interrupt() {} setModel() {} setPermissionMode() {}
}
declareUnknownCustomization(Noop7627)
registerProvider('test-noop-7627', Noop7627)

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
    assert.equal(sm.getFailedRestores()[0].name, 'Session 1')

    // Assert the OUTCOME, not the counter. Deriving the expected name from
    // `_sessionCounter` would restate the line above it and could not fail on
    // its own; actually creating the session can.
    const newId = sm.createSession({ cwd: '/tmp', provider: 'test-noop-7627' })
    assert.equal(
      sm.getSession(newId).name, 'Session 2',
      'the new session must not take the name still held by the needs-attention entry',
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

/**
 * #8858 — a PARKED failed restore must survive the 24h staleness filter.
 *
 * #7627 keeps a stale entry only when `_resolveRestoredContainerBinding` throws.
 * A parked entry is parked for any reason (missing cwd, deleted worktree, a Codex
 * session with no native locator), so when that check resolves the entry was
 * dropped from disk on the next write — its history gone on the first boot more
 * than 24h after last activity, contradicting #2954 (kept until Retry, Dismiss or
 * the 30-day TTL). `serializeState` now stamps `failedRestore: { code, message }`
 * on every parked entry and `restoreState` re-registers a stale entry carrying it.
 *
 * Drives the REAL park -> serialize -> reboot cycle over one state file.
 */
describe('#8858 a parked failed restore survives the 24h staleness filter', () => {
  let sm
  let dir
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  const ID = 'e'.repeat(32)

  afterEach(() => {
    try { sm?.destroy?.() } catch { /* ignore */ }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
  })

  const envReporting = (containerId) => ({
    getContainerInfo: () => ({ containerId }),
    addSession() {}, removeSession() {},
  })

  // Park a real restore on boot 1 (container mismatch), then age the file.
  function parkThenAge({ ageMs, extra = {} }) {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8858-'))
    const statePath = join(dir, 'state.json')
    const lastActivityAt = Date.now() - 1 * HOUR
    writeFileSync(statePath, JSON.stringify({
      version: 1, timestamp: lastActivityAt,
      sessions: [{
        id: ID, name: 'Parked', cwd: '/tmp', environmentId: 'env-1', containerId: 'ctr-created',
        lastActivityAt, history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
        ...extra,
      }],
    }))
    const first = new SessionManager({ stateFilePath: statePath, environmentManager: envReporting('ctr-REBUILT') })
    first.restoreState()
    assert.equal(first.getFailedRestores().length, 1, 'control: boot 1 parked it')
    first._flushPersist()
    first.destroy?.()
    const disk = JSON.parse(readFileSync(statePath, 'utf-8'))
    disk.sessions[0].lastActivityAt = Date.now() - ageMs
    writeFileSync(statePath, JSON.stringify(disk))
    return statePath
  }

  // Boot 2: the container now matches, so the #7627 binding check RESOLVES —
  // the exact shape that used to drop the entry.
  function reboot(statePath) {
    sm = new SessionManager({ stateFilePath: statePath, environmentManager: envReporting('ctr-created') })
    const events = []
    sm.on('session_restore_failed', (e) => events.push(e))
    sm.restoreState()
    sm._flushPersist()
    return { events, disk: JSON.parse(readFileSync(statePath, 'utf-8')) }
  }

  it('stays parked with its history 25h after last activity, even though its binding now resolves', () => {
    const { events, disk } = reboot(parkThenAge({ ageMs: 25 * HOUR }))
    assert.equal(events.length, 1, 'reported again')
    const list = sm.getFailedRestores()
    assert.equal(list.length, 1, 'still in the Failed restores list')
    assert.equal(list[0].historyLength, 2, 'with its history')
    assert.equal(list[0].errorCode, 'ENVIRONMENT_UNAVAILABLE', 'the ORIGINAL code, not the generic fallback')
    assert.equal(events[0].errorCode, 'ENVIRONMENT_UNAVAILABLE')
    assert.ok(list[0].errorMessage.length > 0, 'and the original message')
    assert.equal(disk.sessions.length, 1, 'still on disk after the write')
    assert.equal(disk.sessions[0].history.length, 2)
    assert.equal(typeof disk.sessions[0].failedRestore?.code, 'string', 'marker survives the round trip')
  })

  it('the persisted marker records the original error code and message', () => {
    const statePath = parkThenAge({ ageMs: 25 * HOUR })
    const marker = JSON.parse(readFileSync(statePath, 'utf-8')).sessions[0].failedRestore
    assert.equal(typeof marker.code, 'string')
    assert.ok(marker.message.length > 0)
    assert.ok(marker.message.length <= 500)
  })

  it('survives repeated reboots (marker is re-stamped each write)', () => {
    const statePath = parkThenAge({ ageMs: 25 * HOUR })
    reboot(statePath)
    sm.destroy?.()
    const { disk } = reboot(statePath)
    assert.equal(sm.getFailedRestores().length, 1)
    assert.equal(disk.sessions.length, 1)
  })

  it('is still bounded by the 30-day TTL when not worktree-backed', () => {
    reboot(parkThenAge({ ageMs: 40 * DAY }))
    assert.equal(sm.getFailedRestores().length, 0)
  })

  it('CONTROL: a stale session that was never parked is still dropped', () => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8858c-'))
    const statePath = join(dir, 'state.json')
    const lastActivityAt = Date.now() - 25 * HOUR
    writeFileSync(statePath, JSON.stringify({
      version: 1, timestamp: lastActivityAt,
      sessions: [{
        id: ID, name: 'Never parked', cwd: '/tmp', environmentId: 'env-1', containerId: 'ctr-created',
        lastActivityAt, history: [{ role: 'user', content: 'a' }],
      }],
    }))
    const { events, disk } = reboot(statePath)
    assert.deepEqual(events, [])
    assert.deepEqual(sm.getFailedRestores(), [])
    assert.equal(disk.sessions.length, 0, 'not carried to disk either')
  })

  it('caps the persisted message at 500 chars, on write and on read', () => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8858w-'))
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json') })
    sm._failedRestores.set(ID, { saved: { id: ID, name: 'Long', cwd: '/tmp', history: [] }, error: new Error('x'.repeat(5000)) })
    const written = sm.serializeState().sessions[0].failedRestore
    assert.equal(written.message.length, 500, 'write side is capped')
    assert.equal(sm._parkedMarker({ failedRestore: { code: 'C', message: 'y'.repeat(5000) } }).message.length, 500, 'read side is capped')
  })

  it('a worktree-backed marked entry stays parked past 30 days', () => {
    reboot(parkThenAge({ ageMs: 40 * DAY, extra: { worktreePath: '/some/wt' } }))
    assert.equal(sm.getFailedRestores().length, 1)
  })

  it('Dismiss removes the re-registered entry from disk for good', () => {
    const statePath = parkThenAge({ ageMs: 25 * HOUR })
    reboot(statePath)
    assert.equal(sm.clearFailedRestore(ID), true)
    sm._flushPersist()
    assert.equal(JSON.parse(readFileSync(statePath, 'utf-8')).sessions.length, 0)
  })

  for (const [label, failedRestore] of [
    ['non-object', 'yes'],
    ['numeric code', { code: 1, message: 'x' }],
    ['empty code', { code: '', message: 'x' }],
    ['missing message', { code: 'C' }],
  ]) {
    it(`a malformed marker (${label}) is ignored: the entry follows the pre-existing path`, () => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-8858m-'))
      const statePath = join(dir, 'state.json')
      const lastActivityAt = Date.now() - 25 * HOUR
      writeFileSync(statePath, JSON.stringify({
        version: 1, timestamp: lastActivityAt,
        sessions: [{ id: ID, name: 'Junk marker', cwd: '/tmp', lastActivityAt, history: [], failedRestore }],
      }))
      const { events } = reboot(statePath)
      assert.deepEqual(events, [])
      assert.deepEqual(sm.getFailedRestores(), [])
    })
  }
})
