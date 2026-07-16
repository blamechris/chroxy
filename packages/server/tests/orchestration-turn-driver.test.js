import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { TurnDriver, TurnError } from '../src/orchestration/turn-driver.js'

// #6691 E-1 — the driven-turn primitive, tested against a stub SessionManager
// that mimics the real session_event / session_destroyed surface. No real
// sessions, no ~/.chroxy.

// A fake SessionManager: EventEmitter + getSession returning a fake session
// whose sendMessage/interrupt we can observe. We drive events manually.
function mkStub() {
  const sm = new EventEmitter()
  const sessions = new Map()
  sm.getSession = (id) => sessions.get(id) || null
  const addSession = (id, { sendImpl } = {}) => {
    const session = {
      sent: [],
      interrupted: 0,
      sendMessage(prompt, _atts, opts) { this.sent.push({ prompt, opts }); return sendImpl ? sendImpl() : undefined },
      interrupt() { this.interrupted++ },
    }
    sessions.set(id, { session })
    return session
  }
  // emit a session_event for a session
  sm.ev = (id, event, data) => sm.emit('session_event', { sessionId: id, event, data })
  sm.destroy = (id) => sm.emit('session_destroyed', { sessionId: id })
  return { sm, addSession }
}

let driver
afterEach(() => { driver?.dispose(); driver = null })

describe('TurnDriver — happy path', () => {
  it('accumulates streamed deltas and resolves on result', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p = driver.driveTurn('s1', 'hello', { label: 'plan' })
    sm.ev('s1', 'stream_delta', { messageId: 'm1', delta: 'Hel' })
    sm.ev('s1', 'stream_delta', { messageId: 'm1', delta: 'lo world' })
    sm.ev('s1', 'result', { cost: 0.1, duration: 5, usage: { input_tokens: 3 } })
    const { text, result } = await p
    assert.equal(text, 'Hello world')
    assert.equal(result.cost, 0.1)
    assert.deepEqual(result.usage, { input_tokens: 3 })
  })

  it('captures non-streamed message{response} fallback text', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p = driver.driveTurn('s1', 'hi')
    sm.ev('s1', 'message', { type: 'response', content: 'compact summary' })
    sm.ev('s1', 'result', { cost: 0, duration: 1, usage: {} })
    assert.equal((await p).text, 'compact summary')
  })
})

describe('TurnDriver — epoch guard + mutex', () => {
  it('ignores stray events with no active turn', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    // events before any driveTurn are dropped
    sm.ev('s1', 'stream_delta', { messageId: 'm0', delta: 'ghost' })
    sm.ev('s1', 'result', { cost: 9, duration: 9, usage: {} })
    const p = driver.driveTurn('s1', 'go')
    sm.ev('s1', 'stream_delta', { messageId: 'm1', delta: 'real' })
    sm.ev('s1', 'result', { cost: 1, duration: 1, usage: {} })
    const { text, result } = await p
    assert.equal(text, 'real', 'ghost delta from before the turn ignored')
    assert.equal(result.cost, 1)
  })

  it('serializes two turns on the same session (FIFO mutex)', async () => {
    const { sm, addSession } = mkStub()
    const s = addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p1 = driver.driveTurn('s1', 'first')
    const p2 = driver.driveTurn('s1', 'second')
    // only the first turn's send has happened; second is queued behind the mutex
    assert.equal(s.sent.length, 1)
    assert.equal(s.sent[0].prompt, 'first')
    sm.ev('s1', 'stream_delta', { messageId: 'm1', delta: 'A' })
    sm.ev('s1', 'result', { cost: 0, duration: 0, usage: {} })
    assert.equal((await p1).text, 'A')
    // now the second turn runs
    await Promise.resolve()
    assert.equal(s.sent.length, 2)
    assert.equal(s.sent[1].prompt, 'second')
    sm.ev('s1', 'stream_delta', { messageId: 'm2', delta: 'B' })
    sm.ev('s1', 'result', { cost: 0, duration: 0, usage: {} })
    assert.equal((await p2).text, 'B')
  })
})

describe('TurnDriver — failure modes', () => {
  it('rejects TURN_ERROR on a session error event (with partialText)', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p = driver.driveTurn('s1', 'go')
    sm.ev('s1', 'stream_delta', { messageId: 'm1', delta: 'partial' })
    sm.ev('s1', 'error', { message: 'boom' })
    const e = await p.then(() => null, (err) => err)
    assert.ok(e instanceof TurnError)
    assert.equal(e.code, 'TURN_ERROR')
    assert.equal(e.partialText, 'partial')
  })

  it('rejects SESSION_GONE when the session is destroyed mid-turn', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p = driver.driveTurn('s1', 'go')
    sm.destroy('s1')
    const e = await p.then(() => null, (err) => err)
    assert.equal(e.code, 'SESSION_GONE')
  })

  it('rejects SEND_FAILED when sendMessage rejects', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1', { sendImpl: () => Promise.reject(new Error('socket closing')) })
    driver = new TurnDriver({ sessionManager: sm })
    const e = await driver.driveTurn('s1', 'go').then(() => null, (err) => err)
    assert.equal(e.code, 'SEND_FAILED')
  })

  it('rejects TURN_TIMEOUT and interrupts the session', async () => {
    const { sm, addSession } = mkStub()
    const s = addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const e = await driver.driveTurn('s1', 'go', { timeoutMs: 10 }).then(() => null, (err) => err)
    assert.equal(e.code, 'TURN_TIMEOUT')
    assert.equal(s.interrupted, 1)
  })

  it('throws SESSION_GONE synchronously for an unknown session', async () => {
    const { sm } = mkStub()
    driver = new TurnDriver({ sessionManager: sm })
    const e = await driver.driveTurn('nope', 'go').then(() => null, (err) => err)
    assert.equal(e.code, 'SESSION_GONE')
  })
})
