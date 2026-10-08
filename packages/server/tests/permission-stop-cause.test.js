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
import { ClaudeByokSession } from '../src/byok-session.js'
import { SdkSession } from '../src/sdk-session.js'
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

describe('PermissionManager.markUserStopInFlight (#8374)', () => {
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
    pm.markUserStopInFlight()
    ac.abort()
    assert.equal((await decided).behavior, 'deny')
    assert.equal(resolved[0].reason, 'stopped')
    assert.equal(resolved[0].decision, 'deny', 'still a deny to the provider: the tool must not run')
    pm.destroy()
  })

  it('a prompt raised AFTER the Stop but before the abort lands is a Stop\'s too (#8430)', async () => {
    const { pm, resolved } = makePm()
    const acA = new AbortController()
    const a = pm.handlePermission('Bash', { command: 'a' }, acA.signal, 'approve')
    pm.markUserStopInFlight()
    const acB = new AbortController()
    const b = pm.handlePermission('Bash', { command: 'b' }, acB.signal, 'approve')
    acA.abort()
    acB.abort()
    await Promise.all([a, b])
    assert.deepEqual(resolved.map((r) => r.reason), ['stopped', 'stopped'])
    pm.destroy()
  })

  it('CONTROL: a prompt raised before the Stop, with no Stop, stays aborted (a failed turn, #8430)', async () => {
    const { pm, resolved } = makePm()
    const ac = new AbortController()
    const b = pm.handlePermission('Bash', { command: 'b' }, ac.signal, 'approve')
    ac.abort()
    await b
    assert.deepEqual(resolved.map((r) => r.reason), ['aborted'])
    pm.destroy()
  })

  it('once the turn ends and the flag is cleared, the next turn\'s abort is aborted again (#8430)', async () => {
    const { pm, resolved } = makePm()
    pm.markUserStopInFlight()
    assert.equal(pm.isUserStopInFlight(), true)
    pm.clearUserStopInFlight()
    assert.equal(pm.isUserStopInFlight(), false)
    const ac = new AbortController()
    const decided = pm.handlePermission('Bash', { command: 'ls' }, ac.signal, 'approve')
    ac.abort()
    await decided
    assert.deepEqual(resolved.map((r) => r.reason), ['aborted'])
    pm.destroy()
  })

  it('a marked prompt that is answered normally stays an ordinary answer', async () => {
    const { pm, resolved } = makePm()
    const ac = new AbortController()
    let requestId
    pm.once('permission_request', (d) => { requestId = d.requestId })
    const decided = pm.handlePermission('Bash', { command: 'ls' }, ac.signal, 'approve')
    pm.markUserStopInFlight()
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
    pm.markUserStopInFlight()
    await decided
    assert.equal(resolved[0].reason, 'timeout')
    pm.destroy()
  })
})

describe('BaseSession.markUserStopInFlight (#8374)', () => {
  it('records the Stop on the session\'s PermissionManager while a turn is running', () => {
    const fake = { _isBusy: true, _permissions: { markUserStopInFlight: mock.fn() } }
    BaseSession.prototype.markUserStopInFlight.call(fake)
    assert.equal(fake._permissions.markUserStopInFlight.mock.callCount(), 1)
  })

  it('records nothing when no turn is running: a Stop between turns must not label the next one (#8430)', () => {
    const fake = { _isBusy: false, _permissions: { markUserStopInFlight: mock.fn() } }
    BaseSession.prototype.markUserStopInFlight.call(fake)
    assert.equal(fake._permissions.markUserStopInFlight.mock.callCount(), 0)
  })

  it('every turn end clears it: _clearMessageState reaches the permission manager (#8430)', () => {
    const pm = new PermissionManager({ log: quiet })
    const s = new BaseSession({ cwd: '/tmp' })
    s._permissions = pm
    s._isBusy = true
    s.markUserStopInFlight()
    assert.equal(s._permissions.isUserStopInFlight(), true)
    s._clearMessageState()
    assert.equal(s._permissions.isUserStopInFlight(), false)
    pm.destroy()
  })

  it('is a no-op for a session with no in-process permission manager', () => {
    assert.doesNotThrow(() => BaseSession.prototype.markUserStopInFlight.call({}))
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
    session.markUserStopInFlight = BaseSession.prototype.markUserStopInFlight
    session._isBusy = true
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

  it('a prompt raised between the Stop and the abort is recorded as stopped too, in the journal (#8430)', async () => {
    const acLate = new AbortController()
    let late
    // The provider's interrupt is not instant: a parallel tool asks first, then
    // the abort lands on both.
    session.interrupt = async () => {
      late = pm.handlePermission('Bash', { command: 'late' }, acLate.signal, 'approve')
      await Promise.resolve()
      ac.abort()
      acLate.abort()
    }
    const first = pm.handlePermission('Bash', { command: 'ls' }, ac.signal, 'approve')
    await handleSessionMessage({}, client, { type: 'interrupt' }, ctx)
    await Promise.all([first, late])
    assert.deepEqual(outcomes().map((o) => o.outcome), ['stopped', 'stopped'])
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
  // The capabilities live on the client RECORD (`clients.get(ws)`), never on the
  // raw socket `ws` -- reading them off `ws` made every client look old.
  const replay = (client, e) => {
    const frames = []
    sendHistoryEntry((_ws, payload) => frames.push(payload), {}, 's1', e, client)
    return frames[0]
  }

  it('a client advertising the capability gets "stopped"', () => {
    const client = { clientCapabilities: new Set(['permission_outcome_stopped_v1']) }
    assert.equal(replay(client, entry('stopped')).outcome, 'stopped')
  })

  it('a client that does not (an older build, which drops an outcome it cannot parse) gets "expired"', () => {
    for (const client of [{ clientCapabilities: new Set(['voice_input']) }, { clientCapabilities: new Set() }, {}, null, undefined]) {
      const frame = replay(client, entry('stopped'))
      assert.equal(frame.outcome, 'expired')
      assert.equal(frame.requestId, 'p', 'the record is kept, only its label degrades')
      assert.equal(frame.historySeq, 4)
    }
  })

  it('capabilities on the raw socket are not consulted (that is not where the handshake puts them)', () => {
    const frames = []
    sendHistoryEntry((_ws, payload) => frames.push(payload), { clientCapabilities: new Set(['permission_outcome_stopped_v1']) }, 's1', entry('stopped'), null)
    assert.equal(frames[0].outcome, 'expired')
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

describe('PermissionManager.clearAll reads the user Stop (#8430)', () => {
  async function drain(opts, { stop }) {
    const { pm, resolved } = makePm()
    pm.handlePermission('Bash', { command: 'ls' }, new AbortController().signal, 'approve')
    if (stop) pm.markUserStopInFlight()
    pm.clearAll(opts)
    pm.destroy()
    return resolved.map((r) => r.reason)
  }
  it('drains an open prompt as stopped while a user Stop is in flight', async () => {
    assert.deepEqual(await drain(undefined, { stop: true }), ['stopped'])
  })
  it('CONTROL: drains it as cleared when there is no Stop', async () => {
    assert.deepEqual(await drain(undefined, { stop: false }), ['cleared'])
  })
  it('a caller that already cleared the flag passes the value it captured', async () => {
    assert.deepEqual(await drain({ userStop: true }, { stop: false }), ['stopped'])
    assert.deepEqual(await drain({ userStop: false }, { stop: true }), ['cleared'])
  })
})

describe('ClaudeByokSession and the user Stop (#8430)', () => {
  it('a user Stop aborts the open prompt as stopped, and the turn end clears the flag', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    const reasons = []
    session._permissions.on('permission_resolved', (d) => reasons.push(d.reason))
    session._isBusy = true
    session._abortController = new AbortController()
    const decided = session._permissions.handlePermission('Bash', { command: 'ls' }, session._abortController.signal, 'approve')
    session.markUserStopInFlight()
    session.interrupt()
    await decided
    assert.deepEqual(reasons, ['stopped'])
    session._finishTurn()
    assert.equal(session._permissions.isUserStopInFlight(), false)
    session.destroy()
  })

  it('a Stop does not outlive a turn that ends before it starts (the MCP prompt-expansion failure path)', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session.on('error', () => {})
    session._isBusy = true
    session._permissions.markUserStopInFlight() // pressed on turn A
    session._finishTurn()
    assert.equal(session._permissions.isUserStopInFlight(), false, 'A\'s own teardown')
    // A leaked flag, as if a path had skipped teardown: the next turn starts clear, and
    // a turn that fails before it starts clears it again on the way out.
    session._permissions.markUserStopInFlight()
    session._processReady = true
    session._client = {}
    let seenAtStart
    session._matchMcpPromptCommand = () => ({ prefixedName: 'mcp__x__y' })
    session._resolveMcpPromptToText = async () => {
      seenAtStart = session._permissions.isUserStopInFlight()
      session._permissions.markUserStopInFlight() // pressed while the expansion is awaited
      throw new Error('dead server')
    }
    await session.sendMessage('/mcp__x__y')
    assert.equal(seenAtStart, false, 'the new turn started clear')
    assert.equal(session._permissions.isUserStopInFlight(), false, 'the failed expansion cleared it')
    // ...so turn C's interrupt is not a Stop
    const reasons = []
    session._permissions.on('permission_resolved', (d) => reasons.push(d.reason))
    session._isBusy = true
    session._abortController = new AbortController()
    const decided = session._permissions.handlePermission('Bash', { command: 'ls' }, session._abortController.signal, 'approve')
    session.interrupt()
    await decided
    assert.deepEqual(reasons, ['aborted'])
    session.destroy()
  })

  it('CONTROL: an abort with no user Stop reads aborted', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    const reasons = []
    session._permissions.on('permission_resolved', (d) => reasons.push(d.reason))
    session._isBusy = true
    session._abortController = new AbortController()
    const decided = session._permissions.handlePermission('Bash', { command: 'ls' }, session._abortController.signal, 'approve')
    session.interrupt()
    await decided
    assert.deepEqual(reasons, ['aborted'])
    session.destroy()
  })
})

/**
 * #8430 -- end to end, in the order a LIVE claude-sdk Stop takes: the real
 * SessionManager wiring over a real SdkSession, the `interrupt` message handler as
 * the Stop entry point, and a query whose generator throws AbortError when
 * interrupted. The SDK's abort never reaches the permission manager's listener
 * first; the open prompt is drained by the turn's teardown. What the journal
 * records, and what each kind of client is replayed, is asserted on the REAL
 * history entry, not on the permission manager's own event.
 */
describe('a live claude-sdk Stop is journaled and replayed as stopped (#8430)', () => {
  let mgr, session, ctx, client
  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 3, stateFilePath: tmpState() })
    session = new SdkSession({ cwd: '/tmp' })
    session._processReady = true
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
  })
  afterEach(() => { session.destroy() })

  // The prompt is raised, then the turn ends on `ending` -- with NO abort event
  // reaching the prompt's signal, exactly as on the daemon.
  async function run(ending, { stop }) {
    let release
    const gate = new Promise((r) => { release = r })
    session._callQuery = () => {
      const gen = (async function* () {
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_p', name: 'Bash', input: {} } } }
        session._handlePermission('Bash', { command: 'ls' }, new AbortController().signal, undefined, 'toolu_p')
        await gate
        throw ending
      })()
      gen.interrupt = async () => { release() }
      return gen
    }
    session.on('error', () => {})
    const turn = session.sendMessage('go')
    await new Promise((r) => setTimeout(r, 15))
    if (stop) await handleSessionMessage({}, client, { type: 'interrupt' }, ctx)
    else release()
    await turn
    return mgr.getHistory('s1').filter((e) => e.type === 'permission_outcome')
  }
  const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  const replay = (entry, caps) => {
    const frames = []
    sendHistoryEntry((_ws, payload) => frames.push(payload), {}, 's1', entry, { clientCapabilities: new Set(caps) })
    return frames[0].outcome
  }

  it('the journal records stopped, and a client that can label it is replayed stopped', async () => {
    const outcomes = await run(abortError(), { stop: true })
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].outcome, 'stopped')
    assert.equal(replay(outcomes[0], ['permission_outcome_stopped_v1']), 'stopped')
  })

  it('a client that did not advertise the capability is replayed expired (the stored entry stays stopped)', async () => {
    const outcomes = await run(abortError(), { stop: true })
    assert.equal(replay(outcomes[0], ['voice_input']), 'expired')
    assert.equal(outcomes[0].outcome, 'stopped')
  })

  it('CONTROL: the same teardown with no Stop (a turn failure) is journaled expired', async () => {
    const outcomes = await run(new Error('boom'), { stop: false })
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].outcome, 'expired')
    assert.equal(replay(outcomes[0], ['permission_outcome_stopped_v1']), 'expired')
  })
})
