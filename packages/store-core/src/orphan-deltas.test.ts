/**
 * Direct unit tests for applyOrphanDeltas (#3182).
 *
 * The helper has three load-bearing branches:
 *   1. No collision — append a fresh `response` message at the message id.
 *   2. Collision (existing non-response at the id, e.g. `tool_use`) — use
 *      a suffixed id `${msgId}-response` and record the remap so future
 *      `stream_delta` events route to the suffixed message.
 *   3. Existing matching response at the (possibly suffixed) id — concatenate
 *      delta onto its content via index assignment.
 *
 * The helper also mutates `messages` in place (push / index assignment) — that
 * contract matters because the dashboard/app callers pass the result of a
 * `messages.map(...)` and expect the orphans appended to the same reference.
 *
 * Higher-level message-handler tests already cover the integration paths;
 * these direct tests lock the contract so a future refactor of any single
 * branch can't silently regress before the integration layer notices.
 */
import { describe, it, expect } from 'vitest'
import type { ChatMessage } from './types'
import { applyOrphanDeltas } from './orphan-deltas'

function makeMessage(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    type: 'response',
    content: '',
    timestamp: 1,
    ...overrides,
  }
}

describe('applyOrphanDeltas', () => {
  describe('branch 1: no collision', () => {
    it('appends a fresh response message when the id is unused', () => {
      const messages: ChatMessage[] = []
      const deltas = new Map([['m-1', 'hello']])
      const matched = new Set<string>()
      const remaps = new Map<string, string>()

      applyOrphanDeltas(messages, deltas, matched, remaps)

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: 'm-1',
        type: 'response',
        content: 'hello',
      })
      expect(remaps.size).toBe(0)
    })

    it('does not register a remap for the no-collision case', () => {
      const messages: ChatMessage[] = [
        makeMessage({ id: 'm-other', type: 'response', content: 'unrelated' }),
      ]
      const deltas = new Map([['m-1', 'world']])
      const matched = new Set<string>()
      const remaps = new Map<string, string>()

      applyOrphanDeltas(messages, deltas, matched, remaps)

      expect(remaps.has('m-1')).toBe(false)
      expect(messages.find(m => m.id === 'm-1')?.content).toBe('world')
    })

    it('appends multiple orphans in iteration order', () => {
      const messages: ChatMessage[] = []
      const deltas = new Map([
        ['m-a', 'A'],
        ['m-b', 'B'],
        ['m-c', 'C'],
      ])

      applyOrphanDeltas(messages, deltas, new Set(), new Map())

      expect(messages.map(m => m.id)).toEqual(['m-a', 'm-b', 'm-c'])
      expect(messages.map(m => m.content)).toEqual(['A', 'B', 'C'])
    })
  })

  describe('branch 2: collision with non-response message (tool_use)', () => {
    it('uses suffixed id and registers the remap', () => {
      const messages: ChatMessage[] = [
        makeMessage({ id: 'msg-1', type: 'tool_use', content: 'ls', tool: 'Bash' }),
      ]
      const deltas = new Map([['msg-1', 'hello']])
      const remaps = new Map<string, string>()

      applyOrphanDeltas(messages, deltas, new Set(), remaps)

      // Original tool_use untouched
      expect(messages[0]).toMatchObject({ id: 'msg-1', type: 'tool_use', content: 'ls' })
      // Suffixed response message appended
      expect(messages[1]).toMatchObject({
        id: 'msg-1-response',
        type: 'response',
        content: 'hello',
      })
      // Remap recorded so future stream_delta events route to the suffix
      expect(remaps.get('msg-1')).toBe('msg-1-response')
    })

    it('treats other non-response types (thinking) as collision too', () => {
      const messages: ChatMessage[] = [
        makeMessage({ id: 'msg-x', type: 'thinking', content: 'reasoning…' }),
      ]
      const deltas = new Map([['msg-x', 'final answer']])
      const remaps = new Map<string, string>()

      applyOrphanDeltas(messages, deltas, new Set(), remaps)

      expect(messages.find(m => m.id === 'msg-x-response')).toMatchObject({
        type: 'response',
        content: 'final answer',
      })
      expect(remaps.get('msg-x')).toBe('msg-x-response')
    })
  })

  describe('branch 3: existing matching response at the (possibly suffixed) id', () => {
    it('concatenates delta onto existing response content via index assignment', () => {
      const messages: ChatMessage[] = [
        makeMessage({ id: 'msg-1', type: 'response', content: 'hello ' }),
      ]
      const deltas = new Map([['msg-1', 'world']])

      applyOrphanDeltas(messages, deltas, new Set(), new Map())

      expect(messages).toHaveLength(1)
      expect(messages[0]?.content).toBe('hello world')
    })

    it('concatenates onto the suffixed response when collision was previously registered', () => {
      // Prior call established the suffix; now another stream_delta arrives
      // for the same id. The collision path STILL fires (msg-1 is still
      // tool_use), so we hit branch-3 via the `${msgId}-response` lookup.
      const messages: ChatMessage[] = [
        makeMessage({ id: 'msg-1', type: 'tool_use', content: 'ls' }),
        makeMessage({ id: 'msg-1-response', type: 'response', content: 'first ' }),
      ]
      const deltas = new Map([['msg-1', 'second']])
      const remaps = new Map<string, string>([['msg-1', 'msg-1-response']])

      applyOrphanDeltas(messages, deltas, new Set(), remaps)

      // Existing response message extended
      expect(messages.find(m => m.id === 'msg-1-response')?.content).toBe('first second')
      // Tool_use unchanged
      expect(messages.find(m => m.id === 'msg-1' && m.type === 'tool_use')?.content).toBe('ls')
      // Remap stays — repeated calls don't duplicate the entry
      expect(remaps.get('msg-1')).toBe('msg-1-response')
    })

    it('preserves other ChatMessage fields when concatenating (spread + content override)', () => {
      const messages: ChatMessage[] = [
        makeMessage({
          id: 'msg-1',
          type: 'response',
          content: 'hello ',
          timestamp: 12345,
        }),
      ]
      const deltas = new Map([['msg-1', 'world']])

      applyOrphanDeltas(messages, deltas, new Set(), new Map())

      // Spread {...existing, content: existing.content + delta} preserves other fields
      expect(messages[0]).toMatchObject({
        id: 'msg-1',
        type: 'response',
        content: 'hello world',
        timestamp: 12345,
      })
    })
  })

  describe('matched-set short-circuit', () => {
    it('skips deltas whose id is already in the matched set', () => {
      const messages: ChatMessage[] = []
      const deltas = new Map([
        ['m-already', 'should be skipped'],
        ['m-fresh', 'new content'],
      ])
      const matched = new Set(['m-already'])

      applyOrphanDeltas(messages, deltas, matched, new Map())

      expect(messages).toHaveLength(1)
      expect(messages[0]?.id).toBe('m-fresh')
    })

    it('does not register a remap when matched short-circuits a collision', () => {
      const messages: ChatMessage[] = [
        makeMessage({ id: 'msg-1', type: 'tool_use', content: 'ls' }),
      ]
      const deltas = new Map([['msg-1', 'should-skip']])
      const matched = new Set(['msg-1'])
      const remaps = new Map<string, string>()

      applyOrphanDeltas(messages, deltas, matched, remaps)

      expect(remaps.size).toBe(0)
      expect(messages).toHaveLength(1) // tool_use unchanged, no orphan added
    })
  })

  describe('mutate-in-place contract', () => {
    it('preserves the messages array reference (caller relies on this)', () => {
      const messages: ChatMessage[] = []
      const before = messages
      const deltas = new Map([['m-1', 'x']])

      applyOrphanDeltas(messages, deltas, new Set(), new Map())

      expect(messages).toBe(before)
    })

    it('preserves array reference even when concatenating onto existing content', () => {
      const messages: ChatMessage[] = [
        makeMessage({ id: 'm-1', type: 'response', content: 'a' }),
      ]
      const before = messages
      const deltas = new Map([['m-1', 'b']])

      applyOrphanDeltas(messages, deltas, new Set(), new Map())

      expect(messages).toBe(before)
      expect(messages[0]?.content).toBe('ab')
    })

    it('preserves array reference when both branches fire in one call', () => {
      const messages: ChatMessage[] = [
        makeMessage({ id: 'collide', type: 'tool_use', content: 'tool' }),
      ]
      const before = messages
      const deltas = new Map([
        ['collide', 'response-text'],
        ['fresh', 'orphan-text'],
      ])

      applyOrphanDeltas(messages, deltas, new Set(), new Map())

      expect(messages).toBe(before)
      expect(messages.length).toBe(3) // tool_use + suffixed response + fresh orphan
    })
  })

  describe('empty inputs', () => {
    it('is a no-op with empty deltas', () => {
      const messages: ChatMessage[] = [makeMessage({ id: 'm-1', content: 'a' })]
      const before = messages.map(m => ({ ...m }))

      applyOrphanDeltas(messages, new Map(), new Set(), new Map())

      expect(messages).toEqual(before)
    })

    it('handles empty messages with single delta', () => {
      const messages: ChatMessage[] = []
      applyOrphanDeltas(messages, new Map([['m-1', 'hello']]), new Set(), new Map())
      expect(messages).toHaveLength(1)
      expect(messages[0]?.content).toBe('hello')
    })
  })
})
