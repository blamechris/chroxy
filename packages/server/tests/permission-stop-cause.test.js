/**
 * #8374 -- a permission prompt is `stopped` only when the USER pressed Stop on it.
 *
 * The first cut mapped every `reason: 'aborted'` to "stopped", but the
 * PermissionManager's abort listener cannot tell why a signal aborted: the Codex
 * app-server's reconnect watchdog and a dead app-server both fail the turn through
 * `_endTurnAbort()`, which aborts the same controller Stop does. Those are not
 * Stops. The cause is recorded where it is known -- the user's Stop entry point
 * (`handleInterrupt`) marks the prompts pending at that moment -- and the abort
 * listener reads the mark.
 *
 * CRITICAL: SessionManager uses a temp stateFilePath (#4633).
 */
import { describe, it, mock, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionManager, wirePermissionManager } from '../src/permission-manager.js'
import { BaseSession } from '../src/base-session.js'
import { SessionManager } from '../src/session-manager.js'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { sendHistoryEntry } from '../src/ws-history.js'
import { nsCtx } from './test-helpers.js'

let tmp
function tmpState() {
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'perm-stop-cause-'))
  return join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

const quiet = { info() {}, warn() {}, error() {} }

function makePm() {
  const pm = new PermissionManager({ log: quiet })
  const resolved = []
  pm.on('permission_resolved', (d) => resolved.push(d))
  return { pm, resolved }
}

describe('PermissionManager.markPendingStopped (#8374)', () => {
  it('an abort with no mark is "aborted" (a failure or a teardown, not a Stop)', async () => {
    const { pm, resolved } = makePm()
    const ac = new AbortController()
    const decided = pm.handlePermission('Bash', { command: 'ls' }, ac.signal, 'approve')
    ac.abort()
    assert.equal((await decided).behavior, 'deny')
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].reason, 'aborted')
    assert.equal(resolved[0].decision, 'deny')
    pm.destroy()
  })

  it('an abort after the user marked the pending prompt is "stopped"', async () => {
    const { pm, resolved } = makePm()
    const ac = new AbortController()
    const decided = pm.handlePermission('Bash', { command: 'ls' }, ac.signal, 'approve')
    pm.markPendingStopped()
    ac.abort()
    assert.equal((await decided).behavior, 'deny')
    assert.equal(resolved[0].reason, 'stopped')
    assert.equal(resolved[0].decision, 'deny', 'still a deny to the provider: the tool must not run')
    pm.destroy()
  })

  it('the mark covers only prompts pending when Stop was pressed, not a later one', async () => {
    const { pm, resolved } = makePm()
    const acA = new AbortController()
    const a = pm.handlePermission('Bash', { command: 'a' }, acA.signal, 'approve')
    pm.markPendingStopped()
    const acB = new AbortController()
    const b = pm.handlePermission('Bash', { command: 'b' }, acB.signal, 'approve')
    acA.abort()
    acB.abort()
    await Promise.all([a, b])
    assert.deepEqual(resolved.map((r) => r.reason), ['stopped', 'aborted'])
    pm.destroy()
  })

  it('a marked prompt that is answered normally stays an ordinary answer', async () => {
    const { pm, resolved } = makePm()
    const ac = new AbortController()
    let requestId
    pm.once('permission_request', (d) => { requestId = d.requestId })
    const decided = pm.handlePermission('Bash', { command: 'ls' }, ac.signal, 'approve')
    pm.markPendingStopped()
    pm.respondToPermission(requestId, 'allow')
    assert.equal((await decided).behavior, 'allow')
    ac.abort()
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].reason, 'user')
    pm.destroy()
  })

  it('a timeout is still "timeout" even for a marked prompt', async () => {
    const { pm, resolved } = (() => {
      const pm = new PermissionManager({ log: quiet, timeoutMs: 15 })
      const resolved = []
      pm.on('permission_resolved', (d) => resolved.push(d))
      return { pm, resolved }
    })()
    const decided = pm.handlePermission('Bash', { command: 'ls' }, new AbortController().signal, 'approve')
    pm.markPendingStopped()
    await decided
    assert.equal(resolved[0].reason, 'timeout')
    pm.destroy()
  })
})

describe('BaseSession.markPendingPermissionsStopped (#8374)', () => {
  it('marks the prompts of the session\'s PermissionManager', () => {
    const fake = { _permissions: { markPendingStopped: mock.fn() } }
    BaseSession.prototype.markPendingPermissionsStopped.call(fake)
    assert.equal(fake._permissions.markPendingStopped.mock.callCount(), 1)
  })

  it('is a no-op for a session with no in-process permission manager', () => {
    assert.doesNotThrow(() => BaseSession.prototype.markPendingPermissionsStopped.call({}))
  })
})

describe('the user Stop entry point marks the open prompt (#8374)', () => {
  let mgr, session, pm, ac, ctx, client, requestId
  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 3, stateFilePath: tmpState() })
    session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    pm = new PermissionManager({ log: quiet })
    wirePermissionManager(session, pm)
    session._permissions = pm
    session.markPendingPermissionsStopped = BaseSession.prototype.markPendingPermissionsStopped
    ac = new AbortController()
    // What every in-process provider's interrupt() does to a pending prompt:
    // abort the controller its handlePermission was given.
    session.interrupt = () => { ac.abort() }
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
    mgr._wireSessionEvents('s1', session)
    ctx = nsCtx({
      sessionManager: {
        getSession: (id) => mgr.getSession(id),
        recordUserInterrupt: (id) => mgr.recordUserInterrupt(id),
        getHistoryCount: () => 0,
        listSessions: () => [],
      },
      send: mock.fn(),
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      pendingPermissions: new Map(),
      clients: new Map(),
    })
    client = { id: 'c1', activeSessionId: 's1' }
    session.once('permission_request', (d) => { requestId = d.requestId })
  })
  afterEach(() => { pm.destroy() })

  const outcomes = () => mgr.getHistory('s1').filter((e) => e.type === 'permission_outcome')

  it('a user Stop leaves the prompt recorded as stopped', async () => {
    const decided = pm.handlePermission('Bash', { command: 'ls' }, ac.signal, 'approve')
    await handleSessionMessage({}, client, { type: 'interrupt' }, ctx)
    await decided
    assert.equal(outcomes().length, 1)
    assert.equal(outcomes()[0].requestId, requestId)
    assert.equal(outcomes()[0].outcome, 'stopped')
  })

  it('CONTROL: the same abort with no user Stop (a failed turn) is recorded as expired', async () => {
    const decided = pm.handlePermission('Bash', { command: 'ls' }, ac.signal, 'approve')
    session.interrupt()
    await decided
    assert.equal(outcomes()[0].outcome, 'expired')
  })
})

describe('a client that cannot label a stopped outcome is sent expired (#8374)', () => {
  const entry = (outcome) => ({ type: 'permission_outcome', requestId: 'p', tool: 'Bash', description: 'ls', outcome, timestamp: 1, _seq: 4 })
  const replay = (ws, e) => {
    const frames = []
    sendHistoryEntry((_ws, payload) => frames.push(payload), ws, 's1', e)
    return frames[0]
  }

  it('a client advertising the capability gets "stopped"', () => {
    const ws = { clientCapabilities: new Set(['permission_outcome_stopped_v1']) }
    assert.equal(replay(ws, entry('stopped')).outcome, 'stopped')
  })

  it('a client that does not (an older build, which drops an outcome it cannot parse) gets "expired"', () => {
    for (const ws of [{ clientCapabilities: new Set(['voice_input']) }, { clientCapabilities: new Set() }, {}, null]) {
      const frame = replay(ws, entry('stopped'))
      assert.equal(frame.outcome, 'expired')
      assert.equal(frame.requestId, 'p', 'the record is kept, only its label degrades')
      assert.equal(frame.historySeq, 4)
    }
  })

  it('does not touch the stored entry, so a capable client reconnecting later still gets "stopped"', () => {
    const e = entry('stopped')
    replay({}, e)
    assert.equal(e.outcome, 'stopped')
  })

  it('CONTROL: the other outcomes are never rewritten', () => {
    for (const outcome of ['allowed', 'denied', 'expired']) {
      assert.equal(replay({}, entry(outcome)).outcome, outcome)
    }
  })

  it('both stock clients advertise it', async () => {
    const { CLIENT_CAPABILITIES } = await import('@chroxy/protocol')
    assert.ok(CLIENT_CAPABILITIES.desktop.includes('permission_outcome_stopped_v1'))
    assert.ok(CLIENT_CAPABILITIES.mobile.includes('permission_outcome_stopped_v1'))
  })
})
