import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { replayHistory } from '../src/ws-history.js'

/**
 * #9022 -- a reply is recorded in history only when its stream closes, so a turn
 * paused mid-stream (on a permission prompt) had its streamed text in no replay:
 * a page reload restored the prompt and the tool card and none of what the model
 * had already said. The replay now carries the text streamed so far, at its place
 * in the transcript.
 *
 * Every SessionManager here uses a temp stateFilePath (#4633).
 */

let tmpDir
function tmpStateFile() {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'replay-inflight-'))
  return join(tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }) })

describe('SessionMessageHistory#getPendingResponseStreams (#9022)', () => {
  it('returns the text of an open stream, with where it opened', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'message', { type: 'user_input', content: 'go', timestamp: 1 })
    h.recordHistory('s1', 'stream_start', { messageId: 'm1' })
    h.recordHistory('s1', 'stream_delta', { messageId: 'm1', delta: 'line 1\n' })
    h.recordHistory('s1', 'stream_delta', { messageId: 'm1', delta: 'line 2\n' })
    const [only, ...rest] = h.getPendingResponseStreams('s1')
    assert.equal(rest.length, 0)
    assert.equal(only.messageId, 'm1')
    assert.equal(only.content, 'line 1\nline 2\n')
    assert.equal(only.startSeq, 2, 'the seq the next entry took when the stream opened')
  })

  it('is empty once the stream closes (the recorded entry takes over)', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'stream_start', { messageId: 'm1' })
    h.recordHistory('s1', 'stream_delta', { messageId: 'm1', delta: 'hi' })
    h.recordHistory('s1', 'stream_end', { messageId: 'm1' })
    assert.deepEqual(h.getPendingResponseStreams('s1'), [])
    assert.equal(h.getHistory('s1').filter((e) => e.messageType === 'response').length, 1)
    assert.equal(h._streamStartSeqs.size, 0, 'no start seq outlives its stream')
  })

  it('skips a stream with no text yet, a reasoning stream, and other sessions', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'stream_start', { messageId: 'empty' })
    h.recordHistory('s1', 'stream_start', { messageId: 'think', thinking: true })
    h.recordHistory('s1', 'stream_delta', { messageId: 'think', delta: 'hmm' })
    h.recordHistory('s2', 'stream_start', { messageId: 'other' })
    h.recordHistory('s2', 'stream_delta', { messageId: 'other', delta: 'x' })
    assert.deepEqual(h.getPendingResponseStreams('s1'), [])
  })

  it('forgets a stream when its session is cleaned up or its streams are closed', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'stream_start', { messageId: 'm1' })
    h.recordHistory('s1', 'stream_delta', { messageId: 'm1', delta: 'hi' })
    h.closePendingStreams('s1')
    assert.deepEqual(h.getPendingResponseStreams('s1'), [])
    h.recordHistory('s1', 'stream_start', { messageId: 'm2' })
    h.recordHistory('s1', 'stream_delta', { messageId: 'm2', delta: 'hi' })
    h.cleanupSession('s1')
    assert.deepEqual(h.getPendingResponseStreams('s1'), [])
    assert.equal(h._streamStartSeqs.size, 0, 'no start seq outlives its stream')
  })
})

async function replay(mgr, sessionId, clientRecord, opts) {
  const sent = []
  const ws = { readyState: 1, send() {}, close() {} }
  const ctx = {
    sessionManager: mgr,
    clients: new Map([[ws, { id: 'c1', activeSessionId: sessionId, ...clientRecord }]]),
    send: (_ws, payload) => sent.push(payload),
    permissions: null,
  }
  replayHistory(ctx, ws, sessionId, opts)
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
  return sent
}

/** The owner path: text streams, the tool starts, and the turn waits on a prompt. */
function pausedTurn(mgr, sid) {
  mgr._recordHistory(sid, 'message', { type: 'user_input', content: 'do it', timestamp: 1 })
  mgr._recordHistory(sid, 'stream_start', { messageId: 'm1' })
  mgr._recordHistory(sid, 'stream_delta', { messageId: 'm1', delta: 'STREAM-LINE 1\n' })
  mgr._recordHistory(sid, 'stream_delta', { messageId: 'm1', delta: 'STREAM-LINE 2\n' })
  mgr._recordHistory(sid, 'tool_start', { messageId: 'toolu_1', toolUseId: 'toolu_1', tool: 'Bash', input: null })
}

function withManager(fn) {
  return async () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    try {
      await fn(mgr, 's1')
    } finally {
      mgr.destroyAll()
    }
  }
}

describe('a replay carries the reply text streamed so far (#9022)', () => {
  it('a full replay sends it before the tool that followed it, and nothing twice', withManager(async (mgr, sid) => {
    pausedTurn(mgr, sid)
    const sent = await replay(mgr, sid, {}, { forceFull: true })
    const frames = sent.filter((m) => m.type === 'message' || m.type === 'tool_start')
    assert.deepEqual(frames.map((m) => m.messageType || m.type), ['user_input', 'response', 'tool_start'])
    const reply = frames[1]
    assert.equal(reply.messageId, 'm1')
    assert.equal(reply.content, 'STREAM-LINE 1\nSTREAM-LINE 2\n')
    assert.equal(reply.historySeq, undefined, 'it is no recorded entry: a client advances no cursor off it')
    assert.equal(sent.at(-1).type, 'history_replay_end')
  }))

  it('a reply opened after the last recorded entry is sent last', withManager(async (mgr, sid) => {
    mgr._recordHistory(sid, 'message', { type: 'user_input', content: 'go', timestamp: 1 })
    mgr._recordHistory(sid, 'stream_start', { messageId: 'm1' })
    mgr._recordHistory(sid, 'stream_delta', { messageId: 'm1', delta: 'partial' })
    const sent = await replay(mgr, sid, {}, { forceFull: true })
    const kinds = sent.filter((m) => m.type === 'message').map((m) => m.messageType)
    assert.deepEqual(kinds, ['user_input', 'response'])
  }))

  it('a delta replay omits a stream the client already saw open, and sends one it did not', withManager(async (mgr, sid) => {
    pausedTurn(mgr, sid)
    const lastSeq = mgr.getLatestHistorySeq(sid)
    // The client is current: it watched the reply stream, and holds its own copy.
    let sent = await replay(mgr, sid, { historyCursors: { [sid]: lastSeq } })
    assert.equal(sent[0].fullHistory, false)
    assert.equal(sent.filter((m) => m.type === 'message').length, 0)

    // The client's cursor predates the stream: it never saw the reply start.
    sent = await replay(mgr, sid, { historyCursors: { [sid]: 1 } })
    assert.equal(sent[0].fullHistory, false)
    const replies = sent.filter((m) => m.type === 'message' && m.messageType === 'response')
    assert.equal(replies.length, 1)
    assert.equal(replies[0].content, 'STREAM-LINE 1\nSTREAM-LINE 2\n')
  }))

  it('once the stream closes the recorded entry replaces it: still one reply', withManager(async (mgr, sid) => {
    pausedTurn(mgr, sid)
    mgr._recordHistory(sid, 'stream_end', { messageId: 'm1' })
    const sent = await replay(mgr, sid, {}, { forceFull: true })
    const replies = sent.filter((m) => m.type === 'message' && m.messageType === 'response')
    assert.equal(replies.length, 1)
    assert.equal(typeof replies[0].historySeq, 'number', 'the recorded entry, not a synthesized one')
  }))

  it('does not touch the ring buffer', withManager(async (mgr, sid) => {
    pausedTurn(mgr, sid)
    const before = mgr.getHistory(sid).length
    await replay(mgr, sid, {}, { forceFull: true })
    assert.equal(mgr.getHistory(sid).length, before)
    assert.equal(mgr.getHistory(sid).some((e) => e.messageType === 'response'), false)
  }))
})
