import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
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
    it("archives with reason 'closed' and the history stays readable after the session is gone", () => {
      makeSm()
      const id = liveSession('closed-me', { n: 3 })
      sm.renameSession(id, 'My Session')

      assert.equal(sm.destroySession(id), true)

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

      const page = sm.getArchivedSessionHistory(sessions[0].archiveId)
      assert.equal(page.ok, true)
      assert.equal(page.total, 3)
      assert.deepEqual(page.entries.map((e) => e.content), ['closed-me-0', 'closed-me-1', 'closed-me-2'])
    })

    it('archives BEFORE the teardown drops the history, and before the state flush that removes the entry', () => {
      const order = []
      const store = new SessionArchive({ dir: join(dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-archive-')), 'archive') })
      const real = store.archive.bind(store)
      store.archive = (saved, reason) => {
        order.push(['archive', { live: sm._sessions.has(saved.id), historyKept: sm._history.getHistory(saved.id).length }])
        return real(saved, reason)
      }
      makeSm({ sessionArchiveStore: store })
      const id = liveSession('x', { n: 2 })
      const flush = sm._flushPersistOrWarn.bind(sm)
      sm._flushPersistOrWarn = (...args) => { order.push(['flush']); return flush(...args) }

      sm.destroySession(id)

      assert.deepEqual(order[0], ['archive', { live: true, historyKept: 2 }], 'snapshotted while the session and its history still existed')
      assert.equal(order.findIndex((o) => o[0] === 'flush') > 0, true, 'the flush that drops the entry comes after the archive write')
    })

    it('destroySessionLocked passes the archive options through', async () => {
      makeSm()
      const id = liveSession('locked')
      await sm.destroySessionLocked(id, { archiveReason: 'environment_destroyed' })
      assert.equal(sm.listArchivedSessions().sessions[0].reason, 'environment_destroyed')

      const id2 = liveSession('locked2')
      await sm.destroySessionLocked(id2)
      assert.equal(sm.listArchivedSessions().sessions.find((s) => s.sessionId === id2).reason, 'closed')
    })

    it('does not archive with { archive: false }', () => {
      makeSm()
      const id = liveSession('skip-me')
      sm.destroySession(id, { archive: false })
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
      assert.equal(existsSync(archiveDir()), false, 'nothing was written, not even the directory')
    })

    it('does not archive a user-shell session', () => {
      makeSm()
      const id = liveSession('shell')
      // Swap the provider for a user-shell-class one; the gate is class-based.
      sm._sessions.get(id).session = new ShellLikeProvider({ cwd: '/tmp' })
      sm.destroySession(id)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
      assert.equal(existsSync(archiveDir()), false)
    })

    it('does not archive a session with no history', () => {
      makeSm()
      const id = sm.createSession({ cwd: '/tmp', provider: 'test-archive-sm' })
      sm.destroySession(id)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })

    it('records an idle timeout as reason idle_timeout', () => {
      makeSm()
      const id = liveSession('idle')
      sm._timeoutManager.emit('timeout', { sessionId: id, idleMs: 3_600_000 })
      assert.equal(sm._sessions.has(id), false)
      assert.equal(sm.listArchivedSessions().sessions[0].reason, 'idle_timeout')
    })

    it('records a respawn_exhausted teardown as reason respawn_exhausted', () => {
      makeSm()
      const id = liveSession('respawn')
      sm._sessions.get(id).session.emit('respawn_exhausted', { reason: 'gave up' })
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

    it('a throwing archive never breaks the teardown', () => {
      makeSm({ sessionArchiveStore: { archive() { throw new Error('disk on fire') }, retentionPolicy: () => ({}), list: () => [], prune() {} } })
      const id = liveSession('boom')
      assert.doesNotThrow(() => assert.equal(sm.destroySession(id), true))
      assert.equal(sm._sessions.has(id), false, 'the session is gone')
    })

    it('a throwing snapshot (serialization) never breaks the teardown either', () => {
      makeSm()
      const id = liveSession('boom2')
      sm._serializeSessionEntry = () => { throw new Error('cannot serialize') }
      assert.doesNotThrow(() => assert.equal(sm.destroySession(id), true))
      assert.equal(sm._sessions.has(id), false)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })

    it('is a no-op for an unknown session id (nothing archived, returns false)', () => {
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

    it("archives a stale session that would have restored fine, reason 'stale', and it stays readable", () => {
      boot({ ageMs: 25 * HOUR })
      assert.equal(sm.getFailedRestores().length, 0, 'control: not parked, just dropped')
      const { sessions } = sm.listArchivedSessions()
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].reason, 'stale')
      assert.equal(sessions[0].sessionId, 'a'.repeat(32))
      assert.equal(sessions[0].provider, 'codex')
      assert.equal(sessions[0].historyLength, 2)
      assert.equal(sm.getArchivedSessionHistory(sessions[0].archiveId).entries[0].content, 'hours of work')
    })

    it("archives an entry past the failed-restore TTL that restoreState drops, reason 'stale'", () => {
      boot({ ageMs: 40 * DAY })
      assert.equal(sm.getFailedRestores().length, 0)
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
      assert.equal(sm.listArchivedSessions().sessions[0].reason, 'stale')
    })

    it('a second boot over the same stale entry does not archive it twice (dedupe)', () => {
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

    it('an all-stale boot writes the drop, so a deleted archive copy does not come back next boot', () => {
      const statePath = boot({ ageMs: 25 * HOUR })
      const [row] = sm.listArchivedSessions().sessions
      assert.ok(row, 'archived on the first boot')
      const onDisk = JSON.parse(readFileSync(statePath, 'utf8'))
      assert.deepEqual(onDisk.sessions, [], 'the stale entry left the state file at boot')
      assert.equal(sm.deleteArchivedSession(row.archiveId), true)
      sm.destroy?.()
      sm = new SessionManager({ stateFilePath: statePath, skipPreflight: true })
      sm.restoreState()
      assert.deepEqual(sm.listArchivedSessions().sessions, [], 'the deleted copy was not re-archived')
    })

    it('with archiving off, an all-stale boot leaves the state file as it was (no early write)', () => {
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

    it('does NOT archive a session that is still live-fresh (restored, not dropped)', () => {
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

    it('ages out expired archive records at boot even when archiving is off', () => {
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

    it("archives an entry the 30-day TTL prunes, reason 'failed_restore_expired'", () => {
      makeSm()
      const now = Date.now()
      park('1'.repeat(32), { lastActivityAt: now - 40 * DAY })
      park('2'.repeat(32), { lastActivityAt: now - 5 * DAY })

      assert.equal(sm._pruneStaleFailedRestores(now), 1)

      const { sessions } = sm.listArchivedSessions()
      assert.deepEqual(sessions.map((s) => [s.sessionId, s.reason]), [['1'.repeat(32), 'failed_restore_expired']])
      assert.equal(sm.getArchivedSessionHistory(sessions[0].archiveId).entries[0].content, 'parked work')
    })

    it('does not archive a worktree-backed entry the prune keeps', () => {
      makeSm()
      const now = Date.now()
      park('3'.repeat(32), { lastActivityAt: now - 90 * DAY, worktreePath: '/some/wt' })
      assert.equal(sm._pruneStaleFailedRestores(now), 0)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
    })

    it("archives a dismissed entry, reason 'failed_restore_dismissed'", () => {
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

    it('getFailedRestoreHistory still serves the parked entry (shared pager, unchanged contract)', () => {
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
    it('honours the sessionArchive config block and derives the directory from the state file', () => {
      makeSm({ sessionArchive: { enabled: true, maxEntries: 7, maxAgeDays: 3, maxMegabytes: 5, dir: '/should/be/ignored' } })
      assert.deepEqual(sm.listArchivedSessions().policy, { enabled: true, maxEntries: 7, maxAgeDays: 3, maxMegabytes: 5 })
      const id = liveSession('cfg')
      sm.destroySession(id)
      assert.ok(existsSync(archiveDir()), 'the archive lives next to the state file, not at a config-supplied dir')
      assert.equal(readdirSync(archiveDir()).filter((f) => f.endsWith('.json.gz')).length, 1)
    })

    it('sessionArchive.enabled:false writes nothing', () => {
      makeSm({ sessionArchive: { enabled: false } })
      const id = liveSession('off')
      sm.destroySession(id)
      assert.equal(sm.listArchivedSessions().policy.enabled, false)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
      assert.equal(existsSync(archiveDir()), false)
    })

    it('delete and deleteAll remove records; an unknown id removes nothing', () => {
      makeSm()
      const a = liveSession('a')
      sm.destroySession(a)
      const b = liveSession('b')
      sm.destroySession(b)
      const rows = sm.listArchivedSessions().sessions
      assert.equal(rows.length, 2)

      assert.equal(sm.deleteArchivedSession('../../etc/passwd'), false)
      assert.equal(sm.deleteArchivedSession(rows[0].archiveId), true)
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
      assert.equal(sm.getArchivedSessionHistory(rows[0].archiveId).ok, false)
      assert.equal(sm.deleteAllArchivedSessions(), 1)
      assert.deepEqual(sm.listArchivedSessions().sessions, [])
      assert.deepEqual(readdirSync(archiveDir()).filter((f) => f.endsWith('.json.gz')), [])
    })
  })
})
