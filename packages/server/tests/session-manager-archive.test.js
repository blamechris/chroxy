import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

import { SessionManager } from '../src/session-manager.js'
import { SessionArchive } from '../src/session-archive.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * The session archive, wired into SessionManager: every path by which a session
 * leaves the live set (or is dropped from the persisted set) archives the
 * history chroxy holds BEFORE it is lost — and archiving can never break the
 * teardown it rides on.
 *
 * Every SessionManager here has its own temp `stateFilePath`, so the archive
 * directory (derived from it) is a temp directory too.
 */

class ArchProvider extends EventEmitter {
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = null
  }
  static get capabilities() { return {} }
  start() {}
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}
class ShellLikeProvider extends ArchProvider {
  static get isUserShell() { return true }
}
/** start() rejects only when the test says so (see session-manager-survey-throttle-prune.test.js). */
class DeadStartProvider extends ArchProvider {
  start() { return new Promise((_resolve, reject) => { this._reject = reject }) }
  _failStart(err) { this._reject(err) }
}
declareUnknownCustomization(ArchProvider, ShellLikeProvider, DeadStartProvider)
registerProvider('test-archive-sm', ArchProvider)
registerProvider('test-archive-dead-start', DeadStartProvider)

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const tick = () => new Promise((r) => setImmediate(r))

describe('SessionManager + SessionArchive', () => {
  let sm
  let dir

  afterEach(() => {
    try { sm?.destroy?.() } catch { /* ignore */ }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
    sm = null
  })

  const archiveDir = () => join(dir, 'archive')

  function makeSm(opts = {}) {
    dir = dir || mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-'))
    sm = new SessionManager({
      skipPreflight: true,
      maxSessions: 10,
      stateFilePath: join(dir, 'state.json'),
      providerType: 'test-archive-sm',
      ...opts,
    })
    return sm
  }

  function liveSession(historyLabel = 'hello', { provider = 'test-archive-sm', n = 2 } = {}) {
    const id = sm.createSession({ cwd: '/tmp', provider })
    sm._history.setHistory(id, Array.from({ length: n }, (_, i) => ({ type: 'message', messageType: 'user_input', content: `${historyLabel}-${i}` })))
    return id
  }

  describe('destroySession', () => {
    it("archives with reason 'closed' and the history stays readable after the session is gone", async () => {
      makeSm()
      const id = liveSession('closed-me', { n: 3 })
      sm.renameSession(id, 'My Session')

      assert.equal(sm.destroySession(id), true)
      await sm.whenArchiveIdle()

      assert.equal(sm._sessions.has(id), false)
      const { sessions, policy } = sm.listArchivedSessions()
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].sessionId, id)
      assert.equal(sessions[0].reason, 'closed')
      assert.equal(sessions[0].name, 'My Session')
      assert.equal(sessions[0].cwd, '/tmp')
      assert.equal(sessions[0].provider, 'test-archive-sm')
      assert.equal(sessions[0].historyLength, 3)
      assert.equal(typeof sessions[0].createdAt, 'number', 'createdAt comes from the live entry')
      assert.deepEqual(policy, { enabled: true, maxEntries: 100, maxAgeDays: 30, maxMegabytes: 256 })

      const page = (await sm.getArchivedSessionHistory(sessions[0].archiveId))
      assert.equal(page.ok, true)
      assert.equal(page.total, 3)
      assert.deepEqual(page.entries.map((e) => e.content), ['closed-me-0', 'closed-me-1', 'closed-me-2'])
    })

    it('archives BEFORE the teardown drops the history, and before the state flush that removes the entry', async () => {
      const order = []
      const store = new SessionArchive({ dir: join(dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-')), 'archive') })
      const real = store.enqueue.bind(store)
      store.enqueue = (saved, reason) => {
        order.push(['archive', { live: sm._sessions.has(saved.id), historyKept: sm._history.getHistory(saved.id).length }])
        return real(saved, reason)
      }
      makeSm({ sessionArchiveStore: store })
      const id = liveSession('x', { n: 2 })
      const flush = sm._flushPersistOrWarn.bind(sm)
      sm._flushPersistOrWarn = (...args) => { order.push(['flush']); return flush(...args) }

      sm.destroySession(id)
      await sm.whenArchiveIdle()

      assert.deepEqual(order[0], ['archive', { live: true, historyKept: 2 }], 'snapshotted while the session and its history still existed')
      assert.equal(order.findIndex((o) => o[0] === 'flush') > 0, true, 'the flush that drops the entry comes after the snapshot')
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
    })

    it('destroySessionLocked passes the archive options through', async () => {
      makeSm()
      const id = liveSession('locked')
      await sm.destroySessionLocked(id, { archiveReason: 'environment_destroyed' })
      await sm.whenArchiveIdle()
      assert.equal(sm.listArchivedSessions().sessions[0].reason, 'environment_destroyed')

      const id2 = liveSession('locked2')
      await sm.destroySessionLocked(id2)
      await sm.whenArchiveIdle()
      assert.equal(sm.listArchivedSessions().sessions.find((s) => s.sessionId === id2).reason, 'closed')
    })

    it('does not archive with { archive: false }', async () => {
      makeSm()
      const id = liveSession('skip-me')
      sm.destroySession(id, { archive: false })
      await sm.whenArchiveIdle()
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
      assert.equal(existsSync(archiveDir()), false, 'nothing was written, not even the directory')
    })

    it('does not archive a user-shell session', async () => {
      makeSm()
      const id = liveSession('shell')
      // Swap the provider for a user-shell-class one; the gate is class-based.
      sm._sessions.get(id).session = new ShellLikeProvider({ cwd: '/tmp' })
      sm.destroySession(id)
      await sm.whenArchiveIdle()
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
      assert.equal(existsSync(archiveDir()), false)
    })

    it('does not archive a session with no history', async () => {
      makeSm()
      const id = sm.createSession({ cwd: '/tmp', provider: 'test-archive-sm' })
      sm.destroySession(id)
      await sm.whenArchiveIdle()
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })

    it('records an idle timeout as reason idle_timeout', async () => {
      makeSm()
      const id = liveSession('idle')
      sm._timeoutManager.emit('timeout', { sessionId: id, idleMs: 3_600_000 })
      await sm.whenArchiveIdle()
      assert.equal(sm._sessions.has(id), false)
      assert.equal(sm.listArchivedSessions().sessions[0].reason, 'idle_timeout')
    })

    it('records a respawn_exhausted teardown as reason respawn_exhausted', async () => {
      makeSm()
      const id = liveSession('respawn')
      sm._sessions.get(id).session.emit('respawn_exhausted', { reason: 'gave up' })
      await sm.whenArchiveIdle()
      assert.equal(sm._sessions.has(id), false)
      assert.equal(sm.listArchivedSessions().sessions[0].reason, 'respawn_exhausted')
    })

    it('does not archive a FRESH session whose start() rejected (full teardown, nothing worth keeping)', async () => {
      makeSm()
      const id = sm.createSession({ cwd: '/tmp', provider: 'test-archive-dead-start' })
      sm._history.setHistory(id, [{ type: 'message', messageType: 'user_input', content: 'would be archived by the default path' }])
      const failed = []
      sm.on('session_create_failed', (e) => failed.push(e))

      sm._sessions.get(id).session._failStart(new Error('pty spawn failed'))
      await tick()

      assert.equal(failed.length, 1, 'control: this really is the fresh-session start-failure path')
      assert.equal(sm._sessions.has(id), false)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })

    it('a throwing archive never breaks the teardown', async () => {
      makeSm({ sessionArchiveStore: { enqueue() { throw new Error('disk on fire') }, archiveOutcome() { throw new Error('disk on fire') }, retentionPolicy: () => ({}), list: () => [], prune() {} } })
      const id = liveSession('boom')
      assert.doesNotThrow(() => assert.equal(sm.destroySession(id), true))
      assert.equal(sm._sessions.has(id), false, 'the session is gone')
    })

    it('a throwing snapshot (serialization) never breaks the teardown either', async () => {
      makeSm()
      const id = liveSession('boom2')
      sm._serializeSessionEntry = () => { throw new Error('cannot serialize') }
      assert.doesNotThrow(() => assert.equal(sm.destroySession(id), true))
      await sm.whenArchiveIdle()
      assert.equal(sm._sessions.has(id), false)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })

    it('is a no-op for an unknown session id (nothing archived, returns false)', async () => {
      makeSm()
      assert.equal(sm.destroySession('nope'), false)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })
  })

  describe('restoreState: stale sessions the 24h filter drops', () => {
    function boot({ ageMs, extra = {}, history }) {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-stale-'))
      const statePath = join(dir, 'state.json')
      const lastActivityAt = Date.now() - ageMs
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        timestamp: lastActivityAt,
        sessions: [{
          id: 'a'.repeat(32), name: 'Stale One', cwd: '/tmp', provider: 'codex',
          lastActivityAt,
          history: history ?? [{ type: 'message', messageType: 'user_input', content: 'hours of work' }, { type: 'response', content: 'done' }],
          ...extra,
        }],
      }))
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true })
      sm.restoreState()
      return statePath
    }

    it("archives a stale session that would have restored fine, reason 'stale', and it stays readable", async () => {
      boot({ ageMs: 25 * HOUR })
      assert.equal(sm.getFailedRestores().length, 0, 'control: not parked, just dropped')
      const { sessions } = sm.listArchivedSessions()
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].reason, 'stale')
      assert.equal(sessions[0].sessionId, 'a'.repeat(32))
      assert.equal(sessions[0].provider, 'codex')
      assert.equal(sessions[0].historyLength, 2)
      assert.equal((await sm.getArchivedSessionHistory(sessions[0].archiveId)).entries[0].content, 'hours of work')
    })

    it("archives an entry past the failed-restore TTL that restoreState drops, reason 'stale'", async () => {
      boot({ ageMs: 40 * DAY })
      assert.equal(sm.getFailedRestores().length, 0)
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
      assert.equal(sm.listArchivedSessions().sessions[0].reason, 'stale')
    })

    it('a second boot over the same stale entry does not archive it twice (dedupe)', async () => {
      const statePath = boot({ ageMs: 25 * HOUR })
      const first = sm.listArchivedSessions().sessions
      assert.equal(first.length, 1)
      const stateBody = JSON.stringify({
        version: 1,
        timestamp: Date.now(),
        sessions: [{ id: 'a'.repeat(32), name: 'Stale One', cwd: '/tmp', provider: 'codex', lastActivityAt: first[0].lastActivityAt, history: [{ type: 'message', content: 'hours of work' }, { type: 'response', content: 'done' }] }],
      })
      // Simulate the crash window: the entry was archived but the state flush that
      // would have dropped it never landed, so the next boot sees it again.
      sm.destroy?.()
      writeFileSync(statePath, stateBody)
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true })
      sm.restoreState()
      assert.equal(sm.listArchivedSessions().sessions.length, 1, 'still exactly one record')
    })

    it('an all-stale boot writes the drop, so a deleted archive copy does not come back next boot', async () => {
      const statePath = boot({ ageMs: 25 * HOUR })
      const [row] = sm.listArchivedSessions().sessions
      assert.ok(row, 'archived on the first boot')
      const onDisk = JSON.parse(readFileSync(statePath, 'utf8'))
      assert.deepEqual(onDisk.sessions, [], 'the stale entry left the state file at boot')
      assert.equal(sm.deleteArchivedSession(row.archiveId), 'deleted')
      sm.destroy?.()
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true })
      sm.restoreState()
      assert.deepEqual(sm.listArchivedSessions().sessions, [], 'the deleted copy was not re-archived')
    })

    it('with archiving off, an all-stale boot leaves the state file as it was (no early write)', async () => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-off-stale-'))
      const statePath = join(dir, 'state.json')
      const lastActivityAt = Date.now() - 25 * HOUR
      const body = JSON.stringify({
        version: 1,
        timestamp: lastActivityAt,
        sessions: [{ id: 'c'.repeat(32), name: 'Off', cwd: '/tmp', lastActivityAt, history: [{ type: 'message', content: 'x' }] }],
      })
      writeFileSync(statePath, body)
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true, sessionArchive: { enabled: false } })
      sm.restoreState()
      assert.equal(readFileSync(statePath, 'utf8'), body)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })

    it('does NOT archive a session that is still live-fresh (restored, not dropped)', async () => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-fresh-'))
      const statePath = join(dir, 'state.json')
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        timestamp: Date.now(),
        sessions: [{ id: 'b'.repeat(32), name: 'Fresh', cwd: '/tmp', lastActivityAt: Date.now() - HOUR, history: [{ type: 'message', content: 'x' }] }],
      }))
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true, providerType: 'test-archive-sm' })
      sm.restoreState()
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })

    it('ages out expired archive records at boot even when archiving is off', async () => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-age-'))
      const statePath = join(dir, 'state.json')
      let t = 1_000_000
      const writer = new SessionArchive({ dir: join(dir, 'archive'), maxAgeDays: 1, now: () => t })
      const meta = writer.archive({ id: 's1', name: 'old', history: [{ type: 'message', content: 'x' }], lastActivityAt: 1 })
      assert.ok(existsSync(join(dir, 'archive', `${meta.archiveId}.json.gz`)))

      // A daemon booted later, with the archive switched off, and a real clock far past maxAgeDays.
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true, sessionArchive: { enabled: false, maxAgeDays: 1 } })
      sm.restoreState()
      assert.deepEqual(readdirSync(join(dir, 'archive')).filter((f) => f.endsWith('.json.gz')), [], 'the record was unlinked by the boot prune')
    })
  })

  describe('failed restores', () => {
    function park(id = 'f'.repeat(32), saved = {}) {
      const s = { id, name: 'Parked', cwd: '/tmp', provider: 'codex', history: [{ type: 'message', content: 'parked work' }], ...saved }
      const err = new Error('native locator missing')
      err.code = 'CODEX_NATIVE_LOCATOR_MISSING'
      sm._failedRestores.set(id, { saved: s, error: err })
      return s
    }

    it("archives an entry the 30-day TTL prunes, reason 'failed_restore_expired'", async () => {
      makeSm()
      const now = Date.now()
      park('1'.repeat(32), { lastActivityAt: now - 40 * DAY })
      park('2'.repeat(32), { lastActivityAt: now - 5 * DAY })

      assert.equal(sm._pruneStaleFailedRestores(now), 1)

      const { sessions } = sm.listArchivedSessions()
      assert.deepEqual(sessions.map((s) => [s.sessionId, s.reason]), [['1'.repeat(32), 'failed_restore_expired']])
      assert.equal((await sm.getArchivedSessionHistory(sessions[0].archiveId)).entries[0].content, 'parked work')
    })

    it('does not archive a worktree-backed entry the prune keeps', async () => {
      makeSm()
      const now = Date.now()
      park('3'.repeat(32), { lastActivityAt: now - 90 * DAY, worktreePath: '/some/wt' })
      assert.equal(sm._pruneStaleFailedRestores(now), 0)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })

    it("archives a dismissed entry, reason 'failed_restore_dismissed'", async () => {
      makeSm()
      const id = '4'.repeat(32)
      park(id)
      assert.equal(sm.clearFailedRestore(id), true)
      assert.equal(sm._failedRestores.has(id), false)
      const { sessions } = sm.listArchivedSessions()
      assert.deepEqual(sessions.map((s) => [s.sessionId, s.reason]), [[id, 'failed_restore_dismissed']])
      assert.equal(sm.clearFailedRestore(id), false, 'a second dismiss is a no-op')
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
    })

    it('getFailedRestoreHistory still serves the parked entry (shared pager, unchanged contract)', async () => {
      makeSm()
      const id = '5'.repeat(32)
      park(id)
      const r = sm.getFailedRestoreHistory(id)
      assert.equal(r.ok, true)
      assert.equal(r.total, 1)
      assert.equal(r.entries[0].content, 'parked work')
      assert.equal(sm.getFailedRestoreHistory('nope').code, 'FAILED_RESTORE_NOT_FOUND')
    })
  })

  describe('configuration and the public API', () => {
    it('honours the sessionArchive config block and derives the directory from the state file', async () => {
      makeSm({ sessionArchive: { enabled: true, maxEntries: 7, maxAgeDays: 3, maxMegabytes: 5, dir: '/should/be/ignored' } })
      assert.deepEqual(sm.listArchivedSessions().policy, { enabled: true, maxEntries: 7, maxAgeDays: 3, maxMegabytes: 5 })
      const id = liveSession('cfg')
      sm.destroySession(id)
      await sm.whenArchiveIdle()
      assert.ok(existsSync(archiveDir()), 'the archive lives next to the state file, not at a config-supplied dir')
      assert.equal(readdirSync(archiveDir()).filter((f) => f.endsWith('.json.gz')).length, 1)
    })

    it('sessionArchive.enabled:false writes nothing', async () => {
      makeSm({ sessionArchive: { enabled: false } })
      const id = liveSession('off')
      sm.destroySession(id)
      await sm.whenArchiveIdle()
      assert.equal(sm.listArchivedSessions().policy.enabled, false)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
      assert.equal(existsSync(archiveDir()), false)
    })

    it('delete and deleteAll remove records; an unknown id removes nothing', async () => {
      makeSm()
      const a = liveSession('a')
      sm.destroySession(a)
      const b = liveSession('b')
      sm.destroySession(b)
      await sm.whenArchiveIdle()
      const rows = sm.listArchivedSessions().sessions
      assert.equal(rows.length, 2)

      assert.equal(sm.deleteArchivedSession('../../etc/passwd'), 'not_found')
      assert.equal(sm.deleteArchivedSession(rows[0].archiveId), 'deleted')
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
      assert.equal((await sm.getArchivedSessionHistory(rows[0].archiveId)).ok, false)
      assert.deepEqual(sm.deleteAllArchivedSessions(), { deleted: 1, failed: 0 })
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
      assert.deepEqual(readdirSync(archiveDir()).filter((f) => f.endsWith('.json.gz')), [])
    })
  })

  // -- the archive must not discard a source it failed to copy -----------------

  describe('an UNWRITABLE archive keeps the source (item: archive failure is a distinct outcome)', () => {
    /** The archive directory path is a FILE, so every write fails and nothing is ever created. */
    function breakArchive() {
      writeFileSync(archiveDir(), 'a file where the archive directory should be')
    }
    const repairArchive = () => rmSync(archiveDir(), { force: true })
    const park = (id, saved = {}) => {
      const s = { id, name: 'Parked', cwd: '/tmp', provider: 'codex', history: [{ type: 'message', content: 'only copy' }], ...saved }
      const err = new Error('native locator missing')
      err.code = 'CODEX_NATIVE_LOCATOR_MISSING'
      sm._failedRestores.set(id, { saved: s, error: err })
      return s
    }

    it('_pruneStaleFailedRestores keeps an expired parked entry whose archive failed, then drops it once the archive works', () => {
      makeSm()
      breakArchive()
      const now = Date.now()
      const id = '1'.repeat(32)
      park(id, { lastActivityAt: now - 40 * DAY })

      assert.equal(sm._pruneStaleFailedRestores(now), 0, 'nothing pruned: the only copy could not be preserved')
      assert.equal(sm._failedRestores.has(id), true)
      assert.equal(sm.getFailedRestoreHistory(id).entries[0].content, 'only copy', 'still readable')

      repairArchive()
      assert.equal(sm._pruneStaleFailedRestores(now), 1, 'retried (as on the next boot) and now archived + dropped')
      assert.equal(sm._failedRestores.has(id), false)
      assert.deepEqual(sm.listArchivedSessions().sessions.map((r) => r.reason), ['failed_restore_expired'])
    })

    it('clearFailedRestore returns false and keeps the entry when the archive failed', () => {
      makeSm()
      breakArchive()
      const id = '2'.repeat(32)
      park(id)

      assert.equal(sm.clearFailedRestore(id), false)
      assert.equal(sm._failedRestores.has(id), true)

      repairArchive()
      assert.equal(sm.clearFailedRestore(id), true)
      assert.equal(sm._failedRestores.has(id), false)
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
    })

    it('a store that THROWS (not just reports failed) also keeps the source', () => {
      makeSm({ sessionArchiveStore: { archiveOutcome() { throw new Error('boom') }, retentionPolicy: () => ({}), list: () => [], prune() {} } })
      const id = '6'.repeat(32)
      park(id, { lastActivityAt: Date.now() - 40 * DAY })
      assert.equal(sm._pruneStaleFailedRestores(Date.now()), 0)
      assert.equal(sm.clearFailedRestore(id), false)
      assert.equal(sm._failedRestores.has(id), true)
    })

    it('clearFailedRestore still dismisses when archiving is merely OFF (skipped is not failed)', () => {
      makeSm({ sessionArchive: { enabled: false } })
      const id = '3'.repeat(32)
      park(id)
      assert.equal(sm.clearFailedRestore(id), true)
    })

    function staleBoot({ ageMs, brokenArchive }) {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-fail-'))
      const statePath = join(dir, 'state.json')
      const lastActivityAt = Date.now() - ageMs
      const body = JSON.stringify({
        version: 1,
        timestamp: lastActivityAt,
        sessions: [{ id: 'd'.repeat(32), name: 'Stale', cwd: '/tmp', provider: 'codex', lastActivityAt, history: [{ type: 'message', content: 'only copy' }] }],
      })
      writeFileSync(statePath, body)
      if (brokenArchive) breakArchive()
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true })
      sm.restoreState()
      return { statePath, body }
    }

    for (const [label, ageMs] of [['a stale (25h) entry', 25 * HOUR], ['an entry past the failed-restore TTL', 40 * DAY]]) {
      it(`the all-stale-boot flush does NOT run when the archive of ${label} failed (the drop waits for the next write)`, () => {
        const { statePath, body } = staleBoot({ ageMs, brokenArchive: true })
        assert.equal(readFileSync(statePath, 'utf8'), body, 'the state file still carries the only copy')
        assert.equal(sm.listArchivedSessions().sessions.length, 0)
      })

      it(`control: with a working archive the same boot of ${label} archives and flushes the drop`, () => {
        const { statePath } = staleBoot({ ageMs, brokenArchive: false })
        assert.equal(sm.listArchivedSessions().sessions.length, 1)
        assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).sessions, [])
      })
    }

    it('a USER CLOSE still tears the session down (as on main) when the archive fails', async () => {
      makeSm()
      breakArchive()
      const id = liveSession('closing')
      assert.equal(sm.destroySession(id), true)
      await sm.whenArchiveIdle()
      assert.equal(sm._sessions.has(id), false)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })
  })

  describe('a state backup cannot resurrect a deleted archive (tombstones)', () => {
    it('archive stale -> flush -> delete the archive -> corrupt the state so .bak is recovered -> NOT re-archived', async () => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-bak-'))
      const statePath = join(dir, 'state.json')
      const lastActivityAt = Date.now() - 25 * HOUR
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        timestamp: lastActivityAt,
        sessions: [{ id: 'e'.repeat(32), name: 'Stale', cwd: '/tmp', provider: 'codex', lastActivityAt, history: [{ type: 'message', content: 'hours of work' }] }],
      }))
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true })
      sm.restoreState()
      const [row] = sm.listArchivedSessions().sessions
      assert.ok(row, 'archived at the first boot')
      assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).sessions, [], 'flushed')
      assert.ok(existsSync(`${statePath}.bak`), 'control: the previous generation, stale entry included, is in .bak')
      assert.equal(sm.deleteArchivedSession(row.archiveId), 'deleted')

      writeFileSync(statePath, '{ corrupt')
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true })
      sm.restoreState()
      assert.deepEqual(sm.listArchivedSessions().sessions, [], 'the recovered stale entry was recognised, not archived again')
    })

    it('a record that AGED OUT is not resurrected by the same route', () => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-bak2-'))
      const statePath = join(dir, 'state.json')
      let t = Date.now()
      const lastActivityAt = t - 25 * HOUR
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        timestamp: lastActivityAt,
        sessions: [{ id: 'f'.repeat(32), name: 'Stale', cwd: '/tmp', lastActivityAt, history: [{ type: 'message', content: 'x' }] }],
      }))
      const store = () => new SessionArchive({ dir: join(dir, 'archive'), maxAgeDays: 1, now: () => t })
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true, sessionArchiveStore: store() })
      sm.restoreState()
      assert.equal(sm.listArchivedSessions().sessions.length, 1)

      t += 2 * DAY // the record ages out
      writeFileSync(statePath, '{ corrupt')
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true, sessionArchiveStore: store() })
      sm.restoreState()
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })
  })

  describe('retention while idle, and shutdown', () => {
    it('a background sweep ages records out with no request and no restart', async () => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-sweep-'))
      let t = 1_000_000
      const store = new SessionArchive({ dir: join(dir, 'archive'), maxAgeDays: 1, now: () => t })
      const meta = store.archive({ id: 's1', name: 'old', history: [{ type: 'message', content: 'x' }], lastActivityAt: 1 })
      const file = join(dir, 'archive', `${meta.archiveId}.json.gz`)
      makeSm({ sessionArchiveStore: store, sessionArchivePruneIntervalMs: 10 })
      assert.ok(existsSync(file))

      t += 2 * DAY
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(existsSync(file), false, 'the sweep unlinked the expired record without any call into the archive')
    })

    it('the sweep timer is unref\'d, can be disabled, and is cleared by destroyAll', () => {
      makeSm({ sessionArchivePruneIntervalMs: 10 })
      assert.ok(sm._archivePruneTimer, 'armed')
      assert.equal(sm._archivePruneTimer.hasRef(), false, 'never keeps the process alive')
      sm.destroyAll()
      assert.equal(sm._archivePruneTimer, null)

      const off = new SessionManager({ stateFilePath: join(dir, 'other.json'), skipPreflight: true, sessionArchivePruneIntervalMs: 0 })
      assert.equal(off._archivePruneTimer, null)
      const def = new SessionManager({ stateFilePath: join(dir, 'other2.json'), skipPreflight: true })
      assert.ok(def._archivePruneTimer, 'on by default')
      def.destroyAll()
    })

    it('destroyAll drains a just-closed session that is still queued, synchronously', () => {
      makeSm()
      const id = liveSession('last-words')
      sm.destroySession(id)
      assert.equal(existsSync(archiveDir()), false, 'control: still only queued')
      sm.destroyAll()
      assert.equal(readdirSync(archiveDir()).filter((f) => f.endsWith('.json.gz')).length, 1, 'written before destroyAll returned')
    })
  })

  describe('delete failures through the manager (POSIX, not root)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    it('reports failed and keeps the record', async () => {
      makeSm()
      const id = liveSession('stuck')
      sm.destroySession(id)
      await sm.whenArchiveIdle()
      const [row] = sm.listArchivedSessions().sessions
      chmodSync(archiveDir(), 0o500)
      try {
        assert.equal(sm.deleteArchivedSession(row.archiveId), 'failed')
        assert.deepEqual(sm.deleteAllArchivedSessions(), { deleted: 0, failed: 1 })
        assert.equal(sm.listArchivedSessions().sessions.length, 1)
      } finally {
        chmodSync(archiveDir(), 0o700)
      }
    })
  })
})
