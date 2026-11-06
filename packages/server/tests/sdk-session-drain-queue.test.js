import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'

/**
 * #8321 — a follow-up sent between a turn's `result` and the end of its query
 * generator waits in the outgoing queue and runs after that query has ended.
 *
 * Busy state ends at the prompt's `result`, but the CLI only exits once stdin
 * closes, so the per-turn generator can outlive it. Before the fix a send in
 * that window started a second `query()` while the first process was alive,
 * both resuming the same conversation.
 */

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'sdk-drain-queue-test-'))
  return join(_tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => {
  if (_tmp) rmSync(_tmp, { recursive: true, force: true })
})

async function until(cond, ms = 2000) {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('until: condition not met before the deadline')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const init = (sid = 'sdk-1') => ({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-x', tools: [] })
const promptResult = { type: 'result', subtype: 'success', session_id: 'sdk-1', is_error: false, duration_ms: 5, num_turns: 1, total_cost_usd: 0.01, usage: {} }

/**
 * A harness whose queries are scripted per call. Each query yields `init` and
 * the result, then runs its `linger` step (the drain) and ends. `live` counts
 * generators that have started and not yet ended; `maxLive` is the overlap the
 * bug is about.
 */
function harness(session, plans) {
  const h = { calls: [], live: 0, maxLive: 0, ended: [], order: [], queries: [], queryAtCall: [] }
  session._callQuery = (args) => {
    const index = h.calls.length
    const plan = plans[index] || {}
    h.calls.push(args)
    h.queryAtCall.push(session._query)
    if (plan.onCall) plan.onCall()
    h.order.push(`start-${index}`)
    h.live++
    h.maxLive = Math.max(h.maxLive, h.live)
    let closed = false
    let wake = null
    const ctx = { isClosed: () => closed, onClose: (fn) => { wake = fn } }
    const gen = (async function* () {
      try {
        yield init()
        if (plan.hangBeforeResult) await plan.hangBeforeResult(ctx)
        yield promptResult
        if (plan.linger) await plan.linger(ctx)
        if (plan.throwAfterResult) throw plan.throwAfterResult
      } finally {
        h.live--
        h.ended.push(index)
        h.order.push(`end-${index}`)
      }
    })()
    const query = {
      [Symbol.asyncIterator]() { return gen },
      interrupt: async () => { h.interrupts = (h.interrupts || 0) + 1 },
      close: () => {
        h.closeCalls = (h.closeCalls || 0) + 1
        if (plan.closeIneffective) return
        closed = true
        if (wake) wake(true)
      },
    }
    h.queries.push(query)
    return query
  }
  return h
}

/** A linger that ends when released by the test or when the query is closed. */
function gatedLinger({ abortOnClose = false } = {}) {
  let release
  let fail
  const gate = new Promise((resolve, reject) => { release = resolve; fail = reject })
  const linger = async ({ onClose }) => {
    // close() ends the wait quietly, or the way the SDK does: an AbortError.
    onClose(() => {
      if (!abortOnClose) return release()
      const err = new Error('Query was aborted')
      err.name = 'AbortError'
      fail(err)
    })
    await gate
  }
  return { linger, release }
}

function capture(session) {
  const events = []
  for (const name of ['stream_start', 'stream_end', 'result', 'error', 'message_queued', 'message_dequeued', 'stopped']) {
    session.on(name, (d) => events.push({ name, ...d }))
  }
  return events
}

describe('SdkSession follow-up during a draining query (#8321)', () => {
  let session
  const defaults = { wait: SdkSession.DRAIN_WAIT_MS, grace: SdkSession.DRAIN_FORCE_GRACE_MS }
  beforeEach(() => {
    session = new SdkSession({ cwd: '/tmp', stateFilePath: tmpStateFile() })
    session._fetchSupportedModels = () => {}
  })
  afterEach(() => {
    SdkSession.DRAIN_WAIT_MS = defaults.wait
    SdkSession.DRAIN_FORCE_GRACE_MS = defaults.grace
    session.destroy()
  })

  it('queues a send made after the result and runs it only once the previous query has ended', async () => {
    const { linger, release } = gatedLinger()
    const h = harness(session, [{ linger }, {}])
    const events = capture(session)
    let busyDuringDrain = null
    session.once('result', () => {
      // The result's listeners run before the loop reaches the lingering step.
      setImmediate(() => {
        busyDuringDrain = session._isBusy
        session.sendMessage('B')
      })
    })
    const aDone = session.sendMessage('A')
    await until(() => h.calls.length === 1 && events.some((e) => e.name === 'message_queued'))
    assert.equal(busyDuringDrain, false, 'precondition: busy had cleared while the generator still drains')
    assert.equal(h.calls.length, 1, 'the follow-up did not start a second query() while the first drains')
    assert.equal(h.live, 1)
    release()
    await aDone
    await until(() => h.ended.length === 2 && !session._isBusy && session._drainingTurn === null)
    assert.equal(h.maxLive, 1, 'never two live queries at once')
    assert.deepEqual(h.order, ['start-0', 'end-0', 'start-1', 'end-1'])
    assert.equal(events.filter((e) => e.name === 'result').length, 2, 'both turns completed')
    // Echoed once: one queued bubble in, one flush out, no duplicate dispatch.
    assert.equal(events.filter((e) => e.name === 'message_queued').length, 1)
    const dequeued = events.filter((e) => e.name === 'message_dequeued')
    assert.equal(dequeued.length, 1)
    assert.equal(dequeued[0].reason, 'flush')
    assert.equal(h.calls.length, 2)
  })

  it('runs several follow-ups in order, each after the previous query ended', async () => {
    const { linger, release } = gatedLinger()
    const h = harness(session, [{ linger }, {}, {}])
    session.once('result', () => {
      setImmediate(() => {
        session.sendMessage('B')
        session.sendMessage('C')
      })
    })
    const aDone = session.sendMessage('A')
    await until(() => session._outgoingQueue.length === 2)
    assert.equal(h.calls.length, 1)
    release()
    await aDone
    await until(() => h.ended.length === 3 && !session._isBusy)
    assert.equal(h.maxLive, 1)
    assert.deepEqual(h.order, ['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2'])
    const texts = []
    for (const call of h.calls.slice(1)) {
      for await (const m of call.prompt) texts.push(m.message.content[0].text)
    }
    assert.deepEqual(texts, ['B', 'C'], 'queued in arrival order, nothing dropped or duplicated')
  })

  it('still runs the queued follow-up when the draining query throws', async () => {
    const { linger, release } = gatedLinger()
    const h = harness(session, [{ linger, throwAfterResult: new Error('socket hang up') }, {}])
    const events = capture(session)
    session.once('result', () => { setImmediate(() => session.sendMessage('B')) })
    const aDone = session.sendMessage('A')
    await until(() => session._outgoingQueue.length === 1)
    release()
    await aDone
    await until(() => h.ended.length === 2 && !session._isBusy)
    assert.deepEqual(h.order, ['start-0', 'end-0', 'start-1', 'end-1'])
    assert.equal(events.filter((e) => e.name === 'result').length, 2)
  })

  it('an interrupt during the drain cancels the queued follow-up instead of running it', async () => {
    const { linger, release } = gatedLinger()
    const h = harness(session, [{ linger }, {}])
    const events = capture(session)
    session.once('result', () => { setImmediate(() => session.sendMessage('B')) })
    const aDone = session.sendMessage('A')
    await until(() => session._outgoingQueue.length === 1)
    await session.interrupt()
    assert.equal(session._outgoingQueue.length, 0)
    const dequeued = events.filter((e) => e.name === 'message_dequeued')
    assert.deepEqual(dequeued.map((e) => e.reason), ['interrupted'])
    release()
    await aDone
    await until(() => session._drainingTurn === null)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(h.calls.length, 1, 'the cancelled follow-up never started a query')
    // The session is usable again afterwards.
    const h2 = harness(session, [{}])
    await session.sendMessage('C')
    assert.equal(h2.calls.length, 1)
  })

  it('destroy while a follow-up is queued drops it silently and starts nothing', async () => {
    const { linger } = gatedLinger()
    const h = harness(session, [{ linger }, {}])
    const events = capture(session)
    session.once('result', () => { setImmediate(() => session.sendMessage('B')) })
    session.sendMessage('A')
    await until(() => session._outgoingQueue.length === 1)
    session.destroy()
    assert.equal(session._drainingTurn, null, 'the drain timers are gone with the session')
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(h.calls.length, 1)
    assert.equal(events.filter((e) => e.name === 'message_dequeued').length, 0)
  })

  it('a stream stall abandons the query, so the retry runs at once instead of waiting behind it', async () => {
    let releaseA
    const hang = new Promise((r) => { releaseA = r })
    const h = harness(session, [{ hangBeforeResult: () => hang }, {}])
    const events = capture(session)
    const aDone = session.sendMessage('A')
    await until(() => h.calls.length === 1)
    session._handleStreamStall(session._currentMessageId, false)
    await session.sendMessage('B')
    assert.equal(h.calls.length, 2, 'the retry started without waiting for the stalled query')
    assert.equal(events.filter((e) => e.name === 'message_queued').length, 0)
    releaseA()
    await aDone
    await until(() => !session._isBusy && h.ended.length === 2)
  })

  it('closing the draining query is not reported as a turn error (AbortError on close)', async () => {
    SdkSession.DRAIN_WAIT_MS = 20
    SdkSession.DRAIN_FORCE_GRACE_MS = 1000
    const { linger } = gatedLinger({ abortOnClose: true })
    const h = harness(session, [{ linger }, {}])
    const events = capture(session)
    session.once('result', () => { setImmediate(() => session.sendMessage('B')) })
    const aDone = session.sendMessage('A')
    await aDone
    await until(() => h.ended.length === 2 && !session._isBusy)
    assert.equal(h.closeCalls, 1)
    assert.deepEqual(events.filter((e) => e.name === 'error').map((e) => e.message), [], 'no false error for a turn that succeeded')
    assert.equal(events.filter((e) => e.name === 'result').length, 2)
  })

  describe('when the wait starts', () => {
    it('never closes a lingering query nothing is waiting behind', async () => {
      SdkSession.DRAIN_WAIT_MS = 100
      SdkSession.DRAIN_FORCE_GRACE_MS = 20
      const { linger, release } = gatedLinger()
      const h = harness(session, [{ linger }])
      const aDone = session.sendMessage('A')
      await until(() => session._isBusy === false && session._drainingTurn !== null)
      assert.equal(session._drainingTurn.waitTimer, null, 'no clock runs with nothing queued')
      await new Promise((r) => setTimeout(r, 250))
      assert.equal(h.closeCalls, undefined, 'idle lingering query is left alone')
      assert.equal(session._drainingTurn.waitTimer, null)
      release()
      await aDone
    })

    it('starts at the busy-clear when a message was already queued mid-turn', async () => {
      SdkSession.DRAIN_WAIT_MS = 20
      SdkSession.DRAIN_FORCE_GRACE_MS = 1000
      const { linger } = gatedLinger()
      const h = harness(session, [{ linger, hangBeforeResult: () => { session.sendMessage('B') } }, {}])
      await session.sendMessage('A')
      await until(() => h.ended.length === 2 && !session._isBusy)
      assert.equal(h.closeCalls, 1)
      assert.deepEqual(h.order, ['start-0', 'end-0', 'start-1', 'end-1'])
    })

    it('starts at query creation when busy had cleared and a message already waits', async () => {
      SdkSession.DRAIN_WAIT_MS = 20
      SdkSession.DRAIN_FORCE_GRACE_MS = 1000
      const { linger: hang } = gatedLinger()
      const h = harness(session, [{
        onCall: () => { session._isBusy = false; session.enqueueOutgoingMessage({ prompt: 'B' }) },
        hangBeforeResult: hang,
      }, {}])
      session.sendMessage('A')
      await until(() => h.closeCalls === 1)
      await until(() => h.ended.length >= 1)
    })

    it('does not close the query if the waiting message is gone when the wait ends', async () => {
      SdkSession.DRAIN_WAIT_MS = 40
      SdkSession.DRAIN_FORCE_GRACE_MS = 1000
      const { linger, release } = gatedLinger()
      const h = harness(session, [{ linger }, {}])
      session.once('result', () => { setImmediate(() => session.sendMessage('B')) })
      const aDone = session.sendMessage('A')
      await until(() => session._outgoingQueue.length === 1)
      await session.interrupt()
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(h.closeCalls, undefined)
      release()
      await aDone
    })
  })

  describe('a late loop after a force release', () => {
    it('leaves the successor\'s query handle and drain alone when the old generator finally ends', async () => {
      SdkSession.DRAIN_WAIT_MS = 20
      SdkSession.DRAIN_FORCE_GRACE_MS = 20
      const a = gatedLinger()
      const b = gatedLinger()
      const h = harness(session, [{ linger: a.linger, closeIneffective: true }, { linger: b.linger }])
      session.once('result', () => { setImmediate(() => session.sendMessage('B')) })
      const aDone = session.sendMessage('A')
      // B starts by force release and reaches its own drain (result emitted, generator lingering).
      await until(() => h.calls.length === 2 && session._isBusy === false && session._drainingTurn?.query === h.queries[1])
      assert.equal(h.queryAtCall[1], null, 'the released query handle was dropped before B started')
      assert.equal(h.ended.includes(0), false, 'precondition: A\'s generator is still alive')
      a.release()
      await aDone
      assert.equal(h.ended.includes(0), true)
      assert.equal(session._query, h.queries[1], 'A\'s late finally kept B\'s handle')
      assert.equal(session._drainingTurn?.query, h.queries[1], 'and B\'s drain')
      b.release()
      await until(() => session._drainingTurn === null && session._query === null)
    })
  })

  it('a hard timeout abandons the query, so the retry runs at once', async () => {
    let releaseA
    const hang = new Promise((r) => { releaseA = r })
    const h = harness(session, [{ hangBeforeResult: () => hang }, {}])
    const events = capture(session)
    const aDone = session.sendMessage('A')
    await until(() => h.calls.length === 1)
    session._handleHardTimeout(session._currentMessageId, false)
    await session.sendMessage('B')
    assert.equal(h.calls.length, 2)
    assert.equal(events.filter((e) => e.name === 'message_queued').length, 0)
    releaseA()
    await aDone
    await until(() => !session._isBusy && h.ended.length === 2)
  })

  it('destroy clears both drain timers, including a close already issued', async () => {
    SdkSession.DRAIN_WAIT_MS = 20
    SdkSession.DRAIN_FORCE_GRACE_MS = 40
    const { linger } = gatedLinger()
    const h = harness(session, [{ linger, closeIneffective: true }, {}])
    session.once('result', () => { setImmediate(() => session.sendMessage('B')) })
    session.sendMessage('A')
    await until(() => session._drainingTurn?.forceTimer)
    const drain = session._drainingTurn
    session.destroy()
    assert.equal(drain.waitTimer, null)
    assert.equal(drain.forceTimer, null)
    assert.equal(session._drainingTurn, null)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(h.calls.length, 1, 'the force release did not run after destroy')
  })

  describe('a drain has an end', () => {
    it('closes a query that keeps draining, then runs the follow-up when it ends', async () => {
      SdkSession.DRAIN_WAIT_MS = 30
      SdkSession.DRAIN_FORCE_GRACE_MS = 1000
      const { linger } = gatedLinger() // only close() ends it
      const h = harness(session, [{ linger }, {}])
      session.once('result', () => { setImmediate(() => session.sendMessage('B')) })
      const aDone = session.sendMessage('A')
      await until(() => session._outgoingQueue.length === 1)
      assert.equal(h.closeCalls, undefined, 'not closed before the wait elapses')
      await aDone
      await until(() => h.ended.length === 2 && !session._isBusy)
      assert.equal(h.closeCalls, 1)
      assert.deepEqual(h.order, ['start-0', 'end-0', 'start-1', 'end-1'])
    })

    it('releases the follow-up even when closing the query does not end it', async () => {
      SdkSession.DRAIN_WAIT_MS = 20
      SdkSession.DRAIN_FORCE_GRACE_MS = 20
      const { linger, release } = gatedLinger()
      const h = harness(session, [{ linger, closeIneffective: true }, {}])
      session.once('result', () => { setImmediate(() => session.sendMessage('B')) })
      const aDone = session.sendMessage('A')
      await until(() => h.calls.length === 2)
      assert.equal(h.closeCalls, 1, 'the stuck query was closed first')
      await until(() => h.ended.includes(1) && !session._isBusy)
      assert.equal(h.ended.includes(0), false, 'the stuck generator never ended, yet the session moved on')
      // The late end of the old loop must not disturb the session.
      release()
      await aDone
      assert.equal(session._isBusy, false)
      assert.equal(session._query, null)
      assert.equal(session._drainingTurn, null)
    })
  })
})
