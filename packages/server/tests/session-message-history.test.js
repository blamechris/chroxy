import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SessionMessageHistory } from '../src/session-message-history.js'

describe('SessionMessageHistory', () => {
  let history

  beforeEach(() => {
    history = new SessionMessageHistory({ maxHistory: 10 })
  })

  describe('constructor', () => {
    it('defaults maxMessages to 1000', () => {
      const h = new SessionMessageHistory()
      assert.equal(h.maxMessages, 1000)
      assert.equal(h.maxHistory, 1000)
    })

    it('accepts custom maxMessages option', () => {
      const h = new SessionMessageHistory({ maxMessages: 50 })
      assert.equal(h.maxMessages, 50)
    })

    it('accepts custom maxHistory option (legacy alias)', () => {
      assert.equal(history.maxHistory, 10)
    })

    it('maxMessages takes precedence over maxHistory when both provided', () => {
      const h = new SessionMessageHistory({ maxMessages: 200, maxHistory: 100 })
      assert.equal(h.maxMessages, 200)
    })
  })

  describe('getHistory / getHistoryCount', () => {
    it('returns empty array for unknown session', () => {
      assert.deepStrictEqual(history.getHistory('unknown'), [])
      assert.equal(history.getHistoryCount('unknown'), 0)
    })

    it('returns recorded messages', () => {
      history.recordHistory('s1', 'message', {
        type: 'user_input',
        content: 'hello',
        timestamp: 1,
      })
      assert.equal(history.getHistoryCount('s1'), 1)
      assert.equal(history.getHistory('s1')[0].content, 'hello')
    })
  })

  describe('ring buffer max size enforcement', () => {
    it('trims history when exceeding maxHistory', () => {
      for (let i = 0; i < 15; i++) {
        history.recordHistory('s1', 'message', {
          type: 'user_input',
          content: `msg-${i}`,
          timestamp: i,
        })
      }
      assert.equal(history.getHistoryCount('s1'), 10)
      // First 5 should have been evicted
      assert.equal(history.getHistory('s1')[0].content, 'msg-5')
      assert.equal(history.getHistory('s1')[9].content, 'msg-14')
    })

    it('marks session as truncated after overflow', () => {
      assert.equal(history.isHistoryTruncated('s1'), false)
      for (let i = 0; i < 11; i++) {
        history.recordHistory('s1', 'message', {
          type: 'user_input',
          content: `msg-${i}`,
          timestamp: i,
        })
      }
      assert.equal(history.isHistoryTruncated('s1'), true)
    })

    it('returns false for unknown session truncation', () => {
      assert.equal(history.isHistoryTruncated('nonexistent'), false)
    })

    it('evicts oldest message when maxMessages is exceeded', () => {
      const h = new SessionMessageHistory({ maxMessages: 3 })
      h.recordHistory('s1', 'message', { type: 'user_input', content: 'a', timestamp: 1 })
      h.recordHistory('s1', 'message', { type: 'user_input', content: 'b', timestamp: 2 })
      h.recordHistory('s1', 'message', { type: 'user_input', content: 'c', timestamp: 3 })
      h.recordHistory('s1', 'message', { type: 'user_input', content: 'd', timestamp: 4 }) // evicts 'a'

      const msgs = h.getHistory('s1')
      assert.equal(msgs.length, 3)
      assert.equal(msgs[0].content, 'b') // oldest remaining
      assert.equal(msgs[2].content, 'd')
    })

    it('uses default maxMessages of 1000', () => {
      const h = new SessionMessageHistory()
      for (let i = 0; i < 1001; i++) {
        h.recordHistory('s1', 'message', { type: 'user_input', content: `msg-${i}`, timestamp: i })
      }
      assert.equal(h.getHistoryCount('s1'), 1000)
      assert.equal(h.getHistory('s1')[0].content, 'msg-1') // msg-0 evicted
    })

    it('does not evict when below the limit', () => {
      const h = new SessionMessageHistory({ maxMessages: 100 })
      h.recordHistory('s1', 'message', { type: 'user_input', content: 'first', timestamp: 1 })
      h.recordHistory('s1', 'message', { type: 'user_input', content: 'second', timestamp: 2 })
      assert.equal(h.getHistoryCount('s1'), 2)
    })
  })

  describe('stream delta accumulation', () => {
    it('accumulates stream deltas into a complete message on stream_end', () => {
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-1' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-1', delta: 'Hello ' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-1', delta: 'world' })
      const result = history.recordHistory('s1', 'stream_end', { messageId: 'msg-1' })

      assert.equal(result.persistNeeded, true)
      assert.equal(history.getHistoryCount('s1'), 1)
      const entry = history.getHistory('s1')[0]
      assert.equal(entry.type, 'message')
      assert.equal(entry.messageType, 'response')
      assert.equal(entry.content, 'Hello world')
    })

    it('handles stream_end with no prior deltas', () => {
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-1' })
      history.recordHistory('s1', 'stream_end', { messageId: 'msg-1' })

      // Empty content means nothing is pushed to history
      assert.equal(history.getHistoryCount('s1'), 0)
    })

    it('ignores stream_delta for unknown messageId', () => {
      history.recordHistory('s1', 'stream_delta', { messageId: 'unknown', delta: 'data' })
      assert.equal(history.pendingStreams.size, 0)
    })

    it('enforces 100MB size limit on pending streams', () => {
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-1' })

      // Write a large chunk just under the limit
      const bigDelta = 'x'.repeat(100 * 1024 * 1024 - 10)
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-1', delta: bigDelta })

      // This should be rejected (would exceed limit)
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-1', delta: 'x'.repeat(20) })

      // The pending stream should still have the original content (not the overflow)
      const key = 's1:msg-1'
      assert.equal(history.pendingStreams.get(key).length, bigDelta.length)
    })
  })

  describe('recordUserInput', () => {
    it('records user input in history', () => {
      history.recordUserInput('s1', 'hello world')
      assert.equal(history.getHistoryCount('s1'), 1)
      const entry = history.getHistory('s1')[0]
      assert.equal(entry.messageType, 'user_input')
      assert.equal(entry.content, 'hello world')
    })

    it('records user input without session entry (no auto-label)', () => {
      history.recordUserInput('s1', 'test message')
      assert.equal(history.getHistoryCount('s1'), 1)
    })

    it('stores messageId when provided and omits it when absent (issue #2902)', () => {
      history.recordUserInput('s1', 'with id', undefined, 'uin-abc123')
      history.recordUserInput('s1', 'without id')
      const entries = history.getHistory('s1')
      assert.equal(entries[0].messageId, 'uin-abc123',
        `expected stable messageId preserved for id-based dedup on reconnect`)
      assert.equal(entries[1].messageId, undefined,
        `expected no messageId when caller did not supply one`)
    })

    it('ignores empty or non-string messageId values', () => {
      history.recordUserInput('s1', 'empty string', undefined, '')
      history.recordUserInput('s1', 'not-a-string', undefined, 123)
      const entries = history.getHistory('s1')
      assert.equal(entries[0].messageId, undefined)
      assert.equal(entries[1].messageId, undefined)
    })
  })

  describe('auto-labeling', () => {
    it('emits auto_label for first user input on default-named session', () => {
      const entry = { name: 'Session 1', _autoLabeled: false }
      const events = []
      history.on('auto_label', (data) => events.push(data))

      history.recordUserInput('s1', 'Fix the login bug', entry)

      assert.equal(events.length, 1)
      assert.equal(events[0].sessionId, 's1')
      assert.equal(events[0].label, 'Fix the login bug')
      assert.equal(entry.name, 'Fix the login bug')
      assert.equal(entry._autoLabeled, true)
    })

    it('truncates long labels at word boundary', () => {
      const entry = { name: 'Session 1', _autoLabeled: false }
      const events = []
      history.on('auto_label', (data) => events.push(data))

      const longText = 'This is a very long message that exceeds the forty character limit for labels'
      history.recordUserInput('s1', longText, entry)

      assert.equal(events.length, 1)
      assert.ok(events[0].label.length <= 43) // 40 + '...'
      assert.ok(events[0].label.endsWith('...'))
    })

    it('does not auto-label already-labeled sessions', () => {
      const entry = { name: 'Session 1', _autoLabeled: true }
      const events = []
      history.on('auto_label', (data) => events.push(data))

      history.recordUserInput('s1', 'some text', entry)
      assert.equal(events.length, 0)
    })

    it('does not auto-label custom-named sessions', () => {
      const entry = { name: 'My Custom Session', _autoLabeled: false }
      const events = []
      history.on('auto_label', (data) => events.push(data))

      history.recordUserInput('s1', 'some text', entry)
      assert.equal(events.length, 0)
    })

    it('does not auto-label on empty text', () => {
      const entry = { name: 'Session 1', _autoLabeled: false }
      const events = []
      history.on('auto_label', (data) => events.push(data))

      history.recordUserInput('s1', '   ', entry)
      assert.equal(events.length, 0)
      assert.equal(entry._autoLabeled, false)
    })

    it('skips attachment-only markers', () => {
      const entry = { name: 'Session 1', _autoLabeled: false }
      const events = []
      history.on('auto_label', (data) => events.push(data))

      history.recordUserInput('s1', '[2 file(s) attached]', entry)
      assert.equal(events.length, 0)
      assert.equal(entry._autoLabeled, false)
    })

    it('auto-labels "New Session" names', () => {
      const entry = { name: 'New Session', _autoLabeled: false }
      const events = []
      history.on('auto_label', (data) => events.push(data))

      history.recordUserInput('s1', 'Deploy to prod', entry)
      assert.equal(events.length, 1)
      assert.equal(events[0].label, 'Deploy to prod')
    })
  })

  describe('event types', () => {
    it('records tool_start events', () => {
      history.recordHistory('s1', 'tool_start', {
        messageId: 'msg-1',
        toolUseId: 'tu-1',
        tool: 'read_file',
        input: '/path/to/file',
      })
      const entry = history.getHistory('s1')[0]
      assert.equal(entry.type, 'tool_start')
      assert.equal(entry.tool, 'read_file')
    })

    it('records tool_result events', () => {
      history.recordHistory('s1', 'tool_result', {
        toolUseId: 'tu-1',
        result: 'file content',
        truncated: false,
      })
      const entry = history.getHistory('s1')[0]
      assert.equal(entry.type, 'tool_result')
      assert.equal(entry.result, 'file content')
    })

    it('records result events and signals persist needed', () => {
      const result = history.recordHistory('s1', 'result', {
        cost: 0.05,
        duration: 1234,
        usage: { input: 100, output: 50 },
      })
      assert.equal(result.persistNeeded, true)
      const entry = history.getHistory('s1')[0]
      assert.equal(entry.type, 'result')
      assert.equal(entry.cost, 0.05)
    })

    it('records user_question events', () => {
      history.recordHistory('s1', 'user_question', {
        toolUseId: 'tu-1',
        questions: ['Continue?'],
      })
      const entry = history.getHistory('s1')[0]
      assert.equal(entry.type, 'user_question')
    })
  })

  describe('truncateEntry', () => {
    it('does not truncate entries under 50KB', () => {
      const entry = { type: 'message', content: 'short', input: 'also short' }
      const result = history.truncateEntry(entry)
      assert.equal(result.content, 'short')
      assert.equal(result.input, 'also short')
    })

    it('truncates content over 50KB', () => {
      const longContent = 'x'.repeat(100 * 1024)
      const entry = { type: 'message', content: longContent }
      const result = history.truncateEntry(entry)
      assert.ok(result.content.length < 60 * 1024)
      assert.ok(result.content.endsWith('[truncated]'))
      // Original should be unchanged (shallow clone)
      assert.equal(entry.content.length, 100 * 1024)
    })

    it('truncates input over 50KB', () => {
      const longInput = 'y'.repeat(100 * 1024)
      const entry = { type: 'tool_start', input: longInput }
      const result = history.truncateEntry(entry)
      assert.ok(result.input.endsWith('[truncated]'))
      assert.equal(entry.input.length, 100 * 1024)
    })
  })

  describe('setHistory', () => {
    it('sets pre-existing history for a session', () => {
      const existing = [{ type: 'message', content: 'restored' }]
      history.setHistory('s1', existing)
      assert.equal(history.getHistoryCount('s1'), 1)
      assert.equal(history.getHistory('s1')[0].content, 'restored')
    })
  })

  describe('cleanupSession', () => {
    it('removes all state for a session', () => {
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'hello', timestamp: 1 })
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-1' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-1', delta: 'partial' })

      // Also add an entry for another session to verify isolation
      history.recordHistory('s2', 'message', { type: 'user_input', content: 'other', timestamp: 2 })

      history.cleanupSession('s1')

      assert.equal(history.getHistoryCount('s1'), 0)
      assert.equal(history.isHistoryTruncated('s1'), false)
      assert.equal(history.pendingStreams.has('s1:msg-1'), false)
      // s2 should be unaffected
      assert.equal(history.getHistoryCount('s2'), 1)
    })
  })

  describe('closePendingStreams', () => {
    it('returns closed messageIds and removes them from the map', () => {
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-a' })
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-b' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-a', delta: 'partial' })

      const closed = history.closePendingStreams('s1')

      assert.equal(closed.length, 2)
      assert.ok(closed.includes('msg-a'))
      assert.ok(closed.includes('msg-b'))
      assert.equal(history.pendingStreams.size, 0)
    })

    it('does not affect streams from other sessions', () => {
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-1' })
      history.recordHistory('s2', 'stream_start', { messageId: 'msg-2' })

      const closed = history.closePendingStreams('s1')

      assert.equal(closed.length, 1)
      assert.equal(closed[0], 'msg-1')
      assert.equal(history.pendingStreams.has('s1:msg-1'), false)
      assert.equal(history.pendingStreams.has('s2:msg-2'), true)
    })

    it('returns empty array when session has no pending streams', () => {
      const closed = history.closePendingStreams('nonexistent')
      assert.deepStrictEqual(closed, [])
    })
  })

  describe('clear', () => {
    it('clears all state', () => {
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'hello', timestamp: 1 })
      history.recordHistory('s2', 'message', { type: 'user_input', content: 'world', timestamp: 2 })
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-1' })

      history.clear()

      assert.equal(history.getHistoryCount('s1'), 0)
      assert.equal(history.getHistoryCount('s2'), 0)
      assert.equal(history.pendingStreams.size, 0)
    })
  })

  // #4617 — session restore must not zombify the dashboard's activeTools pill.
  // When a session was wedged on a tool at shutdown, the persisted history has
  // a tool_start without a matching tool_result. The sweep synthesises the
  // missing tool_result so history replay → handleToolResult → applyToActiveTools
  // clears the entry on reconnect.
  describe('sweepUnresolvedToolStarts (static)', () => {
    it('injects a synthetic tool_result for an unresolved tool_start', () => {
      const input = [
        { type: 'tool_start', toolUseId: 'A', tool: 'AskUserQuestion', timestamp: 1000 },
        { type: 'tool_start', toolUseId: 'B', tool: 'Bash', timestamp: 2000 },
        { type: 'tool_result', toolUseId: 'B', result: 'ok', timestamp: 2500 },
      ]
      const out = SessionMessageHistory.sweepUnresolvedToolStarts(input)

      assert.equal(out.length, 4, 'one synthetic result spliced after the orphan tool_start')
      assert.equal(out[0].type, 'tool_start')
      assert.equal(out[0].toolUseId, 'A')
      assert.equal(out[1].type, 'tool_result')
      assert.equal(out[1].toolUseId, 'A')
      assert.equal(out[1].synthetic, true)
      assert.equal(out[1].interrupted, true)
      assert.equal(out[1].isError, true)
      assert.equal(out[1].reason, 'session_restored')
      // The matched B pair must remain untouched and in order.
      assert.equal(out[2].type, 'tool_start')
      assert.equal(out[2].toolUseId, 'B')
      assert.equal(out[3].type, 'tool_result')
      assert.equal(out[3].toolUseId, 'B')
      assert.notEqual(out[3].synthetic, true)
    })

    it('is a no-op when every tool_start already has a matching tool_result', () => {
      const input = [
        { type: 'tool_start', toolUseId: 'A', tool: 'Read', timestamp: 1000 },
        { type: 'tool_result', toolUseId: 'A', result: 'ok', timestamp: 1100 },
        { type: 'tool_start', toolUseId: 'B', tool: 'Bash', timestamp: 2000 },
        { type: 'tool_result', toolUseId: 'B', result: 'ok', timestamp: 2100 },
      ]
      const out = SessionMessageHistory.sweepUnresolvedToolStarts(input)
      assert.equal(out.length, input.length, 'no synthetic entries when all pairs are matched')
      for (let i = 0; i < input.length; i++) {
        assert.deepStrictEqual(out[i], input[i])
      }
    })

    it('flags synthetic results with synthetic + interrupted + isError', () => {
      const input = [{ type: 'tool_start', toolUseId: 'X', tool: 'AskUserQuestion', timestamp: 5000 }]
      const out = SessionMessageHistory.sweepUnresolvedToolStarts(input)
      assert.equal(out.length, 2)
      const synthetic = out[1]
      assert.equal(synthetic.type, 'tool_result')
      assert.equal(synthetic.toolUseId, 'X')
      assert.equal(synthetic.synthetic, true)
      assert.equal(synthetic.interrupted, true)
      assert.equal(synthetic.isError, true)
      assert.equal(synthetic.reason, 'session_restored')
      assert.equal(typeof synthetic.result, 'string')
      assert.ok(synthetic.result.length > 0)
    })

    it('keeps the synthetic timestamp strictly greater than the tool_start timestamp', () => {
      const input = [{ type: 'tool_start', toolUseId: 'X', tool: 'Read', timestamp: 1700000000000 }]
      const out = SessionMessageHistory.sweepUnresolvedToolStarts(input)
      assert.equal(out[1].timestamp, 1700000000001)
      assert.ok(out[1].timestamp > out[0].timestamp, 'timestamp monotonicity preserved')
    })

    it('does not mutate the input array', () => {
      const input = [
        { type: 'tool_start', toolUseId: 'A', tool: 'Bash', timestamp: 1000 },
      ]
      const originalLength = input.length
      const copy = JSON.parse(JSON.stringify(input))
      const out = SessionMessageHistory.sweepUnresolvedToolStarts(input)
      // Belt-and-braces: assert array identity differs AND length/contents are
      // unchanged. The deep-equal alone would miss a regression where
      // someone refactors to `history.splice(...)` and the splice happens to
      // leave the test fixture's values identical by accident.
      assert.notStrictEqual(out, input, 'sweep must return a new array, not the input')
      assert.equal(input.length, originalLength, 'input length unchanged')
      assert.deepStrictEqual(input, copy, 'input array left intact for crash-safe re-restore')
    })

    it('handles empty / non-array input gracefully', () => {
      assert.deepStrictEqual(SessionMessageHistory.sweepUnresolvedToolStarts([]), [])
      assert.equal(SessionMessageHistory.sweepUnresolvedToolStarts(null), null)
      assert.equal(SessionMessageHistory.sweepUnresolvedToolStarts(undefined), undefined)
    })

    it('falls back to Date.now() when tool_start has no usable timestamp', () => {
      // A pre-shutdown bug or older state file could persist a tool_start
      // without a timestamp. The sweep must still produce a synthetic result;
      // base on Date.now() so order is at least "recent" rather than negative.
      const before = Date.now()
      const out = SessionMessageHistory.sweepUnresolvedToolStarts([
        { type: 'tool_start', toolUseId: 'A', tool: 'Read' },
      ])
      const after = Date.now()
      assert.equal(out.length, 2)
      assert.ok(out[1].timestamp >= before + 1)
      assert.ok(out[1].timestamp <= after + 1)
    })

    it('only emits one synthetic result per toolUseId even if duplicate tool_starts appear', () => {
      // Defence-in-depth: a malformed/concatenated history with two
      // tool_starts sharing a toolUseId would otherwise produce two
      // synthetics that both target the same activeTools entry.
      const input = [
        { type: 'tool_start', toolUseId: 'A', tool: 'Read', timestamp: 1000 },
        { type: 'tool_start', toolUseId: 'A', tool: 'Read', timestamp: 2000 },
      ]
      const out = SessionMessageHistory.sweepUnresolvedToolStarts(input)
      const synthetics = out.filter(e => e.type === 'tool_result' && e.synthetic === true)
      assert.equal(synthetics.length, 1)
    })
  })

  // #5555.3 — monotonic per-session history seq used by lastSeq delta replay.
  describe('history seq (#5555.3)', () => {
    it('stamps a strictly increasing 1-based _seq on each pushed entry', () => {
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'a', timestamp: 1 })
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'b', timestamp: 2 })
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'c', timestamp: 3 })
      const seqs = history.getHistory('s1').map(e => e._seq)
      assert.deepStrictEqual(seqs, [1, 2, 3])
    })

    it('keeps seq climbing past a ring-buffer front-trim (gap detection input)', () => {
      const h = new SessionMessageHistory({ maxMessages: 3 })
      for (let i = 0; i < 5; i++) {
        h.recordHistory('s1', 'message', { type: 'user_input', content: `m${i}`, timestamp: i })
      }
      // Buffer holds the last 3 entries; their seqs are 3,4,5 (1 and 2 trimmed).
      assert.deepStrictEqual(h.getHistory('s1').map(e => e._seq), [3, 4, 5])
      assert.equal(h.getOldestSeq('s1'), 3)
      assert.equal(h.getLatestSeq('s1'), 5)
    })

    it('seq is per-session (counters do not bleed across sessions)', () => {
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'a', timestamp: 1 })
      history.recordHistory('s2', 'message', { type: 'user_input', content: 'x', timestamp: 1 })
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'b', timestamp: 2 })
      assert.deepStrictEqual(history.getHistory('s1').map(e => e._seq), [1, 2])
      assert.deepStrictEqual(history.getHistory('s2').map(e => e._seq), [1])
    })

    it('getOldestSeq/getLatestSeq on an empty session', () => {
      assert.equal(history.getOldestSeq('nope'), null)
      assert.equal(history.getLatestSeq('nope'), 0)
    })

    it('setHistory re-stamps restored entries 1..N and advances the counter', () => {
      history.setHistory('s1', [
        { type: 'message', content: 'a' },
        { type: 'message', content: 'b' },
      ])
      assert.deepStrictEqual(history.getHistory('s1').map(e => e._seq), [1, 2])
      // Next recorded entry continues the sequence.
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'c', timestamp: 1 })
      assert.equal(history.getHistory('s1')[2]._seq, 3)
    })

    it('truncateEntry strips _seq so it never reaches the persisted state file', () => {
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'a', timestamp: 1 })
      const entry = history.getHistory('s1')[0]
      assert.equal(entry._seq, 1)
      const serialized = history.truncateEntry(entry)
      assert.equal(serialized._seq, undefined)
      // original entry retains its seq (truncateEntry clones)
      assert.equal(entry._seq, 1)
    })

    it('cleanupSession resets the seq counter for that session', () => {
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'a', timestamp: 1 })
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'b', timestamp: 2 })
      history.cleanupSession('s1')
      history.recordHistory('s1', 'message', { type: 'user_input', content: 'c', timestamp: 3 })
      assert.equal(history.getHistory('s1')[0]._seq, 1)
    })
  })
})
