import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { encodeProjectPath, MAX_MESSAGES } from '../src/jsonl-reader.js'
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

function build(transcript, { ws = makeOpenWs(), readerResult, reader } = {}) {
  const sends = []
  const reseeds = []
  // `reader: null` means inject NOTHING, so the handler falls through to its own
  // default reader. #7501's cap tests need that: the question there is which
  // reader the default IS, and an injected stub answers it by assumption.
  const readerFn = reader === null
    ? null
    : (reader || createSpy(async () => (readerResult === undefined ? transcript : readerResult)))
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
    resendPendingQuestions: createSpy(), // #7457
    scanConversations: createSpy(async () => [{ conversationId: CONV_ID, cwd: CONV_CWD }]),
    ...(readerFn ? { readConversationTranscript: readerFn } : {}),
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

/**
 * #7501 — `history_replay_start` on the TRANSCRIPT path carried no `truncated`
 * field at all, over a slice subject to the same two caps #7484 made honest on
 * the full-history path: jsonl-reader's 500-most-recent `MAX_MESSAGES` window
 * and its `MAX_TRANSCRIPT_BYTES` tail read. Absence reads to a client exactly
 * like `truncated: false`, so the viewer could be handed the last 500 messages
 * of a 5,000-message conversation with nothing on the wire saying so — and 500
 * entries back is equally the shape of a complete 500-message conversation, so
 * the array cannot be inspected to recover the answer.
 *
 * HONEST DEVIATION, recorded here rather than in a commit message nobody
 * re-reads: NO client renders this field today. `handleHistoryReplayStart`
 * (store-core/src/handlers/conversation.ts) does not parse `truncated`, the
 * dashboard's transcript viewer (`applyTranscriptFrame` in
 * dashboard/src/store/message-handler.ts) only flips status/messages from these
 * frames, and the mobile app has no transcript surface at all. The field is
 * correct-by-CONTRACT — it is the same field `handleRequestFullHistory` and
 * `replayHistory` already emit, so a renderer added later reads one meaning off
 * all three paths — and the wire shape is pinned below so it has something
 * stable to read. It is not, on its own, a user-visible fix.
 */
describe('#7501 — the transcript replay reports the truncation of the slice it sent', () => {
  const slice = () => ([
    { type: 'user_input', content: 'hello', timestamp: 1 },
    { type: 'response', content: 'hi there', timestamp: 2 },
    { type: 'tool_use', tool: 'Bash', content: '{"command":"ls"}', timestamp: 3 },
  ])

  it('carries the reader\'s own truncation onto the wire', async () => {
    const { ctx, sends, ws } = build(null, { readerResult: { messages: slice(), truncated: true } })
    await handler(ws, client(), request(), ctx)
    await turn(5)

    const start = sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.truncated, true,
      'the cap tripped on the slice the client just received; pre-#7501 the frame said nothing at all')
    assert.equal(sends.filter(m => m.type === 'message').length, 3,
      'and the truncated slice still replays — the flag annotates it, it does not gate it')
  })

  it('POSITIVE CONTROL: a COMPLETE transcript reports false — and the key is PRESENT', async () => {
    // The half a one-directional test misses. `truncated: false` and no
    // `truncated` key at all are the same thing to a client reading
    // `msg.truncated`, so asserting the value without asserting PRESENCE would
    // stay green against the pre-#7501 code for the complete case.
    const { ctx, sends, ws } = build(null, { readerResult: { messages: slice(), truncated: false } })
    await handler(ws, client(), request(), ctx)
    await turn(5)

    const start = sends.find(m => m.type === 'history_replay_start')
    assert.ok('truncated' in start, 'the field must be emitted unconditionally, not only when true')
    assert.equal(start.truncated, false)
  })

  it('pins the wire shape of the start frame', async () => {
    // This frame is a contract with two clients and the #7345-family raw
    // consumers. Adding a field is a wire change and should be a deliberate
    // edit here, not a side effect somewhere in the handler.
    const { ctx, sends, ws } = build(null, { readerResult: { messages: slice(), truncated: false } })
    await handler(ws, client(), request(), ctx)
    await turn(5)

    const start = sends.find(m => m.type === 'history_replay_start')
    assert.deepEqual(
      Object.keys(start).sort(),
      ['conversationId', 'fullHistory', 'sessionId', 'truncated', 'type'],
    )
    assert.equal(start.sessionId, CONV_ID, 'still the conversationId — there is no live session behind it')
    assert.equal(start.fullHistory, true)
  })

  it('reads `truncated` STRICTLY — a truthy non-boolean is not a truncation claim', async () => {
    const { ctx, sends, ws } = build(null, { readerResult: { messages: slice(), truncated: 'yes' } })
    await handler(ws, client(), request(), ctx)
    await turn(5)

    const start = sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.truncated, false,
      'same strict-boolean posture the clients take toward this field (store-core handleFileContent)')
  })

  it('LEGACY SHAPE: an injected array-returning reader still replays, reporting false rather than throwing', async () => {
    // The reader is an injection seam (`ctx.readConversationTranscript`) and a
    // pre-#7501 fixture supplies the bare array `readConversationHistoryAsync`
    // used to return. Accepted and read as untruncated — the same posture
    // `handleRequestFullHistory` takes toward a descriptor-less legacy manager.
    const { ctx, sends, ws } = build(slice())
    await handler(ws, client(), request(), ctx)
    await turn(5)

    const start = sends.find(m => m.type === 'history_replay_start')
    assert.equal(sends.filter(m => m.type === 'message').length, 3, 'a legacy reader still replays')
    assert.equal(start.truncated, false)
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
  })

  it('an UNREADABLE transcript is not truncated — nothing was dropped from a slice that does not exist', async () => {
    // jsonl-reader takes the same position on its own catch: claiming
    // truncation here would put a permanent "history incomplete" banner in
    // front of every conversation whose file has gone.
    const { ctx, sends, ws } = build(null, {
      reader: createSpy(async () => { throw new Error('ENOENT') }),
    })
    await handler(ws, client(), request(), ctx)
    await turn(5)

    const start = sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.truncated, false)
    assert.equal(sends.filter(m => m.type === 'message').length, 0)
    assert.equal(sends[sends.length - 1].type, 'history_replay_end',
      'positive control: the handler really did run its replay to completion, so the 0 above is not an early return')
  })
})

/**
 * #7501, the load-bearing half: the tests above inject a reader, so every one of
 * them would stay green if the handler were wired back to the ARRAY-returning
 * `readConversationHistoryAsync` — a stub that hands back a descriptor proves
 * only that the handler forwards one. These drive the handler's OWN default
 * reader over a real transcript on disk, so "which reader is the default" is
 * answered by observation rather than by assumption.
 *
 * CRITICAL: `HOME` is redirected (#4633 posture) — `resolveJsonlPath` builds
 * `~/.claude/projects/<encoded cwd>/<id>.jsonl`, and the fixture must land in a
 * temp tree, never the developer's real one.
 */
describe('#7501 — the DEFAULT reader reports the transcript\'s own MAX_MESSAGES cap', () => {
  let tmpRoot
  let fakeHome
  let realHome
  let realUserProfile

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'transcript-truncation-'))
    fakeHome = join(tmpRoot, 'home')
    mkdirSync(fakeHome, { recursive: true })
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    // os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows.
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
  })

  after(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  /** Write a transcript exactly where the handler's `resolveJsonlPath` will look. */
  function writeTranscript(entries) {
    const dir = join(fakeHome, '.claude', 'projects', encodeProjectPath(CONV_CWD))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${CONV_ID}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n'))
  }

  function userTurns(n) {
    return Array.from({ length: n }, (_, i) => ({
      type: 'user',
      uuid: `u-${i}`,
      timestamp: '2026-01-15T00:00:00.000Z',
      message: { content: [{ type: 'text', text: `message ${i}` }] },
    }))
  }

  /** Pump the setImmediate-scheduled chunk loop until the end frame lands. */
  async function drain(sends, deadlineMs = 5000) {
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      if (sends.some(m => m.type === 'history_replay_end')) return
      await new Promise(r => setImmediate(r))
    }
    throw new Error('the replay never produced a history_replay_end')
  }

  it('a transcript past the 500-message cap replays truncated: true', async () => {
    writeTranscript(userTurns(MAX_MESSAGES + 40))
    const { ctx, sends, ws } = build(null, { reader: null })

    await handler(ws, client(), request(), ctx)
    await drain(sends)

    const messages = sends.filter(m => m.type === 'message')
    assert.equal(messages.length, MAX_MESSAGES, 'precondition: the cap really did trip on this read')
    assert.equal(messages[0].content, 'message 40', 'and the retained slice is the most recent')
    const start = sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.truncated, true,
      'the 40 dropped messages are invisible in the frames the client received — this field is the only thing that says so')
  })

  it('POSITIVE CONTROL: a COMPLETE transcript on the same path replays truncated: false', async () => {
    // Without this, a handler that hardcoded `truncated: true` would pass the
    // test above.
    writeTranscript(userTurns(3))
    const { ctx, sends, ws } = build(null, { reader: null })

    await handler(ws, client(), request(), ctx)
    await drain(sends)

    assert.equal(sends.filter(m => m.type === 'message').length, 3)
    const start = sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.truncated, false)
  })
})
