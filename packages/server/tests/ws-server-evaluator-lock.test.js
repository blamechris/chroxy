// Real WsServer dispatch (`_handleMessage`), so the per-message ctx spread is the
// production one: the per-session evaluator lock must be shared across messages.
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer } from '../src/ws-server.js'
import { createMockSessionManager } from './test-helpers.js'
import { boundedRegex } from '../src/utils/bounded-regex.js'

const SID1 = 'a'.repeat(32)
const SID2 = 'b'.repeat(32)
function fixture() {
  const { manager } = createMockSessionManager([{ id: SID1, cwd: '/tmp/x' }, { id: SID2, cwd: '/tmp/y' }])
  const server = new WsServer({ port: 0, apiToken: 'fixture-only', sessionManager: manager })
  const sent = []
  server._send = (ws, msg) => sent.push({ ws, msg })
  const mk = (id, sid) => { const ws = { id }; server.clients.set(ws, { id, authenticated: true, isPrimaryToken: true, authToken: 'fixture-only', rateLimitKey: 'k-' + id, activeSessionId: sid }); return ws }
  return { server, manager, sent, mk }
}
after(() => boundedRegex.close())

describe('real WsServer dispatch shares the evaluator lock', () => {
  it('second frame on same session is refused while the first is with the evaluator; other session unaffected', async () => {
    const f = fixture()
    const e1 = f.manager.getSession(SID1); const e2 = f.manager.getSession(SID2)
    e1.session.promptEvaluator = true; e2.session.promptEvaluator = true
    let release; const gate = new Promise(r => { release = r })
    let calls = 0
    f.server._handlerCtx.evaluateDraft = async () => { calls++; await gate; return { verdict: 'forward' } }
    const wsA = f.mk('A', SID1), wsB = f.mk('B', SID1), wsC = f.mk('C', SID2)
    const p1 = f.server._handleMessage(wsA, { type: 'input', data: 'please refactor the auth module thoroughly', sessionId: SID1 })
    await new Promise(r => setTimeout(r, 50))
    const p2 = f.server._handleMessage(wsB, { type: 'input', data: 'another substantive request for the same session', sessionId: SID1 })
    const p3 = f.server._handleMessage(wsC, { type: 'input', data: 'substantive request on the other session here', sessionId: SID2 })
    await new Promise(r => setTimeout(r, 100))
    const callsMid = calls
    assert.equal(f.server._pendingEvaluatorAwaits.size, 2, 'one lock per session with a draft in flight')
    release()
    await Promise.all([p1, p2, p3])
    const conflictsB = f.sent.filter(s => s.ws === wsB && s.msg.type === 'session_error' && s.msg.category === 'input_conflict')
    const conflictsC = f.sent.filter(s => s.ws === wsC && s.msg.category === 'input_conflict')
    assert.equal(conflictsB.length, 1)
    assert.equal(conflictsC.length, 0)
    assert.equal(callsMid, 2)
    assert.equal(e1.session.sendMessage.callCount, 1)
    assert.equal(e2.session.sendMessage.callCount, 1)
    assert.equal(f.server._pendingEvaluatorAwaits.size, 0)
  })
  it('evaluator off: two quick inputs both dispatch', async () => {
    const f = fixture()
    const e1 = f.manager.getSession(SID1)
    const wsA = f.mk('A', SID1)
    const p1 = f.server._handleMessage(wsA, { type: 'input', data: 'first message here', sessionId: SID1 })
    const p2 = f.server._handleMessage(wsA, { type: 'input', data: 'second message here', sessionId: SID1 })
    await Promise.all([p1, p2])
    const conflicts = f.sent.filter(s => s.msg.category === 'input_conflict')
    assert.equal(e1.session.sendMessage.callCount, 2)
    assert.equal(conflicts.length, 0)
  })
  it('evaluator on: trivial ack during evaluation still refused (entry check), trivial ack alone never locks', async () => {
    const f = fixture()
    const e1 = f.manager.getSession(SID1)
    e1.session.promptEvaluator = true
    let calls = 0
    f.server._handlerCtx.evaluateDraft = async () => { calls++; return { verdict: 'forward' } }
    const wsA = f.mk('A', SID1)
    const p1 = f.server._handleMessage(wsA, { type: 'input', data: 'yes', sessionId: SID1 })
    const p2 = f.server._handleMessage(wsA, { type: 'input', data: 'ok', sessionId: SID1 })
    await Promise.all([p1, p2])
    assert.equal(calls, 0)
    assert.equal(e1.session.sendMessage.callCount, 2)
  })
  it('session destroyed mid-evaluation: the lock entry is pruned and the settling evaluator leaves nothing behind', async () => {
    const f = fixture()
    const e1 = f.manager.getSession(SID1)
    e1.session.promptEvaluator = true
    let release; const gate = new Promise(r => { release = r })
    f.server._handlerCtx.evaluateDraft = async () => { await gate; return { verdict: 'forward' } }
    const wsA = f.mk('A', SID1)
    const p1 = f.server._handleMessage(wsA, { type: 'input', data: 'please refactor the auth module thoroughly', sessionId: SID1 })
    await new Promise(r => setTimeout(r, 50))
    f.manager.emit('session_destroyed', { sessionId: SID1 })
    assert.equal(f.server._pendingEvaluatorAwaits.size, 0, 'the destroy handler prunes the lock entry')
    release(); await p1
    assert.equal(f.server._pendingEvaluatorAwaits.size, 0)
  })
})
