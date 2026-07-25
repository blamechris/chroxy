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
  // destroy: remove from the map (so getSession re-fetch fails) AND emit the event
  sm.destroy = (id) => { sessions.delete(id); sm.emit('session_destroyed', { sessionId: id }) }
  return { sm, addSession }
}

let driver
afterEach(() => { driver?.dispose(); driver = null })

// Race a turn's own settlement against a short wall-clock timer. `kind` is
// 'pending' ONLY if the driver left the promise hanging.
const settleOrPending = (p, ms = 100) => Promise.race([
  p.then((value) => ({ kind: 'resolved', value }), (err) => ({ kind: 'rejected', err })),
  new Promise((r) => setTimeout(() => r({ kind: 'pending' }), ms)),
])

// Let the event loop turn over once: the driver hands the per-session mutex to a
// queued turn across a process.nextTick boundary (see _scheduleNext), so a test
// that inspects "did the next turn start?" must yield first.
const flush = () => new Promise((r) => setImmediate(r))

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

  it('forwards the full terminal usage payload (modelUsage/model/numTurns/apiDurationMs)', async () => {
    // #6692: per-model attribution must survive the turn-driver, or the ledger
    // collapses every metered run to a single unknown model.
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p = driver.driveTurn('s1', 'go')
    sm.ev('s1', 'result', {
      cost: 0.2,
      duration: 10,
      usage: { input_tokens: 5 },
      model: 'haiku',
      modelUsage: { haiku: { input_tokens: 5, output_tokens: 2 } },
      num_turns: 3, // snake_case from the wire — driver reads camelCase numTurns
      numTurns: 3,
      apiDurationMs: 8,
    })
    const { result } = await p
    assert.equal(result.model, 'haiku')
    assert.deepEqual(result.modelUsage, { haiku: { input_tokens: 5, output_tokens: 2 } })
    assert.equal(result.numTurns, 3)
    assert.equal(result.apiDurationMs, 8)
  })

  it('coerces missing/non-finite metadata fields to null', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p = driver.driveTurn('s1', 'go')
    sm.ev('s1', 'result', { cost: 0, duration: 1, usage: {} }) // no model/modelUsage/turns
    const { result } = await p
    assert.equal(result.model, null)
    assert.equal(result.modelUsage, null)
    assert.equal(result.numTurns, null)
    assert.equal(result.apiDurationMs, null)
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
    // now the second turn runs (one tick later — the handoff never happens inside
    // the frame that released the mutex; see _scheduleNext)
    await flush()
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

  it('a queued turn rejects SESSION_GONE if its session is destroyed while waiting', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p1 = driver.driveTurn('s1', 'first')
    const p2 = driver.driveTurn('s1', 'second') // queued behind the mutex
    // destroy the session — turn-1 rejects; turn-2 re-fetches at start and finds it gone
    sm.destroy('s1')
    const e1 = await p1.then(() => null, (err) => err)
    const e2 = await p2.then(() => null, (err) => err)
    assert.equal(e1.code, 'SESSION_GONE')
    assert.equal(e2.code, 'SESSION_GONE', 'queued turn re-validates the session at start time')
  })

  it('dispose() rejects a turn queued behind the mutex (no hang)', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p1 = driver.driveTurn('s1', 'first')
    const p2 = driver.driveTurn('s1', 'second') // queued behind the mutex
    driver.dispose()
    driver = null // afterEach won't double-dispose
    const e1 = await p1.then(() => null, (err) => err)
    const e2 = await p2.then(() => null, (err) => err)
    assert.equal(e1.code, 'SESSION_GONE')
    assert.equal(e2.code, 'SESSION_GONE', 'queued turn settled, not left hanging')
  })
})

describe('TurnDriver — interrupt (`stopped`) is terminal (#7009)', () => {
  it('rejects TURN_STOPPED promptly on interrupt instead of waiting out timeoutMs', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    // A LONG turn timeout: if `stopped` is not terminal for a live turn, this
    // promise stays pending for the whole window (#7009 — 15 min in the
    // scheduler), and the race below reports 'pending'.
    const p = driver.driveTurn('s1', 'go', { timeoutMs: 60_000 })
    p.catch(() => {}) // never leave the rejection unhandled while we race it
    sm.ev('s1', 'stream_delta', { messageId: 'm1', delta: 'half a thought' })
    // SdkSession.interrupt() emits `stopped` — deliberately NOT `result` and NOT
    // `error` (sdk-session.js, #4881). Same for CliSession/JsonlSubprocessSession
    // and the Codex app-server driver: every `stopped` emit is gated on
    // wasIntentionalStop, so `stopped` always means "the user/engine stopped it".
    sm.ev('s1', 'stopped', {})
    const outcome = await settleOrPending(p)
    assert.notEqual(outcome.kind, 'pending', 'an interrupted turn must settle promptly, not wait out timeoutMs')
    // The success/interrupt distinction: an interrupted turn must NEVER look like
    // a completed one to the caller.
    assert.notEqual(outcome.kind, 'resolved', 'an interrupted turn must never report a completed turn')
    assert.ok(outcome.err instanceof TurnError)
    assert.equal(outcome.err.code, 'TURN_STOPPED', 'interrupt gets its OWN code, distinct from TURN_TIMEOUT/TURN_ERROR')
    assert.equal(outcome.err.partialText, 'half a thought', 'partial output is preserved for the caller')
  })

  it('releases the mutex on a stopped turn so the next queued turn starts', async () => {
    const { sm, addSession } = mkStub()
    const s = addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p1 = driver.driveTurn('s1', 'first', { timeoutMs: 60_000 })
    p1.catch(() => {})
    const p2 = driver.driveTurn('s1', 'second', { timeoutMs: 60_000 })
    assert.equal(s.sent.length, 1)
    sm.ev('s1', 'stopped', {})
    const o1 = await settleOrPending(p1)
    assert.equal(o1.kind, 'rejected')
    assert.equal(o1.err.code, 'TURN_STOPPED')
    // the concurrency slot is free again — turn-2 sent without waiting on a drain
    await flush()
    assert.equal(s.sent.length, 2, 'stopped turn released the per-session mutex')
    assert.equal(s.sent[1].prompt, 'second')
    sm.ev('s1', 'result', { cost: 3, duration: 3, usage: {} })
    const o2 = await settleOrPending(p2)
    assert.equal(o2.kind, 'resolved', 'the follow-up turn still completes normally')
    assert.equal(o2.value.result.cost, 3)
  })

  it('a completed turn still resolves success even if a trailing `stopped` arrives (nothing queued)', async () => {
    // The inverse guard: making `stopped` terminal must not downgrade a turn that
    // genuinely finished. `result` settles first; the late `stopped` is dropped by
    // the epoch guard. NOTE: this is the NO-QUEUED-TURN variant — the queued-turn
    // variant, where the epoch guard only holds because the mutex handoff is
    // deferred, is covered in its own describe block below.
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p = driver.driveTurn('s1', 'go', { timeoutMs: 60_000 })
    sm.ev('s1', 'stream_delta', { messageId: 'm1', delta: 'all done' })
    sm.ev('s1', 'result', { cost: 0.5, duration: 4, usage: { input_tokens: 1 } })
    sm.ev('s1', 'stopped', {})
    const outcome = await settleOrPending(p)
    assert.equal(outcome.kind, 'resolved', 'a genuinely completed turn reports success')
    assert.equal(outcome.value.text, 'all done')
    assert.equal(outcome.value.result.cost, 0.5)
  })

  it('`stopped` during the post-timeout drain still only ends the drain', async () => {
    // Regression guard on the pre-existing drain path: a timed-out turn is already
    // settled as TURN_TIMEOUT, and its trailing `stopped` must not be re-settled
    // as TURN_STOPPED — it just releases the mutex.
    const { sm, addSession } = mkStub()
    const s = addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p1 = driver.driveTurn('s1', 'first', { timeoutMs: 10 })
    const p2 = driver.driveTurn('s1', 'second', { timeoutMs: 60_000 })
    p2.catch(() => {})
    const o1 = await settleOrPending(p1, 500)
    assert.equal(o1.kind, 'rejected')
    assert.equal(o1.err.code, 'TURN_TIMEOUT', 'timeout keeps its own code, not TURN_STOPPED')
    assert.equal(s.interrupted, 1)
    sm.ev('s1', 'stopped', {}) // the interrupted session confirming it stopped
    await flush()
    assert.equal(s.sent.length, 2, 'trailing stopped ended the drain and released the mutex')
  })
})

describe('TurnDriver — a settled turn\'s trailing events never reach the QUEUED turn', () => {
  // The #6723 cross-turn-misattribution class, through the door the post-timeout
  // drain does not cover: it is the `result`/`error`/`stopped` path that releases
  // the mutex. Every provider emits a turn's terminal events from ONE synchronous
  // frame, so starting the queued turn synchronously on the first of them handed
  // the REST of that frame to the wrong turn.

  it('a trailing `stopped` after a real `result` does not settle the next queued turn', async () => {
    // Replays CliSession._handleChildClose's real emit order on an intentional
    // stop (cli-session.js ~1646/1654): _emitInterruptedTurnResult() emits
    // `stream_end` + a synthetic `result`, THEN emit('stopped', { code }) — all in
    // one synchronous frame. With the handoff running inside that frame, turn-2's
    // prompt was already sent and the trailing `stopped` then rejected it
    // TURN_STOPPED, abandoning a turn the provider is actively working on.
    const { sm, addSession } = mkStub()
    const s = addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p1 = driver.driveTurn('s1', 'first', { timeoutMs: 60_000 })
    const p2 = driver.driveTurn('s1', 'second', { timeoutMs: 60_000 })
    p1.catch(() => {})
    p2.catch(() => {})
    assert.equal(s.sent.length, 1, 'turn-2 starts queued behind the mutex')

    sm.ev('s1', 'stream_delta', { messageId: 'm1', delta: 'turn-1 output' })
    sm.ev('s1', 'stream_end', { messageId: 'm1' })
    sm.ev('s1', 'result', { cost: 0.5, duration: 4, usage: { input_tokens: 1 } })
    sm.ev('s1', 'stopped', { code: 130 })

    // turn-1 completed — assert that POSITIVELY (resolved + its own payload),
    // never by absence of an error.
    const o1 = await settleOrPending(p1)
    assert.equal(o1.kind, 'resolved', 'turn-1 finished on its own result')
    assert.equal(o1.value.text, 'turn-1 output')
    assert.equal(o1.value.result.cost, 0.5)

    // turn-2 must be neither settled nor abandoned by turn-1's trailing stop.
    await flush()
    assert.equal(s.sent.length, 2, 'turn-2 got its prompt')
    assert.equal(s.sent[1].prompt, 'second')
    const early = await settleOrPending(p2, 50)
    assert.equal(early.kind, 'pending', 'a previous turn\'s `stopped` must not settle turn-2')

    sm.ev('s1', 'stream_delta', { messageId: 'm2', delta: 'turn-2 output' })
    sm.ev('s1', 'result', { cost: 2, duration: 2, usage: {} })
    const o2 = await settleOrPending(p2)
    assert.equal(o2.kind, 'resolved', 'turn-2 ran to completion')
    assert.equal(o2.value.text, 'turn-2 output', 'turn-2 kept its own output')
    assert.equal(o2.value.result.cost, 2, 'turn-2 kept its own result payload')
  })

  it('a trailing `error` after a synthetic `result` does not settle the next queued turn', async () => {
    // Same frame shape, different tail: CliSession._handleHardTimeout and
    // _handleStreamStall both call _emitInterruptedTurnResult() (→ `stream_end` +
    // `result`) and THEN emit('error', …) synchronously (cli-session.js ~877/894).
    const { sm, addSession } = mkStub()
    const s = addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p1 = driver.driveTurn('s1', 'first', { timeoutMs: 60_000 })
    const p2 = driver.driveTurn('s1', 'second', { timeoutMs: 60_000 })
    p1.catch(() => {})
    p2.catch(() => {})

    sm.ev('s1', 'stream_end', { messageId: 'm1' })
    sm.ev('s1', 'result', { cost: null, duration: 0, usage: null })
    sm.ev('s1', 'error', { message: 'Response timed out after 15m' })

    const o1 = await settleOrPending(p1)
    assert.equal(o1.kind, 'resolved', 'turn-1 settled on the result that arrived first')
    await flush()
    assert.equal(s.sent.length, 2, 'turn-2 got its prompt')
    const early = await settleOrPending(p2, 50)
    assert.equal(early.kind, 'pending', 'a previous turn\'s `error` must not fail turn-2')

    sm.ev('s1', 'result', { cost: 1, duration: 1, usage: {} })
    const o2 = await settleOrPending(p2)
    assert.equal(o2.kind, 'resolved', 'turn-2 settles only on its OWN result')
    assert.equal(o2.value.result.cost, 1)
  })

  it('turn-1\'s late trailing events cannot settle turn-2 (duplicate `stopped` + late `result`)', async () => {
    // turn-1 is genuinely interrupted, so `stopped` settles it. Anything the
    // provider still emits in that frame belongs to turn-1: a duplicate `stopped`
    // must not reject turn-2, and a late `result` must not resolve turn-2 as a
    // success carrying turn-1's payload.
    const { sm, addSession } = mkStub()
    const s = addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const p1 = driver.driveTurn('s1', 'first', { timeoutMs: 60_000 })
    const p2 = driver.driveTurn('s1', 'second', { timeoutMs: 60_000 })
    p1.catch(() => {})
    p2.catch(() => {})

    sm.ev('s1', 'stopped', {})
    sm.ev('s1', 'stopped', {})
    sm.ev('s1', 'result', { cost: 99, duration: 99, usage: { input_tokens: 999 } })

    const o1 = await settleOrPending(p1)
    assert.equal(o1.kind, 'rejected')
    assert.equal(o1.err.code, 'TURN_STOPPED', 'turn-1 kept the interrupt outcome')
    await flush()
    assert.equal(s.sent.length, 2, 'turn-2 got its prompt')
    const early = await settleOrPending(p2, 50)
    assert.equal(early.kind, 'pending', 'turn-1\'s trailing events must not settle turn-2')

    sm.ev('s1', 'result', { cost: 7, duration: 7, usage: {} })
    const o2 = await settleOrPending(p2)
    assert.equal(o2.kind, 'resolved', 'turn-2 settles only on its OWN result')
    assert.equal(o2.value.result.cost, 7, 'turn-2 did not absorb turn-1\'s result payload')
  })

  it('a third turn queued behind two still runs (one handoff per release)', async () => {
    // Guard on the deferred handoff itself: exactly ONE queued turn may be started
    // per release. A double-scheduled handoff would shift two waiters off the FIFO
    // and run them concurrently, breaking the per-session mutex.
    const { sm, addSession } = mkStub()
    const s = addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    const ps = ['a', 'b', 'c'].map((n) => driver.driveTurn('s1', n, { timeoutMs: 60_000 }))
    for (const p of ps) p.catch(() => {})
    assert.equal(s.sent.length, 1)
    for (const [i, prompt] of ['a', 'b', 'c'].entries()) {
      await flush()
      assert.equal(s.sent.length, i + 1, `only turn ${prompt} is in flight`)
      assert.equal(s.sent[i].prompt, prompt)
      sm.ev('s1', 'result', { cost: i, duration: 1, usage: {} })
      const o = await settleOrPending(ps[i])
      assert.equal(o.kind, 'resolved', `turn ${prompt} completed`)
      assert.equal(o.value.result.cost, i)
    }
  })
})

describe('TurnDriver — post-timeout drain (no cross-turn misattribution)', () => {
  it('swallows a timed-out turn\'s trailing events; the next turn keeps its own', async () => {
    const { sm, addSession } = mkStub()
    addSession('s1')
    driver = new TurnDriver({ sessionManager: sm })
    // turn-1 times out fast → interrupt + drain (mutex held)
    const p1 = driver.driveTurn('s1', 'first', { timeoutMs: 10 })
    const p2 = driver.driveTurn('s1', 'second') // queued behind the drain
    const e1 = await p1.then(() => null, (err) => err)
    assert.equal(e1.code, 'TURN_TIMEOUT')
    // turn-1's LATE trailing output arrives after the timeout — must be swallowed
    sm.ev('s1', 'stream_delta', { messageId: 'm1', delta: 'STALE-from-turn-1' })
    sm.ev('s1', 'result', { cost: 99, duration: 99, usage: { input_tokens: 999 } }) // ends the drain
    // now turn-2 runs and gets ITS output
    await flush()
    sm.ev('s1', 'stream_delta', { messageId: 'm2', delta: 'fresh-turn-2' })
    sm.ev('s1', 'result', { cost: 2, duration: 2, usage: { input_tokens: 2 } })
    const r2 = await p2
    assert.equal(r2.text, 'fresh-turn-2', 'turn-2 did not absorb turn-1 stale delta')
    assert.equal(r2.result.cost, 2, 'turn-2 did not absorb turn-1 stale result')
  })
})
