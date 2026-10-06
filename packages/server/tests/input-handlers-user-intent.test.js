/**
 * #8301 — what ends the "user stopped this session" state, and when.
 *
 * After a user Stop, daemon wakes are refused until the person next expresses
 * intent. Two defects the first cut had, both pinned here against the real
 * handlers and a real SessionManager:
 *
 *  1. The clear lived in `recordUserInput`, which for correlated input runs at
 *     ADMISSION. A provider that admits after awaiting its transport (the Codex
 *     app-server awaits turn/start) would admit an input sent BEFORE the Stop
 *     AFTER it and silently undo the Stop. Intent is recorded at RECEIPT now.
 *  2. A TUI user who Stops and keeps working in the terminal pane never "typed"
 *     through the chat input, so wakes stayed refused forever.
 *
 * CRITICAL: SessionManager uses a temp stateFilePath (#4633).
 */
import { describe, it, mock, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { SessionManager } from '../src/session-manager.js'
import { createMockSession, nsCtx } from './test-helpers.js'

let tmp
function tmpState() {
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'input-intent-'))
  return join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

const WS = {}

describe('user intent vs the Stop state (#8301)', () => {
  let mgr, session, ctx, client, primary, sendOptions
  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 3, stateFilePath: tmpState() })
    session = createMockSession()
    session.writeTerminalInput = mock.fn(() => true)
    sendOptions = []
    session.sendMessage = (text, attachments, opts) => { sendOptions.push(opts) }
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
    primary = new Map()
    ctx = nsCtx({
      sessionManager: {
        getSession: (id) => mgr.getSession(id),
        isBudgetPaused: (id) => mgr.isBudgetPaused(id),
        recordUserInput: (...a) => mgr.recordUserInput(...a),
        recordUserIntent: (id) => mgr.recordUserIntent(id),
        recordUserInterrupt: (id) => mgr.recordUserInterrupt(id),
        touchActivity: (id) => mgr.touchActivity(id),
        getHistoryCount: () => 0,
        listSessions: () => [],
      },
      send: mock.fn(),
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
      updatePrimary: mock.fn((sid, cid) => { primary.set(sid, cid) }),
      claimPrimary: mock.fn((sid, cid) => {
        const cur = primary.get(sid)
        if (cur && cur !== cid) return { changed: false, rejected: true, primaryClientId: cur }
        primary.set(sid, cid)
        return { changed: cur !== cid, primaryClientId: cid }
      }),
      getPrimary: mock.fn((sid) => primary.get(sid)),
      isPrimary: mock.fn((sid, cid) => primary.get(sid) === cid),
      checkpointManager: { createCheckpoint: mock.fn(() => Promise.resolve()) },
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      pendingPermissions: new Map(),
      clients: new Map(),
    })
    client = { id: 'c1', activeSessionId: 's1', clientCapabilities: new Set(['input_context_v1']) }
  })
  const stopped = () => mgr.daemonTurnRefusal('s1') === 'user-stopped'
  const stop = () => handleSessionMessage(WS, client, { type: 'interrupt' }, ctx)

  it('a Stop marks the session stopped', async () => {
    await stop()
    assert.equal(stopped(), true)
  })

  it('typed chat input AFTER a Stop clears it', async () => {
    await stop()
    await handleSessionMessage(WS, client, { type: 'input', data: 'carry on', clientMessageId: 'u1' }, ctx)
    assert.equal(stopped(), false)
  })

  it('input sent BEFORE the Stop but admitted AFTER it does NOT clear the Stop (deferred admission)', async () => {
    await handleSessionMessage(WS, client, { type: 'input', data: 'sent before the stop', clientMessageId: 'u1' }, ctx)
    assert.equal(sendOptions.length, 1)
    assert.equal(typeof sendOptions[0].onInputAdmission, 'function', 'precondition: correlated input, so admission is reported by the provider')
    await stop()
    assert.equal(stopped(), true)
    // The provider now admits it (it awaited its transport first). `recordUserInput`
    // runs from this callback; it must not undo the Stop.
    sendOptions[0].onInputAdmission({ status: 'accepted', delivery: 'dispatch_started' })
    assert.equal(stopped(), true, 'the late admission did not clear the Stop')
  })

  it('intent is recorded at RECEIPT, even for input that ends up rejected (the person expressed intent)', async () => {
    await stop()
    const budget = ctx.sessions.sessionManager.isBudgetPaused
    ctx.sessions.sessionManager.isBudgetPaused = () => true
    await handleSessionMessage(WS, client, { type: 'input', data: 'refused for budget', clientMessageId: 'u2' }, ctx)
    assert.equal(sendOptions.length, 0, 'precondition: it was rejected, never dispatched')
    assert.equal(stopped(), false)
    ctx.sessions.sessionManager.isBudgetPaused = budget
  })

  it('an empty send is not intent', async () => {
    await stop()
    await handleSessionMessage(WS, client, { type: 'input', data: '   ' }, ctx)
    assert.equal(stopped(), true)
  })

  it('terminal input with a carriage return (a submitted line) clears it', async () => {
    await stop()
    await handleSessionMessage(WS, client, { type: 'terminal_input', data: 'fix the bug\r' }, ctx)
    assert.equal(session.writeTerminalInput.mock.callCount(), 1)
    assert.equal(stopped(), false)
  })

  it('terminal input with a newline also clears it', async () => {
    await stop()
    await handleSessionMessage(WS, client, { type: 'terminal_input', data: 'x\n' }, ctx)
    assert.equal(stopped(), false)
  })

  it('bare terminal keystrokes without a newline do NOT clear it', async () => {
    await stop()
    await handleSessionMessage(WS, client, { type: 'terminal_input', data: 'abc' }, ctx)
    assert.equal(session.writeTerminalInput.mock.callCount(), 1, 'precondition: the keystrokes were delivered')
    assert.equal(stopped(), true)
  })

  it('a refused observer\'s terminal submission does not clear it', async () => {
    await stop()
    primary.set('s1', 'someone-else')
    await handleSessionMessage(WS, client, { type: 'terminal_input', data: 'hi\r' }, ctx)
    assert.equal(session.writeTerminalInput.mock.callCount(), 0, 'precondition: rejected as non-primary')
    assert.equal(stopped(), true)
  })

  it('the daemon\'s own wake does not clear it: neither the PTY wake nor the recorded user_input', async () => {
    await stop()
    session.writeTerminalInput('CI finished on PR #1\r') // the wake path calls the session directly, never the handler
    mgr.recordDaemonUserInput('s1', 'CI finished on PR #1', 'chroxy-ci-wake-a-1')
    assert.equal(stopped(), true)
  })
})
