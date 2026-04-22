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
})
