import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { createSpy, nsCtx, makeSessionIndexCtx } from './test-helpers.js'

const handler = conversationHandlers.request_conversation_transcript

const CONV_ID = '00000000-0000-0000-0000-0000000c0ffe'
const CONV_CWD = '/tmp/repo'

/** An OPEN, never-congested socket — the common case. */
function makeOpenWs() {
  return { readyState: 1, bufferedAmount: 0 }
}

/**
 * A ws stub whose `bufferedAmount` grows by the wire size of every payload
 * written and only falls when the simulated peer acknowledges — i.e. what the
 * real socket reports between event-loop turns. The same fixture the #4833
 * `replayHistory` tests and the #7460 `request_full_history` tests use, because
 * this is the THIRD path through the same loop and must behave identically
 * under the same pressure.
 */
function makeBackpressuredWs(readyState = 1) {
  const ws = {
    readyState,
    bufferedAmount: 0,
    send(data) {
      ws.bufferedAmount += Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data))
    },
    close() { ws._closed = true },
    drain(bytes) { ws.bufferedAmount = Math.max(0, ws.bufferedAmount - bytes) },
    drainAll() { ws.bufferedAmount = 0 },
  }
  return ws
}

function build(transcript, { ws = makeOpenWs() } = {}) {
  const sends = []
  const reseeds = []
  const ctx = nsCtx({
    send: createSpy((target, msg) => {
      sends.push(msg)
      // Feed the byte stream back into the stub so the back-pressure gate sees
      // a real, growing bufferedAmount. A no-op on the plain open-ws stub,
      // which has no send() — that one models a socket that never congests.
      if (target && typeof target.send === 'function' && target.readyState === 1) {
        target.send(JSON.stringify(msg))
      }
    }),
    ...makeSessionIndexCtx(),
    reseedActiveAgents: createSpy((_ws, sid) => reseeds.push(sid)),
    scanConversations: createSpy(async () => [{ conversationId: CONV_ID, cwd: CONV_CWD }]),
    readConversationTranscript: createSpy(async () => transcript),
    sessionManager: {
      getSession: createSpy(() => undefined),
      createSession: createSpy(() => 'new-id'),
    },
  })
  return { ctx, sends, ws, reseeds }
}

const client = () => ({ id: 'c1', activeSessionId: 'live-1', subscribedSessionIds: new Set() })

const request = () => ({ type: 'request_conversation_transcript', conversationId: CONV_ID })

/** Yield the event loop `n` times so setImmediate-scheduled chunks can run. */
async function turn(n = 5) {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r))
}

function fatTranscript(count = 30, payloadBytes = 200 * 1024) {
  const bigText = 'x'.repeat(payloadBytes)
  return Array.from({ length: count }, (_, i) => ({
    type: 'tool_use',
    tool: 'Bash',
    content: bigText,
    timestamp: i + 1,
  }))
}

/**
 * #7480 — the read-only transcript endpoint was the THIRD hand-rolled send loop
 * of the #4833 family, and like `handleRequestFullHistory` before #7460 it had
 * no `ws.bufferedAmount` check anywhere: it pushed the entire JSONL transcript
 * onto the socket in one turn of the event loop. `MAX_TRANSCRIPT_BYTES` caps the
 * transcript, not how much of it is buffered on the socket at once, so a large
 * transcript on a slow link could still sail past the 1MB EVICT_THRESHOLD in
 * ws-client-sender.js — which CLOSES the client.
 */
describe('#7480 — request_conversation_transcript sends under the shared chunk + bufferedAmount gate (#4833)', () => {
  it('pauses mid-chunk once bufferedAmount crosses the threshold instead of draining the whole transcript', async () => {
    // 30 x 200KB = 6MB. Pre-fix the loop pushed all of it onto the socket in
    // one synchronous burst, far past the 1MB eviction line.
    const ENTRY_COUNT = 30
    const ws = makeBackpressuredWs()
    const { ctx, sends, reseeds } = build(fatTranscript(ENTRY_COUNT), { ws })

    await handler(ws, client(), request(), ctx)
    // The peer never acknowledges, so the loop must stay parked.
    await turn(5)

    assert.ok(sends.some(m => m.type === 'history_replay_start'), 'the start frame precedes the gate, as in replayHistory')
    const replayed = sends.filter(m => m.type === 'message').length
    assert.ok(
      replayed > 0 && replayed < ENTRY_COUNT,
      `expected the loop to stall part-way while bufferedAmount stays above the pause threshold; got ${replayed}/${ENTRY_COUNT}`,
    )
    assert.equal(sends.find(m => m.type === 'history_replay_end'), undefined,
      'history_replay_end must not be sent while the socket is congested')
    assert.deepEqual(reseeds, [], 'the #7340 re-seed follows the end frame, so a stalled replay has not re-seeded either')

    ws.readyState = 3 // stop the pending drain poll leaking into later tests
  })

  it('defers the whole chunk when bufferedAmount is ALREADY over the threshold at entry', async () => {
    // Carry-over congestion from a preceding burst. The chunk-entry gate must
    // send zero transcript payload — the mid-chunk break only fires after a
    // send, so without it one fat entry still lands on a near-eviction buffer.
    const ENTRY_COUNT = 30
    const ws = makeBackpressuredWs()
    const { ctx, sends } = build(fatTranscript(ENTRY_COUNT), { ws })
    ws.bufferedAmount = 512 * 1024

    await handler(ws, client(), request(), ctx)
    await turn(5)

    assert.ok(sends.some(m => m.type === 'history_replay_start'))
    const replayed = sends.filter(m => m.type === 'message').length
    assert.equal(replayed, 0, `chunk-entry gate must defer every transcript send while bufferedAmount > threshold; got ${replayed}`)
    assert.equal(sends.find(m => m.type === 'history_replay_end'), undefined, 'the replay must not complete while gated')

    ws.readyState = 3
  })

  it('resumes from the NEXT unsent entry and completes once the peer drains, never crossing the eviction line', async () => {
    const ENTRY_COUNT = 30
    const EVICT_THRESHOLD = 1024 * 1024
    const ws = makeBackpressuredWs()
    const { ctx, sends, reseeds } = build(fatTranscript(ENTRY_COUNT), { ws })

    let maxObserved = 0
    const drainTimer = setInterval(() => {
      if (ws.bufferedAmount > maxObserved) maxObserved = ws.bufferedAmount
      ws.drain(512 * 1024)
    }, 5)

    try {
      await handler(ws, client(), request(), ctx)
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (ws.bufferedAmount > maxObserved) maxObserved = ws.bufferedAmount
        if (sends.some(m => m.type === 'history_replay_end')) break
        await new Promise(r => setTimeout(r, 10))
      }

      assert.ok(sends.some(m => m.type === 'history_replay_end'), 'the replay must eventually complete when the peer drains')
      const delivered = sends.filter(m => m.type === 'message')
      assert.equal(delivered.length, ENTRY_COUNT,
        'every entry must be delivered exactly once — a pause resumes, it does not drop')
      assert.deepEqual(delivered.map(m => m.timestamp), fatTranscript(ENTRY_COUNT).map(e => e.timestamp),
        'and in the original order, resuming from the next UNSENT entry')
      assert.ok(maxObserved < EVICT_THRESHOLD,
        `bufferedAmount peaked at ${maxObserved}; must stay under the ${EVICT_THRESHOLD}-byte eviction line that CLOSES the client`)
      assert.deepEqual(reseeds, ['live-1'], 'the #7340 re-seed still runs, exactly once, after the end frame')
    } finally {
      clearInterval(drainTimer)
    }
  })

  it('POSITIVE CONTROL: an uncongested socket is never paused — the whole transcript drains', async () => {
    // Arms the other direction of the gate: below the threshold it must not
    // pause, or a gate that always paused would pass the tests above.
    const ENTRY_COUNT = 50 // > REPLAY_CHUNK_SIZE(20), so it genuinely spans 3 chunks
    const transcript = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      type: 'response', content: 'small', timestamp: i + 1,
    }))
    const { ctx, sends, ws, reseeds } = build(transcript)

    await handler(ws, client(), request(), ctx)
    await turn(10)

    assert.equal(sends.filter(m => m.type === 'message').length, ENTRY_COUNT,
      'nothing may be withheld when bufferedAmount never crosses the threshold')
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
    assert.deepEqual(reseeds, ['live-1'])
  })

  it('stops sending when the socket closes while parked on back-pressure', async () => {
    const ws = makeBackpressuredWs()
    const { ctx, sends } = build(fatTranscript(30), { ws })

    await handler(ws, client(), request(), ctx)
    await turn(2)

    const sentBeforeClose = sends.length
    ws.readyState = 3
    ws.drainAll()
    await new Promise(r => setTimeout(r, 60)) // past the 20ms drain poll

    assert.equal(sends.length, sentBeforeClose, 'nothing may be written to a closed socket')
    assert.equal(sends.find(m => m.type === 'history_replay_end'), undefined,
      'and the replay does not "finish" against a dead peer')
  })

  it('writes no transcript entries to a socket that is already CLOSED', async () => {
    // The shared loop gates on readyState the way replayHistory always has.
    // Pre-#7480 this handler wrote the whole transcript to a dead peer.
    const ws = makeBackpressuredWs(3)
    const { ctx, sends, reseeds } = build(fatTranscript(5, 1024), { ws })

    await handler(ws, client(), request(), ctx)
    await turn(3)

    assert.equal(sends.filter(m => m.type === 'message').length, 0)
    assert.equal(sends.find(m => m.type === 'history_replay_end'), undefined)
    assert.deepEqual(reseeds, [], 'and no follow-up work is queued against a dead peer')
  })

  it('sends no end frame and no re-seed for an EMPTY transcript when the socket is CLOSED', async () => {
    // Inherited contract (PR #7479, 411dc76ab): the empty-slice path is gated
    // on OPEN too, so a client that vanished before an empty transcript reply
    // gets no `history_replay_end` and no re-seed burst written at a dead
    // socket. Both are pure sends here, so suppressing them loses nothing.
    const ws = makeBackpressuredWs(3)
    const { ctx, sends, reseeds } = build([], { ws })

    await handler(ws, client(), request(), ctx)
    await turn(3)

    assert.equal(sends.find(m => m.type === 'history_replay_end'), undefined,
      'no end frame may be written to a socket that is already gone')
    assert.deepEqual(reseeds, [], 'and no re-seed burst behind it')
  })

  it('POSITIVE CONTROL: an EMPTY transcript on an OPEN socket still brackets start+end and re-seeds', async () => {
    // Gating the dead-socket case must not turn "nothing to replay" into "no
    // reply at all" — the transcript viewer waits on the end frame.
    const { ctx, sends, ws, reseeds } = build([])

    await handler(ws, client(), request(), ctx)
    await turn(3)

    assert.equal(sends[0].type, 'history_replay_start')
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
    assert.deepEqual(reseeds, ['live-1'], 'the #7340 re-seed still follows an empty transcript')
  })

  it('fires the #7340 conditional re-seed exactly ONCE, after history_replay_end, on a CHUNKED transcript', async () => {
    // The re-seed is conditional on client.activeSessionId, so it must stay
    // inside onDone rather than being hoisted out of the now-async loop — and
    // it must not fire once per chunk.
    const ENTRY_COUNT = 45 // spans three chunks
    const transcript = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      type: 'response', content: 'small', timestamp: i + 1,
    }))
    const order = []
    const { ctx, sends, ws, reseeds } = build(transcript)
    const innerSend = ctx.transport.send
    ctx.transport.send = (target, msg) => { order.push(msg.type); return innerSend(target, msg) }
    ctx.transport.reseedActiveAgents = (_ws, sid) => { order.push('__reseed'); reseeds.push(sid) }

    await handler(ws, client(), request(), ctx)
    await turn(10)

    assert.deepEqual(reseeds, ['live-1'], 'exactly one re-seed for the whole chunked replay')
    assert.equal(order[order.length - 1], '__reseed', 'the re-seed must FOLLOW the replay frames it repairs')
    assert.equal(order[order.length - 2], 'history_replay_end')
    assert.equal(sends.filter(m => m.type === 'message').length, ENTRY_COUNT)
  })

  it('re-seeds nothing when the client has no active session, even on a chunked transcript', async () => {
    const ENTRY_COUNT = 45
    const transcript = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      type: 'response', content: 'small', timestamp: i + 1,
    }))
    const { ctx, sends, ws, reseeds } = build(transcript)

    await handler(ws, { id: 'c1', activeSessionId: null, subscribedSessionIds: new Set() }, request(), ctx)
    await turn(10)

    assert.deepEqual(reseeds, [], 'the conditional re-seed must stay conditional inside onDone')
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
  })
})
