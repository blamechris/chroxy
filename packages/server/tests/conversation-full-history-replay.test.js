import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { createMockSessionManager, nsCtx } from './test-helpers.js'

const handler = conversationHandlers.request_full_history

/** An OPEN, never-congested socket — the common case. */
function makeOpenWs() {
  return { readyState: 1, bufferedAmount: 0 }
}

/**
 * A ws stub whose `bufferedAmount` grows by the wire size of every payload
 * written and only falls when the simulated peer acknowledges — i.e. what the
 * real socket reports between event-loop turns. Mirrors the fixture the #4833
 * `replayHistory` tests use in ws-history.test.js, because this handler is the
 * SECOND replay path and must behave identically under the same pressure.
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

function build(historyEntries, { ws = makeOpenWs(), managerOverrides = {} } = {}) {
  const sends = []
  const reseeds = []
  const resends = [] // #7457
  const { manager } = createMockSessionManager([{ id: 'sess-1', name: 'Work', cwd: '/repo' }])
  manager.getFullHistoryAsync = async () => historyEntries
  Object.assign(manager, managerOverrides)
  const ctx = nsCtx({
    send: (target, msg) => {
      sends.push(msg)
      // Feed the byte stream back into the stub so the back-pressure gate sees
      // a real, growing bufferedAmount. A no-op on the plain open-ws stub,
      // which has no send() — that one models a socket that never congests.
      if (target && typeof target.send === 'function' && target.readyState === 1) {
        target.send(JSON.stringify(msg))
      }
    },
    sessionManager: manager,
    reseedActiveAgents: (_ws, sid) => reseeds.push(sid),
    // #7457: same post-replay repair lane as the re-seed.
    resendPendingQuestions: (_ws, sid) => resends.push(sid),
  })
  return { ctx, sends, ws, reseeds, resends }
}

const client = () => ({ id: 'c1', activeSessionId: 'sess-1' })

/** Yield the event loop `n` times so setImmediate-scheduled chunks can run. */
async function turn(n = 5) {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r))
}

function fatHistory(count = 30, payloadBytes = 200 * 1024) {
  const bigText = 'x'.repeat(payloadBytes)
  return Array.from({ length: count }, (_, i) => ({
    type: 'tool_result',
    toolUseId: `toolu_${i}`,
    content: bigText,
    _seq: i + 1,
  }))
}

/**
 * #7454 — `request_full_history` is the SECOND replay path (the first is
 * ws-history.js's `replayHistory`), and the #7420 live-vs-replayed
 * discriminator keys on `historySeq` PRESENCE. A ring-buffer `user_question`
 * forwarded raw (no `_seq` → `historySeq` mapping) reads as a live racer on
 * the client and is left unstamped at replay-end — and the raw `_seq` was
 * leaking onto the wire besides.
 */
describe('#7454 — request_full_history maps _seq onto the wire like replayHistory does', () => {
  it('stamps historySeq on a ring-buffer user_question and never leaks the raw _seq', async () => {
    const { ctx, sends, ws } = build([
      { type: 'user_question', toolUseId: 't1', questions: [], timestamp: 123, _seq: 7 },
      { type: 'response', content: 'Hi', timestamp: 124 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    const q = sends.find(m => m.type === 'user_question')
    assert.ok(q, 'the user_question entry is forwarded')
    assert.equal(q.historySeq, 7, 'the internal _seq must surface as historySeq — the #7420 discriminator keys on it')
    assert.ok(!('_seq' in q), 'the internal counter must not leak onto the wire')
  })

  it('POSITIVE CONTROL: an entry with no _seq goes out with NO historySeq key', async () => {
    // Absence is the live signal — manufacturing a historySeq here would be
    // as wrong as omitting a real one.
    const { ctx, sends, ws } = build([
      { type: 'user_question', toolUseId: 't2', questions: [], timestamp: 125 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    const q = sends.find(m => m.type === 'user_question')
    assert.ok(q)
    assert.ok(!('historySeq' in q), 'no _seq means no historySeq — never null, never fabricated')
  })

  it('maps _seq for EVERY else-branch ring type, not just user_question', async () => {
    // Review on #7458: narrowing the mapping to user_question survived every
    // test. The clients read historySeq off `message` and `tool_start` too
    // (the #5555.3 delta-replay cursor), so the breadth is load-bearing.
    const { ctx, sends, ws } = build([
      { type: 'tool_start', tool: 'Bash', timestamp: 1, _seq: 11 },
      { type: 'tool_result', tool: 'Bash', timestamp: 2, _seq: 12 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    const ts = sends.find(m => m.type === 'tool_start')
    const tr = sends.find(m => m.type === 'tool_result')
    assert.equal(ts.historySeq, 11, 'tool_start must carry historySeq — the delta-replay cursor reads it')
    assert.equal(tr.historySeq, 12)
    assert.ok(!('_seq' in ts) && !('_seq' in tr), 'no raw counter on any else-branch type')
  })

  it('still brackets the forward with history_replay_start/end and rebuilds message-branch entries', async () => {
    const { ctx, sends, ws } = build([
      { type: 'response', content: 'Hi', timestamp: 1, _seq: 3 },
      { type: 'user_question', toolUseId: 't3', questions: [], timestamp: 2, _seq: 4 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    assert.equal(sends[0].type, 'history_replay_start')
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
    const rebuilt = sends.find(m => m.type === 'message')
    assert.equal(rebuilt.messageType, 'response')
    assert.ok(!('_seq' in rebuilt), 'the message branch never carried _seq and must not start')
    assert.ok(!('historySeq' in rebuilt), 'nor may it grow a historySeq — the rebuild enumerates its fields')
  })
})

/**
 * #7459 — the same family, a different mechanism. `replayHistory` synthesises
 * an `agent_idle` after every replayed `result` (#4628); this handler did not.
 *
 * The raw `result` is not a substitute: both clients DO have a `case 'result'`
 * that clears `activeTools` as the #4308 turn-boundary net, but #4466 gated it
 * behind "not replaying" so a replayed result can't wipe the activeTools that
 * `history_replay_start` is trying to preserve. During a replay the clear comes
 * from `agent_idle`, which is NOT replay-gated — and only replayHistory
 * synthesised it. Net effect: reconnect/session-switch healed a zombie
 * "Running X" chip, but "Sync Full History" — the button a user presses
 * BECAUSE the view looks wrong — could not.
 */
describe('#7459 — request_full_history mirrors replayHistory result → agent_idle synthesis (#4628)', () => {
  it('emits agent_idle immediately after a ring-buffer result entry', async () => {
    const { ctx, sends, ws } = build([
      { type: 'tool_start', tool: 'Bash', toolUseId: 'toolu_1', timestamp: 1, _seq: 1 },
      { type: 'result', durationMs: 12, timestamp: 2, _seq: 2 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)

    const types = sends.map(m => m.type)
    const resultIdx = types.indexOf('result')
    const idleIdx = types.indexOf('agent_idle')
    assert.ok(resultIdx >= 0, 'the result entry itself is still forwarded')
    assert.ok(
      idleIdx >= 0,
      'a replayed result must be followed by a synthesized agent_idle — the clients\' case \'result\' is replay-gated (#4466), so agent_idle is the ONLY thing that clears the zombie tool chip',
    )
    assert.equal(idleIdx, resultIdx + 1, 'the synthesis must come IMMEDIATELY after its result, in the same order replayHistory emits it')
  })

  it('emits the SAME shape replayHistory does — { type, sessionId } and nothing else', async () => {
    const { ctx, sends, ws } = build([
      { type: 'result', durationMs: 5, timestamp: 1, _seq: 4 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    const idle = sends.find(m => m.type === 'agent_idle')
    assert.ok(idle, 'agent_idle must be synthesized')
    assert.equal(idle.sessionId, 'sess-1', 'the synthesis targets the replayed session')
    assert.deepEqual(
      Object.keys(idle).sort(),
      ['sessionId', 'type'],
      'ws-history.js emits exactly { type, sessionId }; a divergent shape would hit different client branches',
    )
    assert.ok(!('historySeq' in idle), 'the synthesis is a fresh frame, not a replayed entry — it carries no seq')
  })

  it('brackets the synthesis INSIDE the replay window', async () => {
    // Outside the window the client would treat it as a live idle and the
    // #4466 gate reasoning no longer holds.
    const { ctx, sends, ws } = build([
      { type: 'result', durationMs: 5, timestamp: 1, _seq: 4 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    const types = sends.map(m => m.type)
    const idleIdx = types.indexOf('agent_idle')
    assert.equal(types[0], 'history_replay_start')
    assert.equal(types[types.length - 1], 'history_replay_end')
    assert.ok(idleIdx > 0 && idleIdx < types.length - 1, `agent_idle must sit between the replay brackets; got order ${types.join(',')}`)
  })

  it('synthesizes ONE agent_idle per result, not one per replay', async () => {
    const { ctx, sends, ws } = build([
      { type: 'result', durationMs: 1, timestamp: 1, _seq: 1 },
      { type: 'tool_start', tool: 'Bash', timestamp: 2, _seq: 2 },
      { type: 'result', durationMs: 2, timestamp: 3, _seq: 3 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    const idles = sends.filter(m => m.type === 'agent_idle')
    assert.equal(idles.length, 2, 'each replayed result carries its own turn boundary')
  })

  it('POSITIVE CONTROL: a history with no result entry synthesizes nothing', async () => {
    const { ctx, sends, ws } = build([
      { type: 'tool_start', tool: 'Bash', timestamp: 1, _seq: 1 },
      { type: 'user_question', toolUseId: 't1', questions: [], timestamp: 2, _seq: 2 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 0,
      'agent_idle is synthesized FROM a result — an unconditional emit would clear activeTools on every sync')
  })

  it('POSITIVE CONTROL: a JSONL-sourced history leaves the message branch untouched', async () => {
    // jsonl-reader.js only ever emits user_input/response/tool_use, so a
    // JSONL history has no `result` to synthesize from and the rebuilt
    // `message` frames must not grow one.
    const { ctx, sends, ws } = build([
      { type: 'user_input', content: 'hi', timestamp: 1 },
      { type: 'response', content: 'yo', timestamp: 2 },
      { type: 'tool_use', content: 'ls', tool: 'Bash', timestamp: 3 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 0)
    assert.equal(sends.filter(m => m.type === 'message').length, 3, 'all three JSONL types still rebuild as `message`')
  })
})

/**
 * #7460 — the #4833 back-pressure discipline never reached this path. The
 * handler sent the entire history synchronously in one turn of the event loop
 * with no `bufferedAmount` check anywhere, so a session with fat tool_result
 * payloads could push the socket past the 1MB EVICT_THRESHOLD in
 * ws-client-sender.js — and crossing it CLOSES the client. The action a user
 * takes to repair a view was the one that could break the connection.
 */
describe('#7460 — request_full_history sends under the same chunk + bufferedAmount gate replayHistory uses (#4833)', () => {
  it('pauses mid-chunk once bufferedAmount crosses the threshold instead of draining the whole history', async () => {
    // 30 × 200KB = 6MB. Pre-fix the loop pushed all of it onto the socket in
    // one synchronous burst, blowing far past the 1MB eviction line.
    const ENTRY_COUNT = 30
    const ws = makeBackpressuredWs()
    const { ctx, sends, reseeds } = build(fatHistory(ENTRY_COUNT), { ws })

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    // The peer never acknowledges, so the loop must stay parked.
    await turn(5)

    assert.ok(sends.some(m => m.type === 'history_replay_start'), 'the start frame precedes the gate, as in replayHistory')
    const replayed = sends.filter(m => m.type === 'tool_result').length
    assert.ok(
      replayed > 0 && replayed < ENTRY_COUNT,
      `expected the loop to stall part-way while bufferedAmount stays above the pause threshold; got ${replayed}/${ENTRY_COUNT}`,
    )
    assert.equal(sends.find(m => m.type === 'history_replay_end'), undefined,
      'history_replay_end must not be sent while the socket is congested')
    assert.equal(reseeds.length, 0, 'the re-seed follows the end frame, so a stalled replay has not re-seeded either')

    ws.readyState = 3 // stop the pending drain poll leaking into later tests
  })

  it('defers the whole chunk when bufferedAmount is ALREADY over the threshold at entry', async () => {
    // Carry-over congestion from a preceding burst. The chunk-entry gate must
    // send zero history payload — the mid-chunk break only fires after a send,
    // so without it one fat tool_result still lands on a near-eviction buffer.
    const ENTRY_COUNT = 30
    const ws = makeBackpressuredWs()
    const { ctx, sends } = build(fatHistory(ENTRY_COUNT), { ws })
    ws.bufferedAmount = 512 * 1024

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(5)

    assert.ok(sends.some(m => m.type === 'history_replay_start'))
    const replayed = sends.filter(m => m.type === 'tool_result').length
    assert.equal(replayed, 0, `chunk-entry gate must defer every history send while bufferedAmount > threshold; got ${replayed}`)
    assert.equal(sends.find(m => m.type === 'history_replay_end'), undefined, 'the replay must not complete while gated')

    ws.readyState = 3
  })

  it('resumes from the NEXT unsent entry and completes once the peer drains', async () => {
    const ENTRY_COUNT = 30
    const EVICT_THRESHOLD = 1024 * 1024
    const ws = makeBackpressuredWs()
    const { ctx, sends, reseeds } = build(fatHistory(ENTRY_COUNT), { ws })

    let maxObserved = 0
    const drainTimer = setInterval(() => {
      if (ws.bufferedAmount > maxObserved) maxObserved = ws.bufferedAmount
      ws.drain(512 * 1024)
    }, 5)

    try {
      await handler(ws, client(), { type: 'request_full_history' }, ctx)
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (ws.bufferedAmount > maxObserved) maxObserved = ws.bufferedAmount
        if (sends.some(m => m.type === 'history_replay_end')) break
        await new Promise(r => setTimeout(r, 10))
      }

      assert.ok(sends.some(m => m.type === 'history_replay_end'), 'the replay must eventually complete when the peer drains')
      assert.equal(sends.filter(m => m.type === 'tool_result').length, ENTRY_COUNT,
        'every entry must be delivered exactly once — a pause resumes, it does not drop')
      assert.deepEqual(sends.filter(m => m.type === 'tool_result').map(m => m.toolUseId),
        fatHistory(ENTRY_COUNT).map(e => e.toolUseId),
        'and in the original order, resuming from the next UNSENT entry')
      assert.ok(maxObserved < EVICT_THRESHOLD,
        `bufferedAmount peaked at ${maxObserved}; must stay under the ${EVICT_THRESHOLD}-byte eviction line that CLOSES the client`)
      assert.deepEqual(reseeds, ['sess-1'], 'the #7340 re-seed still runs, exactly once, after the end frame')
    } finally {
      clearInterval(drainTimer)
    }
  })

  it('POSITIVE CONTROL: an uncongested socket is never paused — the whole history drains', async () => {
    // Arms the other direction of the gate: below the threshold it must not
    // pause, or a gate that always paused would pass the tests above.
    const ENTRY_COUNT = 50 // > CHUNK_SIZE(20), so it genuinely spans 3 chunks
    const history = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      type: 'tool_result', toolUseId: `toolu_${i}`, content: 'small', _seq: i + 1,
    }))
    const { ctx, sends, ws, reseeds } = build(history)

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(10)

    assert.equal(sends.filter(m => m.type === 'tool_result').length, ENTRY_COUNT,
      'nothing may be withheld when bufferedAmount never crosses the threshold')
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
    assert.deepEqual(reseeds, ['sess-1'])
  })

  // #7457 — `request_full_history` ends with the SAME `history_replay_end` a
  // replay does, so it runs the same client-side unanswered-prompt sweep. "Sync
  // Full History" is the button a user presses BECAUSE the view looks wrong, and
  // without this repair it would resolve the very question they are blocked on.
  it('re-asserts the session pending questions after the end frame (#7457)', async () => {
    const history = [{ type: 'user_question', toolUseId: 'ask-1', questions: [], _seq: 1 }]
    const { ctx, sends, ws, resends } = build(history)

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(10)

    assert.equal(sends[sends.length - 1].type, 'history_replay_end',
      'precondition: the end frame is the last thing the handler itself sent')
    assert.deepEqual(resends, ['sess-1'])
  })

  it('stops sending when the socket closes while parked on back-pressure', async () => {
    const ws = makeBackpressuredWs()
    const { ctx, sends } = build(fatHistory(30), { ws })

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(2)

    const sentBeforeClose = sends.length
    ws.readyState = 3
    ws.drainAll()
    await new Promise(r => setTimeout(r, 60)) // past the 20ms drain poll

    assert.equal(sends.length, sentBeforeClose, 'nothing may be written to a closed socket')
    assert.equal(sends.find(m => m.type === 'history_replay_end'), undefined, 'and the replay does not "finish" against a dead peer')
  })

  it('writes no history to a socket that is already CLOSED', async () => {
    // The shared loop gates on readyState the way replayHistory always has.
    // Pre-#7460 this handler wrote the whole ring buffer to a dead peer.
    const ws = makeBackpressuredWs(3)
    const { ctx, sends, reseeds } = build(fatHistory(5, 1024), { ws })

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(3)

    assert.equal(sends.filter(m => m.type === 'tool_result').length, 0)
    assert.equal(sends.find(m => m.type === 'history_replay_end'), undefined)
    assert.deepEqual(reseeds, [], 'and no follow-up work is queued against a dead peer')
  })

  it('omits latestSeq entirely when NO forwarded entry carried a _seq (the JSONL path)', async () => {
    // C1 (review of PR #7479). `getFullHistoryAsync` PREFERS the JSONL
    // transcript whenever `resumeSessionId` is set, and jsonl-reader.js emits
    // only user_input/response/tool_use — none of which carry `_seq`. Sourcing
    // `latestSeq` from the RING BUFFER there tells the client it holds entries
    // this replay never delivered: `reconcileReplayEnd` feeds it straight to
    // `recordHistorySeq`, so the NEXT reconnect resolves the cursor as
    // already-current and replays NOTHING — stranding the client on the lossy
    // JSONL rebuild with no way back to the ring buffer's richer entries.
    const { ctx, sends, ws } = build([
      { type: 'user_input', content: 'hi', timestamp: 1 },
      { type: 'response', content: 'yo', timestamp: 2 },
      { type: 'tool_use', content: 'ls', tool: 'Bash', timestamp: 3 },
    ], { managerOverrides: { getLatestHistorySeq: () => 42 } })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)

    const start = sends.find(m => m.type === 'history_replay_start')
    const end = sends.find(m => m.type === 'history_replay_end')
    // Precondition, stated as an assertion so this test cannot pass because the
    // fixture silently grew a seq: nothing in a JSONL replay is seq-stamped.
    assert.equal(sends.some(m => 'historySeq' in m), false,
      'precondition: a JSONL-sourced history stamps historySeq on nothing')
    assert.ok(!('latestSeq' in end),
      `the end frame must not advertise a cursor this replay never delivered; got latestSeq=${end.latestSeq}`)
    assert.ok(!('latestSeq' in start),
      `nor may the start frame; got latestSeq=${start.latestSeq}`)
  })

  it('sends no end frame and no re-seed for an EMPTY history when the socket is CLOSED', async () => {
    // Copilot review: the empty-slice path ran onDone() unconditionally, so a
    // client that vanished before an empty replay still got a
    // history_replay_end plus a re-seed burst written at a dead socket —
    // contradicting the shared helper's own stated contract.
    const ws = makeBackpressuredWs(3)
    const { ctx, sends, reseeds } = build([], { ws })

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(3)

    assert.equal(sends.find(m => m.type === 'history_replay_end'), undefined,
      'no end frame may be written to a socket that is already gone')
    assert.deepEqual(reseeds, [], 'and no re-seed burst behind it')
  })

  it('POSITIVE CONTROL: an EMPTY history on an OPEN socket still brackets start+end', async () => {
    // The empty replay must keep working — gating the dead-socket case must not
    // turn "nothing to replay" into "no reply at all".
    const { ctx, sends, ws, reseeds } = build([])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(3)

    assert.equal(sends[0].type, 'history_replay_start')
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
    assert.deepEqual(reseeds, ['sess-1'], 'the #7340 re-seed still follows an empty replay')
  })

  it('carries `truncated`, and sources `latestSeq` from the entries DELIVERED rather than the buffer', async () => {
    // The buffer's counter says 42; this replay delivered up to seq 9. Telling
    // the client 42 would advance its cursor past entries it never received
    // (C1) — so the frames must carry what was actually sent.
    const { ctx, sends, ws } = build([{ type: 'response', content: 'Hi', timestamp: 1, _seq: 9 }], {
      managerOverrides: { isHistoryTruncated: () => true, getLatestHistorySeq: () => 42 },
    })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)

    const start = sends.find(m => m.type === 'history_replay_start')
    const end = sends.find(m => m.type === 'history_replay_end')
    assert.equal(start.fullHistory, true, 'still an authoritative rebuild')
    assert.equal(start.truncated, true, 'without it a client cannot tell the ring buffer overflowed on this replay')
    assert.equal(start.latestSeq, 9, 'replayHistory rides latestSeq on the start frame too — but only the delivered one')
    assert.equal(end.latestSeq, 9, 'reconcileReplayEnd finalises the cursor from the END frame\'s latestSeq')
  })

  it('takes the HIGHEST delivered _seq, not the last entry\'s', async () => {
    const { ctx, sends, ws } = build([
      { type: 'tool_start', tool: 'Bash', timestamp: 1, _seq: 12 },
      { type: 'response', content: 'Hi', timestamp: 2 },
    ])
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    const end = sends.find(m => m.type === 'history_replay_end')
    assert.equal(end.latestSeq, 12, 'a trailing seq-less entry must not erase the cursor the replay did deliver')
  })

  it('degrades to truncated:false and NO latestSeq on a legacy manager missing the helpers', async () => {
    // Same defensive posture replayHistory takes for getLatestHistorySeq —
    // an older ctx fixture must not throw its way out of a replay.
    const { ctx, sends, ws } = build([{ type: 'response', content: 'Hi', timestamp: 1 }], {
      managerOverrides: { isHistoryTruncated: undefined, getLatestHistorySeq: undefined },
    })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    const start = sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.truncated, false)
    assert.ok(!('latestSeq' in start), 'no entry carried a _seq, so no cursor is advertised — never a fabricated 0')
    assert.ok(sends.some(m => m.type === 'history_replay_end'), 'the replay still completes')
  })
})
