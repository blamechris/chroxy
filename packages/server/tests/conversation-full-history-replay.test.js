import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { createMockSessionManager, nsCtx } from './test-helpers.js'

/**
 * #7454 — `request_full_history` is the SECOND replay path (the first is
 * ws-history.js's `replayHistory`), and the #7420 live-vs-replayed
 * discriminator keys on `historySeq` PRESENCE. A ring-buffer `user_question`
 * forwarded raw (no `_seq` → `historySeq` mapping) reads as a live racer on
 * the client and is left unstamped at replay-end — and the raw `_seq` was
 * leaking onto the wire besides.
 */
describe('#7454 — request_full_history maps _seq onto the wire like replayHistory does', () => {
  const handler = conversationHandlers.request_full_history

  function build(historyEntries) {
    const sends = []
    const { manager } = createMockSessionManager([{ id: 'sess-1', name: 'Work', cwd: '/repo' }])
    manager.getFullHistoryAsync = async () => historyEntries
    const ctx = nsCtx({
      send: (ws, msg) => sends.push(msg),
      sessionManager: manager,
      reseedActiveAgents: () => {},
    })
    return { ctx, sends }
  }

  it('stamps historySeq on a ring-buffer user_question and never leaks the raw _seq', async () => {
    const { ctx, sends } = build([
      { type: 'user_question', toolUseId: 't1', questions: [], timestamp: 123, _seq: 7 },
      { type: 'response', content: 'Hi', timestamp: 124 },
    ])
    await handler({}, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'request_full_history' }, ctx)
    const q = sends.find(m => m.type === 'user_question')
    assert.ok(q, 'the user_question entry is forwarded')
    assert.equal(q.historySeq, 7, 'the internal _seq must surface as historySeq — the #7420 discriminator keys on it')
    assert.ok(!('_seq' in q), 'the internal counter must not leak onto the wire')
  })

  it('POSITIVE CONTROL: an entry with no _seq goes out with NO historySeq key', async () => {
    // Absence is the live signal — manufacturing a historySeq here would be
    // as wrong as omitting a real one.
    const { ctx, sends } = build([
      { type: 'user_question', toolUseId: 't2', questions: [], timestamp: 125 },
    ])
    await handler({}, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'request_full_history' }, ctx)
    const q = sends.find(m => m.type === 'user_question')
    assert.ok(q)
    assert.ok(!('historySeq' in q), 'no _seq means no historySeq — never null, never fabricated')
  })

  it('still brackets the forward with history_replay_start/end and rebuilds message-branch entries', async () => {
    const { ctx, sends } = build([
      { type: 'response', content: 'Hi', timestamp: 1, _seq: 3 },
      { type: 'user_question', toolUseId: 't3', questions: [], timestamp: 2, _seq: 4 },
    ])
    await handler({}, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'request_full_history' }, ctx)
    assert.equal(sends[0].type, 'history_replay_start')
    assert.equal(sends[sends.length - 1].type, 'history_replay_end')
    const rebuilt = sends.find(m => m.type === 'message')
    assert.equal(rebuilt.messageType, 'response')
    assert.ok(!('_seq' in rebuilt), 'the message branch never carried _seq and must not start')
  })
})
