import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'
import { sessionPrStatusHandlers } from '../src/handlers/session-pr-status-handlers.js'
import { sessionPrThreadsHandlers } from '../src/handlers/session-pr-threads-handlers.js'
import { _testTotalRecordCount } from '../src/handlers/survey-throttle.js'
import { createSpy, nsCtx } from './test-helpers.js'

/**
 * #7450 / #8092 acceptance: the survey-throttle prune must reach EVERY
 * session-teardown path, not just the ones that happen to emit
 * `session_destroyed`.
 *
 * PR #8088's first attempt wired the prune to `WsServer`'s `session_destroyed`
 * listener. Review (#8092) found that `_handleAsyncStartFailure()`'s
 * restore-rebind branch removes a session via `_cleanupSessionMaps()` directly
 * and emits `session_restore_failed` INSTEAD — a gap `_cleanupSessionMaps`'s
 * own doc comment already explains for the IDENTICAL reason (#7552's
 * environment-untag fix). The prune now lives in `_cleanupSessionMaps()`
 * itself (and in `destroyAll()`, the one path that bypasses it) — this file
 * drives a REAL `SessionManager`, not a mock `EventEmitter`, so it proves the
 * hook actually fires rather than proving a listener was attached to an event.
 *
 * Every `SessionManager` below gets its own temp `stateFilePath` (never the
 * real `~/.chroxy/session-state.json`) and every provider is a fake with a
 * synchronous or immediately-rejecting `start()` — nothing here shells out.
 */

/** A minimal provider whose start()/destroy() are synchronous no-ops. */
class NoopProvider extends EventEmitter {
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

/**
 * A provider whose start() REJECTS — mirrors claude-tui's dead PTY on a
 * reattach — but only when the TEST decides to (`_failStart(err)`), rather
 * than synchronously inside `start()`. A synchronous throw inside an async
 * `start()` schedules its `.catch()`-driven teardown as a microtask the
 * moment `createSession()` calls `.catch(...)` on the already-rejected
 * promise — which then races (and can WIN against) a survey issued
 * afterward, since the survey's own first `await` is what yields control
 * back to the microtask queue. Deferring the rejection to an explicit call
 * makes the interleaving in the regression test below deterministic: the
 * survey is always fully committed before the session is allowed to die.
 */
class DeadPtyProvider extends EventEmitter {
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = opts.resumeSessionId || null
    this._reject = null
  }
  static get capabilities() { return {} }
  start() {
    return new Promise((_resolve, reject) => { this._reject = reject })
  }
  /** Test-only: fail the pending start() on demand. */
  _failStart(err) {
    this._reject(err)
  }
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}

/** Let a rejected start() promise's microtask `.catch()` run. */
const tick = () => new Promise((r) => setImmediate(r))

/** Survey one session through BOTH handlers, so both throttle instances hold a record. */
async function surveySession(mgr, sessionId) {
  const ws = {}
  const client = { id: 'c1' }
  const ctx = nsCtx({
    send: createSpy(),
    sessionManager: mgr,
    surveySessionPrStatus: createSpy(async () => ({ sessionId, pr: null, reason: null })),
    surveySessionPrThreads: createSpy(async () => ({ sessionId, unresolvedCount: 0, reason: null })),
  })
  await sessionPrStatusHandlers.session_pr_status_request(ws, client, { type: 'session_pr_status_request', sessionId }, ctx)
  await sessionPrThreadsHandlers.session_pr_threads_request(ws, client, { type: 'session_pr_threads_request', sessionId }, ctx)
}

/** Run `fn(dir)` against a fresh temp dir, always cleaned up afterward. */
async function withTmpDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('#7450 / #8092 — survey-throttle prune reaches every session-teardown path', () => {
  it('the NORMAL destroySession() path prunes both throttle instances', async () => {
    await withTmpDir('sm-throttle-normal-', async (dir) => {
      const { registerProvider } = await import('../src/providers.js')
      registerProvider('test-throttle-normal', NoopProvider)
      const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: join(dir, 'state.json') })

      const sessionId = mgr.createSession({ cwd: '/tmp', provider: 'test-throttle-normal' })
      await surveySession(mgr, sessionId)
      assert.equal(_testTotalRecordCount(mgr), 2, 'sanity: both handlers left a record')

      mgr.destroySession(sessionId)

      assert.equal(_testTotalRecordCount(mgr), 0, 'destroySession() must prune both throttle records')
    })
  })

  it('#8092 — the RESTORE-REBIND failure path prunes too, though it never emits session_destroyed', async () => {
    await withTmpDir('sm-throttle-restore-', async (dir) => {
      const { registerProvider } = await import('../src/providers.js')
      registerProvider('test-throttle-restore-rebind', DeadPtyProvider)
      const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: join(dir, 'state.json') })

      const destroyedEvents = []
      mgr.on('session_destroyed', (e) => destroyedEvents.push(e))

      const preserveId = 'b'.repeat(32)
      const sessionId = mgr.createSession({
        cwd: '/tmp',
        provider: 'test-throttle-restore-rebind',
        preserveId,
        skipPersist: true,
        isRestore: true,
      })
      assert.equal(sessionId, preserveId)

      await surveySession(mgr, sessionId)
      assert.equal(_testTotalRecordCount(mgr), 2, 'sanity: both handlers left a record before the rejection lands')

      mgr._sessions.get(sessionId).session._failStart(new Error('claude PTY exited during warmup (code=1)'))
      await tick() // let the rejection reach _handleAsyncStartFailure

      assert.equal(mgr._sessions.has(sessionId), false, 'the dead session left _sessions')
      assert.equal(destroyedEvents.length, 0, 'this path emits session_restore_failed, never session_destroyed — the exact gap #8092 found')
      assert.equal(mgr.getFailedRestores().length, 1, 'sanity: this really is the restore-rebind path')

      assert.equal(_testTotalRecordCount(mgr), 0, 'the survey-throttle record(s) must be pruned even though session_destroyed never fired')
    })
  })

  it('destroyAll() (the one path that bypasses _cleanupSessionMaps) prunes too', async () => {
    await withTmpDir('sm-throttle-destroyall-', async (dir) => {
      const { registerProvider } = await import('../src/providers.js')
      registerProvider('test-throttle-destroyall', NoopProvider)
      const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: join(dir, 'state.json') })

      const sessionId = mgr.createSession({ cwd: '/tmp', provider: 'test-throttle-destroyall' })
      await surveySession(mgr, sessionId)
      assert.equal(_testTotalRecordCount(mgr), 2)

      mgr.destroyAll()

      assert.equal(_testTotalRecordCount(mgr), 0, 'destroyAll() must prune too — it bypasses _cleanupSessionMaps entirely')
    })
  })

  it('does not grow across N create+destroy cycles (the original #7450 acceptance shape)', async () => {
    await withTmpDir('sm-throttle-cycle-', async (dir) => {
      const { registerProvider } = await import('../src/providers.js')
      registerProvider('test-throttle-cycle', NoopProvider)
      const mgr = new SessionManager({ skipPreflight: true, maxSessions: 20, stateFilePath: join(dir, 'state.json') })

      const N = 6
      for (let i = 0; i < N; i++) {
        const sessionId = mgr.createSession({ cwd: '/tmp', provider: 'test-throttle-cycle' })
        await surveySession(mgr, sessionId)
        mgr.destroySession(sessionId)
      }

      assert.equal(_testTotalRecordCount(mgr), 0, `every one of ${N} sessions was destroyed, so no record should remain`)
    })
  })

  it('POSITIVE CONTROL: the count DOES grow when sessions are surveyed but never destroyed', async () => {
    // Without this, the assertions above would also pass against a survey
    // that never wrote a record in the first place.
    await withTmpDir('sm-throttle-control-', async (dir) => {
      const { registerProvider } = await import('../src/providers.js')
      registerProvider('test-throttle-control', NoopProvider)
      const mgr = new SessionManager({ skipPreflight: true, maxSessions: 20, stateFilePath: join(dir, 'state.json') })

      const N = 4
      for (let i = 0; i < N; i++) {
        const sessionId = mgr.createSession({ cwd: '/tmp', provider: 'test-throttle-control' })
        await surveySession(mgr, sessionId)
      }

      assert.equal(_testTotalRecordCount(mgr), N * 2, 'one status + one threads record per undestroyed session')
    })
  })
})
