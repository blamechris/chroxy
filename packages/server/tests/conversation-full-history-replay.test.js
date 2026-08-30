import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
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

/**
 * `historyEntries` is the slice the manager hands back; `source` is WHICH
 * collection it came from and `truncated` whether that collection dropped
 * anything to produce it — the #7484 descriptor.
 *
 * The source is explicit on every fixture rather than inferred from the entry
 * types, because inferring is the bug: a JSONL slice and a ring slice are the
 * same shape of array, and #7479's C1 came from a fixture that LOOKED
 * JSONL-shaped while the code under test still read it as ring-buffer.
 *
 * Pass `legacyArrayShape: true` to model a pre-#7484 manager that returns a
 * bare array.
 */
function build(historyEntries, { ws = makeOpenWs(), managerOverrides = {}, source = 'ring', truncated = false, legacyArrayShape = false } = {}) {
  const sends = []
  const reseeds = []
  const resends = [] // #7457
  const { manager } = createMockSessionManager([{ id: 'sess-1', name: 'Work', cwd: '/repo' }])
  manager.getFullHistoryAsync = async () => (
    legacyArrayShape ? historyEntries : { entries: historyEntries, source, truncated }
  )
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
    // jsonl-reader.js only ever emits user_input/response/tool_use, so a JSONL
    // history has no `result` to synthesize FROM and the rebuilt `message`
    // frames must not grow one. #7484 heals this path at the END of the replay
    // instead (see its describe below) — the per-entry branch stays exactly as
    // it was, which is what this control pins.
    const { ctx, sends, ws } = build([
      { type: 'user_input', content: 'hi', timestamp: 1 },
      { type: 'response', content: 'yo', timestamp: 2 },
      { type: 'tool_use', content: 'ls', tool: 'Bash', timestamp: 3 },
    ], { source: 'jsonl' })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    assert.equal(sends.filter(m => m.type === 'message').length, 3, 'all three JSONL types still rebuild as `message`')
    assert.equal(sends.filter(m => m.type === 'result').length, 0, 'and none of them turns into a `result` frame')
    // The message branch enumerates its fields; the field SHAPE is the thing
    // this control exists to keep pinned.
    for (const m of sends.filter(x => x.type === 'message')) {
      assert.deepEqual(
        Object.keys(m).sort(),
        ['content', 'messageType', 'sessionId', 'timestamp', 'tool', 'type'],
        'the rebuilt message frame carries exactly these fields',
      )
      assert.ok(!('historySeq' in m) && !('_seq' in m), 'and no cursor of any kind')
    }
    // No PER-ENTRY synthesis: the one agent_idle below is the end-of-replay
    // heal, and it must sit after the last message rather than between them.
    const types = sends.map(m => m.type)
    const idles = types.filter(t => t === 'agent_idle')
    assert.equal(idles.length, 1, '#7484 — one heal for the whole replay, never one per entry')
    assert.ok(types.lastIndexOf('message') < types.indexOf('agent_idle'),
      'every message frame precedes the heal — a mid-replay agent_idle would wipe the activeTools history_replay_start is preserving')
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
      source: 'ring',
      truncated: true,
      managerOverrides: { getLatestHistorySeq: () => 42 },
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
    // an older ctx fixture must not throw its way out of a replay. `legacyArrayShape`
    // is the pre-#7484 return: a bare array, so the ring probe is the only
    // truncation signal there is, and here it is missing too.
    const { ctx, sends, ws } = build([{ type: 'response', content: 'Hi', timestamp: 1 }], {
      legacyArrayShape: true,
      managerOverrides: { isHistoryTruncated: undefined, getLatestHistorySeq: undefined },
    })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    const start = sends.find(m => m.type === 'history_replay_start')
    assert.equal(start.truncated, false)
    assert.ok(!('latestSeq' in start), 'no entry carried a _seq, so no cursor is advertised — never a fabricated 0')
    assert.ok(sends.some(m => m.type === 'history_replay_end'), 'the replay still completes')
  })
})

/**
 * #7484 — #7459's synthesis fires on a replayed `result`, and the JSONL
 * transcript has none. `getFullHistoryAsync` PREFERS that transcript whenever a
 * session has a `resumeSessionId`, which is the normal state of a live
 * claude-family session, so the synthesis could not fire on the path almost
 * every "Sync Full History" press actually takes — the user-facing symptom
 * survived on the default source.
 *
 * The zombie chip itself lives in the CLIENT's `activeTools`, put there by a
 * LIVE `tool_start` whose `tool_result` never arrived (a dropped PostToolUse
 * hook, the #4628 root cause). `history_replay_start` deliberately PRESERVES
 * that set (#4466), and nothing in a JSONL slice can clear it: its entries
 * rebuild as `message` frames, which touch no tool state at all. `agent_idle`
 * is the only frame that clears it and is not replay-gated.
 *
 * The heal is therefore ONE `agent_idle` at the end of the replay rather than a
 * per-entry synthesis: it lands after the last entry, so it cannot wipe an
 * activeTools set mid-replay, and the JSONL rows carry no reliable turn
 * boundary to hang a per-entry synthesis on anyway.
 */
describe('#7484 — request_full_history heals the chip on the JSONL path too', () => {
  /** A realistic JSONL slice: user_input / response / tool_use, no result, no _seq. */
  const jsonlSlice = () => ([
    { type: 'user_input', content: 'run the tests', timestamp: 1 },
    { type: 'response', content: 'sure', timestamp: 2 },
    { type: 'tool_use', content: '{"command":"npm test"}', tool: 'Bash', timestamp: 3 },
  ])

  it('synthesizes an agent_idle for a JSONL-sourced replay', async () => {
    const { ctx, sends, ws } = build(jsonlSlice(), { source: 'jsonl' })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)

    const idle = sends.find(m => m.type === 'agent_idle')
    assert.ok(idle,
      'without it "Sync Full History" cannot clear a zombie tool chip on the source it reads by DEFAULT — the whole of #7459 as the user meets it')
    assert.equal(idle.sessionId, 'sess-1', 'the heal targets the replayed session')
    assert.deepEqual(
      Object.keys(idle).sort(),
      ['sessionId', 'type'],
      'the same { type, sessionId } ws-history.js emits — a divergent shape hits different client branches',
    )
  })

  it('synthesizes exactly ONE, however many turns the transcript carries', async () => {
    // Coarser than the ring path's per-result synthesis, and deliberately so:
    // one clear at the end says the same thing about the session's CURRENT
    // state without wiping activeTools between entries.
    const { ctx, sends, ws } = build([
      ...jsonlSlice(),
      { type: 'user_input', content: 'and again', timestamp: 4 },
      { type: 'response', content: 'done', timestamp: 5 },
      { type: 'tool_use', content: '{}', tool: 'Read', timestamp: 6 },
    ], { source: 'jsonl' })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)

    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 1)
  })

  it('lands AFTER every replayed entry and BEFORE history_replay_end', async () => {
    const { ctx, sends, ws } = build(jsonlSlice(), { source: 'jsonl' })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)

    const types = sends.map(m => m.type)
    const idleIdx = types.indexOf('agent_idle')
    assert.equal(types[0], 'history_replay_start')
    assert.equal(types[types.length - 1], 'history_replay_end')
    assert.ok(idleIdx > types.lastIndexOf('message'),
      `the heal must follow the last entry, never interleave with it; got ${types.join(',')}`)
    assert.ok(idleIdx < types.indexOf('history_replay_end'),
      'and stay INSIDE the replay window, where the #4466 gate reasoning holds')
  })

  it('heals an EMPTY JSONL replay too — the chip is client-side state, not an entry', async () => {
    // A transcript read that came back empty still falls back to the ring, so
    // an empty slice labelled 'jsonl' is unusual — but if the source says JSONL
    // the heal is owed, because the stale chip is in the client's store either
    // way.
    const { ctx, sends, ws } = build([], { source: 'jsonl' })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(3)

    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 1)
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
  })

  it('POSITIVE CONTROL: a RING-sourced replay is untouched — its heal still comes from `result`', async () => {
    // The ring path already synthesizes per replayed `result` (#7459). Adding a
    // second, unconditional heal there would emit two for one turn boundary.
    const { ctx, sends, ws } = build([
      { type: 'tool_start', tool: 'Bash', toolUseId: 'toolu_1', timestamp: 1, _seq: 1 },
      { type: 'result', durationMs: 12, timestamp: 2, _seq: 2 },
    ], { source: 'ring' })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)

    const types = sends.map(m => m.type)
    assert.equal(types.filter(t => t === 'agent_idle').length, 1, 'exactly the one the result synthesized')
    assert.equal(types.indexOf('agent_idle'), types.indexOf('result') + 1,
      'and it is still the per-result synthesis, immediately after its result — not an end-of-replay heal')
  })

  it('POSITIVE CONTROL: a ring-sourced replay with NO result still synthesizes nothing', async () => {
    const { ctx, sends, ws } = build(jsonlSlice(), { source: 'ring' })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 0,
      'the source is the discriminator — identical entries under `ring` must NOT be healed')
  })

  it('POSITIVE CONTROL: a session that is mid-turn is NOT declared idle', async () => {
    // `agent_idle` sets isIdle, clears streamingMessageId (hiding the stop
    // button) and clears activeTools. All correct after a finished turn; all
    // WRONG while one is running — and the client has no `agent_busy` coming to
    // undo it until the next turn starts.
    const { ctx, sends, ws } = build(jsonlSlice(), {
      source: 'jsonl',
      managerOverrides: { isSessionBusy: () => true },
    })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)

    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 0,
      'a running turn is not a turn boundary')
    assert.equal(sends.filter(m => m.type === 'message').length, 3, 'the replay itself still happens')
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
  })

  it('heals when the manager has no busy probe at all', async () => {
    // A legacy ctx fixture cannot answer, and "cannot tell" must not silently
    // become "do nothing" — that is the defect this issue is about. The one
    // real SessionManager always answers (pinned at the producer).
    const { ctx, sends, ws } = build(jsonlSlice(), {
      source: 'jsonl',
      managerOverrides: { isSessionBusy: undefined },
    })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 1)
  })

  it('LEGACY SHAPE: a manager returning a bare array is read as the ring buffer, not healed', async () => {
    const { ctx, sends, ws } = build(jsonlSlice(), { legacyArrayShape: true })
    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    assert.equal(sends.filter(m => m.type === 'message').length, 3, 'a legacy manager still replays')
    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 0,
      'nothing said JSONL, so nothing may be healed on a guess')
  })

  describe('`truncated` describes the collection actually sent', () => {
    it('reports the JSONL slice\'s own truncation, not the ring buffer\'s', async () => {
      // jsonl-reader caps at the 500 most-recent messages. Pre-#7484 the frame
      // carried isHistoryTruncated() — the RING's overflow — so a slice that
      // silently dropped everything before the last 500 went out as
      // `truncated: false`.
      const { ctx, sends, ws } = build(jsonlSlice(), {
        source: 'jsonl',
        truncated: true,
        managerOverrides: { isHistoryTruncated: () => false },
      })
      await handler(ws, client(), { type: 'request_full_history' }, ctx)

      const start = sends.find(m => m.type === 'history_replay_start')
      assert.equal(start.truncated, true,
        'the 500-message cap tripped on the slice the client just received; the ring says nothing about it')
    })

    it('does NOT report a ring overflow next to a complete JSONL slice', async () => {
      // The other direction, and the one a single-direction test would miss:
      // the ring overflowed, but the client received a complete transcript.
      const { ctx, sends, ws } = build(jsonlSlice(), {
        source: 'jsonl',
        truncated: false,
        managerOverrides: { isHistoryTruncated: () => true },
      })
      await handler(ws, client(), { type: 'request_full_history' }, ctx)

      const start = sends.find(m => m.type === 'history_replay_start')
      assert.equal(start.truncated, false,
        'a ring-buffer overflow is not a statement about the transcript the client actually got')
    })

    it('a RING-sourced replay reports the ring\'s overflow', async () => {
      const { ctx, sends, ws } = build([{ type: 'response', content: 'Hi', timestamp: 1, _seq: 1 }], {
        source: 'ring',
        truncated: true,
        managerOverrides: { isHistoryTruncated: () => false },
      })
      await handler(ws, client(), { type: 'request_full_history' }, ctx)

      const start = sends.find(m => m.type === 'history_replay_start')
      assert.equal(start.truncated, true,
        'the descriptor carries the ring\'s own flag on this path — the probe is the legacy fallback, not the source of truth')
    })
  })
})

/**
 * #7507 — the guard above is `sessionManager.isSessionBusy`, which is
 * `entry.session.isRunning`: LIVENESS, not mid-turn. Every other test in this
 * file stubs that method, so none of them can witness which state a REAL session
 * reports — and the state that matters is a turn that has ENDED while an
 * un-polled `Bash(run_in_background: true)` shell is still tracked (#4307).
 *
 * These drive a real `SessionManager` holding a real `BaseSession`, so the
 * decision is recorded as behaviour: in that state the heal is SUPPRESSED.
 * Narrowing the guard to `_isBusy` flips the first test below, which is exactly
 * what should happen — the choice is consistency with the server's single busy
 * authority (`listSessions().isBusy` is the same `isRunning`, and BOTH clients
 * re-derive `isIdle` from it on every `session_list` / `session_activity`:
 * #4639 for the dashboard, #7518 for the mobile app), and it is a choice, not an
 * accident.
 *
 * `getFullHistoryAsync` is stubbed to a JSONL descriptor because the transcript
 * READ is not what is under test here (it is pinned at the producer, in
 * session-manager-full-history-source.test.js) — the busy probe is.
 */
describe('#7507 — the JSONL heal is gated on LIVENESS, and a pending background shell is live', () => {
  let tmpRoot
  let emptySkillsDir

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'fh-replay-liveness-'))
    emptySkillsDir = join(tmpRoot, 'skills')
    mkdirSync(emptySkillsDir, { recursive: true })
  })

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  const jsonlSlice = () => ([
    { type: 'user_input', content: 'run the tests', timestamp: 1 },
    { type: 'response', content: 'sure', timestamp: 2 },
    { type: 'tool_use', content: '{"command":"npm test"}', tool: 'Bash', timestamp: 3 },
  ])

  /** A real manager + a real session — no `isSessionBusy` stub anywhere. */
  function buildReal() {
    const sends = []
    // #4633: temp stateFilePath, always.
    const manager = new SessionManager({
      skipPreflight: true,
      maxSessions: 5,
      stateFilePath: join(tmpRoot, `state-${Math.random().toString(36).slice(2)}.json`),
    })
    const session = new BaseSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
    manager._sessions.set('sess-1', { session, name: 'Work', cwd: '/repo', createdAt: Date.now() })
    manager.getFullHistoryAsync = async () => ({ entries: jsonlSlice(), source: 'jsonl', truncated: false })
    const ctx = nsCtx({
      send: (_target, msg) => sends.push(msg),
      sessionManager: manager,
      reseedActiveAgents: () => {},
      resendPendingQuestions: () => {},
    })
    return { ctx, sends, session, ws: makeOpenWs() }
  }

  it('does NOT heal while a background shell is pending, though NO turn is in flight', async () => {
    const { ctx, sends, session, ws } = buildReal()
    try {
      session.trackBackgroundShell({ shellId: 'brk57kt6pm', command: 'npm run dev' })
      assert.equal(session._isBusy, false, 'precondition: the turn has ended — this is not a mid-turn suppression')

      await handler(ws, client(), { type: 'request_full_history' }, ctx)
      await turn(5)

      assert.equal(sends.filter(m => m.type === 'agent_idle').length, 0,
        'a session waiting on background work is LIVE; declaring it idle would be reverted by the next session_list (#4639)')
      assert.equal(sends.filter(m => m.type === 'message').length, 3,
        'positive control: the replay itself still happened, so the 0 above is not an early return')
      assert.equal(sends[sends.length - 1].type, 'history_replay_end')
    } finally {
      session._destroyPendingBackgroundShells()
    }
  })

  it('POSITIVE CONTROL: the SAME replay heals once the shell is acknowledged', async () => {
    // The other direction, and the one that proves the suppression above is the
    // guard doing its job rather than the heal being broken outright.
    const { ctx, sends, session, ws } = buildReal()
    try {
      session.trackBackgroundShell({ shellId: 'brk57kt6pm', command: 'npm run dev' })
      session.clearBackgroundShell('brk57kt6pm')

      await handler(ws, client(), { type: 'request_full_history' }, ctx)
      await turn(5)

      assert.equal(sends.filter(m => m.type === 'agent_idle').length, 1)
    } finally {
      session._destroyPendingBackgroundShells()
    }
  })

  it('does not heal mid-turn either — the other arm of the same getter', async () => {
    const { ctx, sends, session, ws } = buildReal()
    session._isBusy = true

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(5)

    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 0)
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
  })
})

/**
 * #7521 review, finding 1 — the ten pins above constrain WHAT `isSessionBusy`
 * returns for a given state, and THAT the handler consults it. None of them
 * constrains WHEN it is consulted. `sendChunkedWithBackpressure` drains across
 * `setImmediate` turns, and the guard is deliberately read inside `onDone` — the
 * latest, most conservative point. Hoisting that read to just after the
 * `history_replay_start` send and caching it across the drain was green on all
 * four suites (38/38, 16/16, 18/18, 43/43), which is the gap this closes.
 *
 * The mutant is not cosmetic. A session that goes live DURING the replay (a turn
 * starts, or a background shell is tracked) would be handed the synthesized
 * `agent_idle` mid-turn — precisely the outcome the guard exists to prevent —
 * and the reverse (busy -> idle during the drain) suppresses a heal that is due.
 *
 * The ctx is the file's own `build()` rather than a copy of it: `build` already
 * mirrors each payload's bytes back into the ws stub, which is the "ctx that
 * mirrors bufferedAmount back into ws" this probe needs. Everything else —
 * fixture size, the frame counter that flips `live`, `turn(50)`, both assertions
 * — is the probe as written in the review.
 */
describe('#7521 review — the busy guard is READ at onDone, not cached across the drain', () => {
  it('a session that goes LIVE DURING the replay is not declared idle at replay-end', async () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({ type: 'response', content: `m${i}`, timestamp: i }))
    let live = false, frames = 0
    const ws = { readyState: 1, bufferedAmount: 0, send() { frames++; if (frames > 2) live = true } }
    const { ctx, sends } = build(entries, {
      ws,
      source: 'jsonl',
      managerOverrides: { isSessionBusy: () => live },
    })

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(50)

    assert.ok(live, 'precondition: the session really did go live during the drain')
    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 0,
      'the guard must be read at onDone, not cached before the drain')
    assert.equal(sends.filter(m => m.type === 'message').length, entries.length,
      'positive control: the whole replay really did drain, so the 0 above is not a stalled loop')
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
  })

  it('POSITIVE CONTROL: a session that stays idle through the SAME drain IS healed', async () => {
    // Without this, a probe that only ever observed "no agent_idle" would pass
    // against a handler that had stopped healing altogether.
    const entries = Array.from({ length: 300 }, (_, i) => ({ type: 'response', content: `m${i}`, timestamp: i }))
    let frames = 0
    const ws = { readyState: 1, bufferedAmount: 0, send() { frames++ } }
    const { ctx, sends } = build(entries, {
      ws,
      source: 'jsonl',
      managerOverrides: { isSessionBusy: () => false },
    })

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(50)

    assert.ok(frames > 2, 'precondition: the same multi-chunk drain really did happen')
    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 1)
  })

  it('and the reverse: busy at the START, idle by the END, still heals', async () => {
    // The other direction of the same read-point property. A cached read taken
    // before the drain sees BUSY here and suppresses a heal that is due by the
    // time the replay actually ends.
    const entries = Array.from({ length: 300 }, (_, i) => ({ type: 'response', content: `m${i}`, timestamp: i }))
    let live = true, frames = 0
    const ws = { readyState: 1, bufferedAmount: 0, send() { frames++; if (frames > 2) live = false } }
    const { ctx, sends } = build(entries, {
      ws,
      source: 'jsonl',
      managerOverrides: { isSessionBusy: () => live },
    })

    await handler(ws, client(), { type: 'request_full_history' }, ctx)
    await turn(50)

    assert.equal(live, false, 'precondition: the session really did go quiet during the drain')
    assert.equal(sends.filter(m => m.type === 'agent_idle').length, 1,
      'a read cached before the drain would have suppressed this heal')
  })
})
