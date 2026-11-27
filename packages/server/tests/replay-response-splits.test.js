import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { SessionMessageHistory, MAX_REPLY_SPLITS, MAX_SPLIT_TOOL_ID_LENGTH } from '../src/session-message-history.js'
import { replayHistory, CAPABILITY_HISTORY_INFLIGHT_REPLY } from '../src/ws-history.js'

/**
 * #9024 -- a reply is ONE history entry, recorded at stream_end, after the tool rows of
 * its turn. The entry carries `splits`: where each tool call fell in the text, so a
 * reload lays the reply out around the cards again. The entry itself (its id, its seq,
 * its place in the ring buffer) is exactly what it was.
 *
 * Every SessionManager here uses a temp stateFilePath (#4633).
 */

let tmpDir
function tmpStateFile() {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'replay-splits-'))
  return join(tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }) })

const TOOL = (id) => ({ messageId: id, toolUseId: id, tool: 'Read', input: null })
const RESULT = (id) => ({ toolUseId: id, result: 'ok', truncated: false })
const kinds = (h) => h.getHistory('s1').map((e) => (e.type === 'message' ? e.messageType : e.type))
const reply = (h) => h.getHistory('s1').find((e) => e.messageType === 'response' && e.kind !== 'thinking')

function turn(h, steps) {
  h.recordHistory('s1', 'stream_start', { messageId: 'm1' })
  for (const step of steps) {
    if (typeof step === 'string') h.recordHistory('s1', 'stream_delta', { messageId: 'm1', delta: step })
    else { h.recordHistory('s1', 'tool_start', TOOL(step.tool)); h.recordHistory('s1', 'tool_result', RESULT(step.tool)) }
  }
}

describe('recording where tool calls interrupted a reply (#9024)', () => {
  it('text, tool, text: ONE response entry, at the end as before, carrying one split', () => {
    const h = new SessionMessageHistory()
    turn(h, ['Let me read it. ', { tool: 'tu1' }, 'It is one line.'])
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    assert.deepEqual(kinds(h), ['tool_start', 'tool_result', 'response'], 'same entries, same order as before')
    const entry = reply(h)
    assert.equal(entry.messageId, 'm1')
    assert.equal(entry.content, 'Let me read it. It is one line.')
    assert.deepEqual(entry.splits, [{ at: 'Let me read it. '.length, toolUseId: 'tu1' }])
    const seqs = h.getHistory('s1').map((e) => e._seq)
    assert.ok(seqs.every((n, i) => i === 0 || n > seqs[i - 1]), 'seqs strictly increase')
  })

  it('a turn with no tool has no splits field', () => {
    const h = new SessionMessageHistory()
    turn(h, ['Hello.'])
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    assert.equal('splits' in reply(h), false)
  })

  it('no text before the tool: no split', () => {
    const h = new SessionMessageHistory()
    turn(h, [{ tool: 'tu1' }, 'Done.'])
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    assert.equal('splits' in reply(h), false)
  })

  it('several tools in a row keep the first only', () => {
    const h = new SessionMessageHistory()
    turn(h, ['Reading both. ', { tool: 'tu1' }, { tool: 'tu2' }, 'Both read.'])
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    assert.deepEqual(reply(h).splits, [{ at: 'Reading both. '.length, toolUseId: 'tu1' }])
  })

  it('text, tool, text, tool, text: two splits with rising offsets', () => {
    const h = new SessionMessageHistory()
    turn(h, ['AA', { tool: 'tu1' }, 'BBB', { tool: 'tu2' }, 'C'])
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    assert.deepEqual(reply(h).splits, [{ at: 2, toolUseId: 'tu1' }, { at: 5, toolUseId: 'tu2' }])
  })

  it('a tool after the last text still records its split (the text ends at the card)', () => {
    const h = new SessionMessageHistory()
    turn(h, ['Running it.', { tool: 'tu1' }])
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    assert.deepEqual(reply(h).splits, [{ at: 'Running it.'.length, toolUseId: 'tu1' }])
  })

  it('a reasoning stream is untouched: no splits, same entry', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'stream_start', { messageId: 't1-thinking-0', thinking: true })
    h.recordHistory('s1', 'stream_delta', { messageId: 't1-thinking-0', delta: 'hmm' })
    h.recordHistory('s1', 'tool_start', TOOL('tu1'))
    h.recordHistory('s1', 'stream_end', { messageId: 't1-thinking-0', thinking: true })
    const thought = h.getHistory('s1').find((e) => e.kind === 'thinking')
    assert.equal(thought.content, 'hmm')
    assert.equal('splits' in thought, false)
  })

  it('a reasoning stream open beside a reply does not take the reply\'s splits', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'stream_start', { messageId: 'm1-thinking-0', thinking: true })
    h.recordHistory('s1', 'stream_delta', { messageId: 'm1-thinking-0', delta: 'plan' })
    h.recordHistory('s1', 'stream_start', { messageId: 'm1' })
    h.recordHistory('s1', 'stream_delta', { messageId: 'm1', delta: 'Go. ' })
    h.recordHistory('s1', 'tool_start', TOOL('tu1'))
    h.recordHistory('s1', 'stream_end', { messageId: 'm1-thinking-0', thinking: true })
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    assert.equal('splits' in h.getHistory('s1').find((e) => e.kind === 'thinking'), false)
    assert.deepEqual(reply(h).splits, [{ at: 4, toolUseId: 'tu1' }])
  })

  it('is bounded: at most MAX_REPLY_SPLITS, and an unusable tool id splits nothing', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'stream_start', { messageId: 'm1' })
    for (let i = 0; i < MAX_REPLY_SPLITS + 10; i++) {
      h.recordHistory('s1', 'stream_delta', { messageId: 'm1', delta: 'x' })
      h.recordHistory('s1', 'tool_start', TOOL(`tu${i}`))
    }
    h.recordHistory('s1', 'stream_delta', { messageId: 'm1', delta: 'y' })
    h.recordHistory('s1', 'tool_start', TOOL('t'.repeat(MAX_SPLIT_TOOL_ID_LENGTH + 1)))
    h.recordHistory('s1', 'tool_start', { messageId: 'x', toolUseId: undefined, tool: 'Read', input: null })
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    assert.equal(reply(h).splits.length, MAX_REPLY_SPLITS)
  })

  it('forgets its bookkeeping with the stream', () => {
    const h = new SessionMessageHistory()
    turn(h, ['a', { tool: 'tu1' }])
    assert.equal(h._streamSplits.size, 1)
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    assert.equal(h._streamSplits.size, 0)
    turn(h, ['a', { tool: 'tu2' }])
    h.closePendingStreams('s1')
    assert.equal(h._streamSplits.size, 0)
    turn(h, ['a', { tool: 'tu3' }])
    h.cleanupSession('s1')
    assert.equal(h._streamSplits.size, 0)
  })

  it('the entry keeps its splits through a state-file round trip', () => {
    const h = new SessionMessageHistory()
    turn(h, ['AA', { tool: 'tu1' }, 'BB'])
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    const persisted = JSON.parse(JSON.stringify(h.getHistory('s1').map((e) => h.truncateEntry(e))))
    const restored = new SessionMessageHistory()
    restored.setHistory('s1', persisted)
    assert.deepEqual(reply(restored).splits, [{ at: 2, toolUseId: 'tu1' }])
  })
})

describe('the open-stream snapshot carries the splits so far (#9023, #9024)', () => {
  it('reports the whole text so far with the splits it has', () => {
    const h = new SessionMessageHistory()
    turn(h, ['BEFORE ', { tool: 'tu1' }, 'AFTER'])
    const [only, ...rest] = h.getPendingResponseStreams('s1')
    assert.equal(rest.length, 0)
    assert.equal(only.content, 'BEFORE AFTER', 'whole text: the entry is one piece, so nothing is shown twice')
    assert.deepEqual(only.splits, [{ at: 7, toolUseId: 'tu1' }])
  })

  it('an unsplit stream reports no splits', () => {
    const h = new SessionMessageHistory()
    turn(h, ['text'])
    assert.deepEqual(h.getPendingResponseStreams('s1')[0].splits, [])
  })
})

async function replay(mgr, sessionId, clientRecord = {}, opts = {}) {
  const sent = []
  const ws = { readyState: 1, send() {}, close() {} }
  const ctx = {
    sessionManager: mgr,
    clients: new Map([[ws, { id: 'c1', activeSessionId: sessionId, clientCapabilities: new Set([CAPABILITY_HISTORY_INFLIGHT_REPLY]), ...clientRecord }]]),
    send: (_ws, payload) => sent.push(payload),
    permissions: null,
  }
  replayHistory(ctx, ws, sessionId, opts)
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
  return sent
}

function withManager(fn) {
  return async () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    try { await fn(mgr, 's1') } finally { mgr.destroyAll() }
  }
}

function rec(mgr, sid, steps) {
  mgr._recordHistory(sid, 'stream_start', { messageId: 'm1' })
  for (const step of steps) {
    if (typeof step === 'string') mgr._recordHistory(sid, 'stream_delta', { messageId: 'm1', delta: step })
    else if (step.end) mgr._recordHistory(sid, 'stream_end', { messageId: 'm1' })
    else { mgr._recordHistory(sid, 'tool_start', TOOL(step.tool)); mgr._recordHistory(sid, 'tool_result', RESULT(step.tool)) }
  }
}
const replies = (sent) => sent.filter((m) => m.type === 'message' && m.messageType === 'response')

describe('what a replay sends (#9024)', () => {
  it('the recorded entry goes out where it always did, with its splits, to any client', withManager(async (mgr, sid) => {
    mgr._recordHistory(sid, 'message', { type: 'user_input', content: 'go', timestamp: 1 })
    rec(mgr, sid, ['BEFORE ', { tool: 'tu1' }, 'AFTER', { end: true }])
    for (const caps of [[], [CAPABILITY_HISTORY_INFLIGHT_REPLY]]) {
      const sent = await replay(mgr, sid, { clientCapabilities: new Set(caps) }, { forceFull: true })
      const order = sent.filter((m) => m.type === 'message' || m.type === 'tool_start').map((m) => m.messageType || m.type)
      assert.deepEqual(order, ['user_input', 'tool_start', 'response'], 'no extra entry, no moved entry')
      const [r] = replies(sent)
      assert.equal(r.content, 'BEFORE AFTER')
      assert.deepEqual(r.splits, [{ at: 7, toolUseId: 'tu1' }])
    }
  }))

  it('Codex 1: an old client\'s delta replays across an open then closed split stream lose nothing and repeat nothing', withManager(async (mgr, sid) => {
    // An old client: has the in-flight capability, knows nothing of `splits`.
    mgr._recordHistory(sid, 'message', { type: 'user_input', content: 'go', timestamp: 1 })
    rec(mgr, sid, ['BEFORE ', { tool: 'tu1' }])
    const mid = await replay(mgr, sid, {}, { forceFull: true })
    assert.deepEqual(replies(mid).map((m) => m.content), ['BEFORE '], 'the open stream snapshot, whole text so far')
    const cursor = mgr.getLatestHistorySeq(sid)
    mgr._recordHistory(sid, 'stream_delta', { messageId: 'm1', delta: 'AFTER' })
    mgr._recordHistory(sid, 'stream_end', { messageId: 'm1' })
    const later = await replay(mgr, sid, { historyCursors: { [sid]: cursor } })
    // The client holds m1 = 'BEFORE ' from the snapshot; the closing entry is the whole
    // reply under the same id, which its existing completion path extends.
    assert.deepEqual(replies(later).map((m) => [m.messageId, m.content]), [['m1', 'BEFORE AFTER']])
  }))

  it('Codex 1 (variant): a client without the in-flight capability gets the reply when the stream closes, even if its text all came before a tool', withManager(async (mgr, sid) => {
    rec(mgr, sid, ['all of it', { tool: 'tu1' }])
    const mid = await replay(mgr, sid, { clientCapabilities: new Set() }, { forceFull: true })
    assert.deepEqual(replies(mid), [])
    const cursor = mgr.getLatestHistorySeq(sid)
    mgr._recordHistory(sid, 'stream_end', { messageId: 'm1' })
    const later = await replay(mgr, sid, { clientCapabilities: new Set(), historyCursors: { [sid]: cursor } })
    assert.deepEqual(replies(later).map((m) => m.content), ['all of it'])
  }))

  it('mid-turn: the snapshot is the whole text so far with its splits, at the place the reply began, and nothing else carries the text', withManager(async (mgr, sid) => {
    mgr._recordHistory(sid, 'message', { type: 'user_input', content: 'go', timestamp: 1 })
    rec(mgr, sid, ['BEFORE ', { tool: 'tu1' }, 'AFTER SO FAR'])
    for (const mode of [{ forceFull: true }, {}]) {
      const sent = await replay(mgr, sid, { historyCursors: { [sid]: 1 } }, mode)
      const rs = replies(sent)
      assert.equal(rs.length, 1, 'one reply entry: the text is never in two places')
      assert.equal(rs[0].content, 'BEFORE AFTER SO FAR')
      assert.equal(rs[0].historySeq, undefined)
      assert.deepEqual(rs[0].splits, [{ at: 7, toolUseId: 'tu1' }])
    }
  }))
})
