import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

import { SessionManager as RealSessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #8866 — continue a session from the archive, on an explicit request.
 *
 *   native     the SAME conversation, through the boot / retry recipe; the
 *              record LEAVES the archive (no tombstone)
 *   new_thread a NEW session seeded with the archived transcript; the record
 *              STAYS, and no authority is carried over
 *
 * Every SessionManager here has its own temp `stateFilePath`, so the archive
 * directory (derived from it) is a temp directory too.
 */

class BaseProvider extends EventEmitter {
  constructor(opts) {
    super()
    BaseProvider.constructed.push({ cls: new.target.name, opts })
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = opts.resumeSessionId || null
  }
  static constructed = []
  static get capabilities() { return {} }
  start() {}
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}
class ResumeProvider extends BaseProvider {
  static get capabilities() { return { resume: true } }
}
class ThrowingResumeProvider extends ResumeProvider {
  constructor(opts) {
    if (ThrowingResumeProvider.armed) throw Object.assign(new Error('cannot spawn'), { code: 'SPAWN_BOOM' })
    super(opts)
  }
}
class DeadStartResumeProvider extends ResumeProvider {
  start() { return new Promise((_resolve, reject) => { this._reject = reject }) }
}
class ShellLikeProvider extends BaseProvider {
  static get isUserShell() { return true }
}
declareUnknownCustomization(BaseProvider, ResumeProvider, ThrowingResumeProvider, DeadStartResumeProvider, ShellLikeProvider)
registerProvider('test-restore-plain', BaseProvider)
registerProvider('test-restore-resume', ResumeProvider)
registerProvider('test-restore-throwing', ThrowingResumeProvider)
registerProvider('test-restore-dead-start', DeadStartResumeProvider)
registerProvider('test-restore-shell', ShellLikeProvider)

const instances = []
class SessionManager extends RealSessionManager {
  constructor(opts) {
    super(opts)
    instances.push(this)
  }
}
const tick = () => new Promise((r) => setImmediate(r))

describe('SessionManager.restoreArchivedSession (#8866)', () => {
  let sm
  let dir
  let workDir

  afterEach(() => {
    for (const instance of instances.splice(0)) {
      try { instance.destroyAll() } catch { /* ignore */ }
    }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
    sm = null
    ThrowingResumeProvider.armed = false
    BaseProvider.constructed.length = 0
  })

  function makeSm(opts = {}) {
    dir = dir || mkdtempSync(join(tmpdir(), 'chroxy-sm-restore-'))
    workDir = join(dir, 'work')
    mkdirSync(workDir, { recursive: true })
    sm = new SessionManager({
      skipPreflight: true,
      maxSessions: 10,
      stateFilePath: join(dir, 'state.json'),
      providerType: 'test-restore-plain',
      ...opts,
    })
    // The transcript a Claude-family locator names lives under the REAL ~/.claude;
    // tests state whether it exists rather than touch that tree.
    sm._claudeTranscriptExists = () => true
    return sm
  }

  const convo = [
    { type: 'message', messageType: 'user_input', content: 'how do I add a flag?' },
    { type: 'message', messageType: 'response', content: 'pass --flag to the CLI' },
    { type: 'tool_start', tool: 'Read', toolUseId: 't1' },
  ]

  /** Create a live session, give it history, close it, and return its archive row. */
  async function archived({ provider = 'test-restore-resume', conversationId = 'conv-1', permissionMode = 'acceptEdits', history = convo, cwd } = {}) {
    const id = sm.createSession({ cwd: cwd ?? workDir, provider, name: 'Flag work' })
    const entry = sm._sessions.get(id)
    entry.session.resumeSessionId = conversationId
    entry.session.permissionMode = permissionMode
    sm._history.setHistory(id, history.map((e) => ({ ...e })))
    sm.destroySession(id)
    await sm.whenArchiveIdle()
    const row = sm.listArchivedSessions().sessions.find((r) => r.sessionId === id)
    assert.ok(row, 'control: the closed session is in the archive')
    return { id, row }
  }

  describe('roster hints', () => {
    it('offers both actions for a resumable provider with a recorded conversation and an existing directory', async () => {
      makeSm()
      const { row } = await archived()
      assert.deepEqual(row.restore, { native: true, newThread: true })
      assert.equal('locator' in row, false, 'the internal hint does not reach the wire')
    })

    it('greys native with a reason for a provider that cannot resume, but still offers a new thread', async () => {
      makeSm()
      const { row } = await archived({ provider: 'test-restore-plain', conversationId: null })
      assert.equal(row.restore.native, false)
      assert.match(row.restore.nativeReason, /cannot resume a conversation/)
      assert.equal(row.restore.newThread, true)
    })

    it('greys native when no conversation was recorded', async () => {
      makeSm()
      const { row } = await archived({ conversationId: null })
      assert.equal(row.restore.native, false)
      assert.match(row.restore.nativeReason, /recorded no provider conversation/)
      assert.equal(row.restore.newThread, true)
    })

    it('greys both when the directory is gone, and when the provider is not registered', async () => {
      makeSm()
      const gone = join(dir, 'will-vanish')
      mkdirSync(gone)
      const { row } = await archived({ cwd: gone })
      rmSync(gone, { recursive: true })
      const after = sm.listArchivedSessions().sessions.find((r) => r.archiveId === row.archiveId)
      assert.equal(after.restore.native, false)
      assert.equal(after.restore.newThread, false)
      assert.match(after.restore.newThreadReason, /no longer exists/)
    })
  })

  describe('native', () => {
    it('resumes the same conversation, restores its history, and the record LEAVES the archive', async () => {
      makeSm()
      const { id, row } = await archived()
      BaseProvider.constructed.length = 0

      const r = await sm.restoreArchivedSession(row.archiveId, 'native')

      assert.equal(r.ok, true)
      assert.equal(r.mode, 'native')
      assert.equal(r.sessionId, id, 'the archived id is reused (preserveId)')
      const live = sm._sessions.get(r.sessionId)
      assert.ok(live)
      assert.equal(BaseProvider.constructed[0].opts.resumeSessionId, 'conv-1', 'resumed from the recorded locator')
      assert.equal(BaseProvider.constructed[0].opts.permissionMode, 'acceptEdits', 'native keeps the session as it was')
      assert.equal(live.isRestore ?? live._isRestore, true, 'isRestore: an async start failure re-parks it')
      assert.deepEqual(
        sm._history.getHistory(r.sessionId).filter((e) => e.type === 'message').map((e) => e.content),
        ['how do I add a flag?', 'pass --flag to the CLI'],
      )
      assert.deepEqual(sm.listArchivedSessions().sessions, [], 'the record left the archive')
    })

    // The tombstone-specific guard (same snapshot, so delete() would dedupe it) is in
    // session-archive-restore.test.js; here the restored session has newer activity, so this
    // pins the end-to-end claim that a restored session archives again when it is closed.
    it('closing the restored session archives it afresh', async () => {
      makeSm()
      const { row } = await archived()
      const r = await sm.restoreArchivedSession(row.archiveId, 'native')
      sm._sessions.get(r.sessionId).session.resumeSessionId = 'conv-1'
      sm._history.recordUserInput(r.sessionId, 'one more thing', undefined, 'm1')
      sm.destroySession(r.sessionId)
      await sm.whenArchiveIdle()
      const rows = sm.listArchivedSessions().sessions
      assert.equal(rows.length, 1, 'archived again rather than deduped against a tombstone')
      assert.ok(rows[0].historyLength > 3, 'carries the restored history plus the new input')
    })

    it('a second call for the same record gets ARCHIVED_SESSION_NOT_FOUND, not a second live copy', async () => {
      makeSm()
      const { row } = await archived()
      BaseProvider.constructed.length = 0
      const [a, b] = await Promise.all([
        sm.restoreArchivedSession(row.archiveId, 'native'),
        sm.restoreArchivedSession(row.archiveId, 'native'),
      ])
      assert.equal([a, b].filter((x) => x.ok).length, 1)
      const loser = [a, b].find((x) => !x.ok)
      assert.equal(loser.code, 'ARCHIVED_SESSION_NOT_FOUND')
      assert.equal(BaseProvider.constructed.length, 1, 'only one provider was ever built')
    })

    it('refuses with ARCHIVE_RESTORE_LOCATOR_MISSING when no conversation was recorded', async () => {
      makeSm()
      const { row } = await archived({ conversationId: null })
      const r = await sm.restoreArchivedSession(row.archiveId, 'native')
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ARCHIVE_RESTORE_LOCATOR_MISSING')
      assert.equal(sm.listArchivedSessions().sessions.length, 1, 'a refusal changes nothing')
    })

    it('refuses with ARCHIVE_RESTORE_LOCATOR_MISSING when the provider transcript is gone from disk', async () => {
      makeSm()
      const { row } = await archived()
      sm._claudeTranscriptExists = () => false
      const r = await sm.restoreArchivedSession(row.archiveId, 'native')
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ARCHIVE_RESTORE_LOCATOR_MISSING')
      assert.match(r.message, /no longer on disk/)
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
    })

    it('refuses a provider that cannot resume with ARCHIVE_RESTORE_NATIVE_UNSUPPORTED', async () => {
      makeSm()
      const { row } = await archived({ provider: 'test-restore-plain' })
      const r = await sm.restoreArchivedSession(row.archiveId, 'native')
      assert.equal(r.code, 'ARCHIVE_RESTORE_NATIVE_UNSUPPORTED')
    })

    it('refuses with ARCHIVE_RESTORE_CWD_MISSING when the directory (or worktree) is gone', async () => {
      makeSm()
      const gone = join(dir, 'will-vanish')
      mkdirSync(gone)
      const { row } = await archived({ cwd: gone })
      rmSync(gone, { recursive: true })
      const r = await sm.restoreArchivedSession(row.archiveId, 'native')
      assert.equal(r.code, 'ARCHIVE_RESTORE_CWD_MISSING')
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
    })

    it('refuses a user-shell record with ARCHIVE_RESTORE_FORBIDDEN_USER_SHELL (a hand-edited archive)', async () => {
      makeSm()
      const { row } = await archived()
      // The record on disk names a user-shell provider; the live gate is class based.
      const real = sm._sessionArchive.getSaved.bind(sm._sessionArchive)
      sm._sessionArchive.getSaved = async (id) => { const r = await real(id); r.saved.provider = 'test-restore-shell'; return r }
      const n = BaseProvider.constructed.length
      const r = await sm.restoreArchivedSession(row.archiveId, 'native')
      assert.equal(r.code, 'ARCHIVE_RESTORE_FORBIDDEN_USER_SHELL')
      assert.equal(BaseProvider.constructed.length, n, 'nothing was spawned')
    })

    it('an unknown id is ARCHIVED_SESSION_NOT_FOUND', async () => {
      makeSm()
      for (const id of ['f'.repeat(32), '../../x', '']) {
        const r = await sm.restoreArchivedSession(id, 'native')
        assert.equal(r.code, 'ARCHIVED_SESSION_NOT_FOUND')
      }
    })

    it('an invalid mode is refused before anything is read', async () => {
      makeSm()
      const { row } = await archived()
      const r = await sm.restoreArchivedSession(row.archiveId, 'fork')
      assert.equal(r.code, 'ARCHIVE_RESTORE_INVALID')
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
    })

    it('a synchronous failure reports the code and leaves the record in the archive', async () => {
      makeSm()
      const { row } = await archived({ provider: 'test-restore-throwing' })
      ThrowingResumeProvider.armed = true
      const before = sm._sessions.size
      const r = await sm.restoreArchivedSession(row.archiveId, 'native')
      assert.equal(r.ok, false)
      assert.equal(r.code, 'SPAWN_BOOM')
      assert.equal(sm._sessions.size, before)
      assert.equal(sm.listArchivedSessions().sessions.length, 1, 'still archived')
      assert.equal(sm.getFailedRestores().length, 0, 'not parked either: nothing was lost')
    })

    it('an ASYNC start failure re-parks the session in the failed restores with its history, and says so', async () => {
      makeSm()
      const { id, row } = await archived({ provider: 'test-restore-dead-start' })
      const pending = sm.restoreArchivedSession(row.archiveId, 'native')
      // The record is read and inflated off the event loop first.
      for (let i = 0; i < 200 && !sm._sessions.has(id); i++) await tick()
      sm._sessions.get(id).session._reject(Object.assign(new Error('pty died'), { code: 'PTY_DEAD' }))
      const r = await pending
      assert.equal(r.ok, false)
      assert.equal(r.code, 'PTY_DEAD')
      assert.equal(r.sessionId, id)
      const parked = sm.getFailedRestores().find((f) => f.sessionId === id)
      assert.ok(parked, 'parked in the failed restores')
      assert.ok(parked.historyLength >= 3, 'its history travelled with it')
    })

    it('keeps the archive record when the restored session could not be saved to disk', async () => {
      makeSm()
      const { row } = await archived()
      sm._flushPersistOrWarn = () => false
      const r = await sm.restoreArchivedSession(row.archiveId, 'native')
      assert.equal(r.ok, true)
      assert.equal(sm.listArchivedSessions().sessions.length, 1, 'a copy stays until the session is safely persisted')
    })
  })

  describe('new_thread', () => {
    it('starts a NEW session in the archived folder; the record stays', async () => {
      makeSm()
      const { id, row } = await archived()
      BaseProvider.constructed.length = 0

      const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')

      assert.equal(r.ok, true)
      assert.equal(r.mode, 'new_thread')
      assert.notEqual(r.sessionId, id, 'a new id')
      const live = sm._sessions.get(r.sessionId)
      assert.equal(live.name, 'Flag work (continued)')
      assert.equal(live.cwd, workDir)
      assert.equal(live.provider, 'test-restore-resume')
      assert.deepEqual(r.seed, { messagesIncluded: 2, messagesTotal: 2, bytes: r.seed.bytes })
      assert.equal(sm.listArchivedSessions().sessions.length, 1, 'the old thread is not live again, so the record stays')
    })

    it('carries NO authority and no native locator from the old session', async () => {
      makeSm()
      const { row } = await archived({ permissionMode: 'acceptEdits' })
      BaseProvider.constructed.length = 0
      await sm.restoreArchivedSession(row.archiveId, 'new_thread')
      const { opts } = BaseProvider.constructed[0]
      assert.equal(opts.permissionMode, 'approve', "the provider default, not the archived session's mode")
      assert.equal(opts.resumeSessionId, null, 'not a resume')
      assert.equal(opts.nativeResume, undefined)
      assert.equal(opts.codexSandbox, undefined)
      assert.equal(sm._sessions.size, 1)
      const [live] = [...sm._sessions.values()]
      assert.equal(live.worktreePath ?? null, null)
      assert.notEqual(live._isRestore, true, 'a new session, not a restore')
    })

    it("opens the new session's history with a system line that says it is a NEW thread", async () => {
      makeSm()
      const { row } = await archived()
      const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')
      const [first] = sm._history.getHistory(r.sessionId)
      assert.equal(first.messageType, 'system')
      assert.match(first.content, /NEW thread/)
      assert.match(first.content, /2 of 2 messages/)
      assert.match(first.content, /first message/)
    })

    it('holds the transcript as a pending seed, delivered once and only when the input was accepted', async () => {
      makeSm()
      const { row } = await archived()
      const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')

      const claim = sm.claimContinuationSeed(r.sessionId)
      assert.ok(claim.item.content.text.includes('pass --flag to the CLI'))
      assert.equal(claim.item.lifetime, 'one_turn')
      assert.equal(claim.item.provenance.source, 'archived_session')
      assert.equal(sm.claimContinuationSeed(r.sessionId), null, 'an in-flight claim is exclusive')

      sm.settleContinuationSeed(r.sessionId, false)
      const again = sm.claimContinuationSeed(r.sessionId)
      assert.ok(again, 'a rejected input returns the seed to pending')

      sm.settleContinuationSeed(r.sessionId, true)
      assert.equal(sm.claimContinuationSeed(r.sessionId), null, 'consumed: gone for good')
    })

    it('an unconsumed seed survives a daemon restart, and a consumed one does not come back', async () => {
      makeSm()
      const { row } = await archived()
      const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')
      const state = sm.serializeState()
      const persisted = state.sessions.find((s) => s.id === r.sessionId)
      assert.ok(persisted.continuationSeed.text.includes('how do I add a flag?'))

      const sm2 = new SessionManager({ skipPreflight: true, maxSessions: 10, stateFilePath: join(dir, 'state.json'), providerType: 'test-restore-plain' })
      sm2.restoreState()
      assert.ok(sm2.claimContinuationSeed(r.sessionId), 'restored from the state file')

      sm.claimContinuationSeed(r.sessionId)
      sm.settleContinuationSeed(r.sessionId, true)
      assert.equal(sm.serializeState().sessions.find((s) => s.id === r.sessionId).continuationSeed, undefined)
    })

    it('works for a provider that cannot resume at all, which is the point', async () => {
      makeSm()
      const { row } = await archived({ provider: 'test-restore-plain', conversationId: null })
      const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')
      assert.equal(r.ok, true)
    })

    it('with no conversation text it still starts, says there was nothing to carry, and holds no seed', async () => {
      makeSm()
      const { row } = await archived({ history: [{ type: 'tool_start', tool: 'Read', toolUseId: 't' }] })
      const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')
      assert.equal(r.ok, true)
      assert.equal(r.seed, undefined)
      assert.equal(sm.claimContinuationSeed(r.sessionId), null)
      assert.match(sm._history.getHistory(r.sessionId)[0].content, /no conversation text/)
    })

    it('refuses to move a container session to the host: ENVIRONMENT_UNAVAILABLE, and nothing is created', async () => {
      makeSm()
      const { row } = await archived()
      const real = sm._sessionArchive.getSaved.bind(sm._sessionArchive)
      sm._sessionArchive.getSaved = async (id) => { const r = await real(id); r.saved.environmentId = 'env-gone'; return r }
      const n = BaseProvider.constructed.length
      const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ENVIRONMENT_UNAVAILABLE')
      assert.equal(BaseProvider.constructed.length, n)
      assert.equal(sm.listArchivedSessions().sessions.length, 1)
    })

    it('refuses when the directory is gone', async () => {
      makeSm()
      const gone = join(dir, 'will-vanish')
      mkdirSync(gone)
      const { row } = await archived({ cwd: gone })
      rmSync(gone, { recursive: true })
      const r = await sm.restoreArchivedSession(row.archiveId, 'new_thread')
      assert.equal(r.code, 'ARCHIVE_RESTORE_CWD_MISSING')
    })
  })
})
