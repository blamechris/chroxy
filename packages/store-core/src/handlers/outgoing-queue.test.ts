import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  handleMessageQueued,
  handleMessageDequeued,
  enqueueOptimisticQueuedMessage,
  removeQueuedMessage,
} from './outgoing-queue'
import type { QueuedSessionMessage } from '../types'

/**
 * #5937 (epic #5935 slice ②) — unit coverage for the shared store-core
 * outgoing-message queue model: the optimistic-enqueue + remove helpers and the
 * `message_queued` / `message_dequeued` wire handlers (reconcile / dequeue).
 * The both-clients dispatch contract lives in dispatch-table.test.ts.
 */

const confirmed = (clientMessageId: string, text: string, queuedAt = 0): QueuedSessionMessage => ({
  clientMessageId,
  text,
  queuedAt,
  status: 'confirmed',
})

describe('enqueueOptimisticQueuedMessage', () => {
  it('appends a pending entry', () => {
    const next = enqueueOptimisticQueuedMessage([], { clientMessageId: 'uin-1', text: 'hi', queuedAt: 5 })
    expect(next).toEqual([{ clientMessageId: 'uin-1', text: 'hi', queuedAt: 5, status: 'pending' }])
  })

  it('dedups by clientMessageId — a repeat returns the same array (referential)', () => {
    const current = [confirmed('uin-1', 'hi')]
    const next = enqueueOptimisticQueuedMessage(current, { clientMessageId: 'uin-1', text: 'hi again', queuedAt: 9 })
    expect(next).toBe(current)
  })

  it('always appends when no clientMessageId is supplied (cannot dedup)', () => {
    const current: QueuedSessionMessage[] = []
    const a = enqueueOptimisticQueuedMessage(current, { text: 'x', queuedAt: 1 })
    const b = enqueueOptimisticQueuedMessage(a, { text: 'x', queuedAt: 2 })
    expect(b).toHaveLength(2)
  })
})

describe('removeQueuedMessage', () => {
  it('removes by clientMessageId, preserving order', () => {
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b'), confirmed('uin-3', 'c')]
    expect(removeQueuedMessage(current, 'uin-2')).toEqual([confirmed('uin-1', 'a'), confirmed('uin-3', 'c')])
  })

  it('removes the FIFO head when id is undefined', () => {
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b')]
    expect(removeQueuedMessage(current, undefined)).toEqual([confirmed('uin-2', 'b')])
  })

  it('returns the same array (referential) for an unknown id', () => {
    const current = [confirmed('uin-1', 'a')]
    expect(removeQueuedMessage(current, 'uin-9')).toBe(current)
  })

  it('returns the same empty array when there is nothing to remove', () => {
    const current: QueuedSessionMessage[] = []
    expect(removeQueuedMessage(current, undefined)).toBe(current)
  })
})

describe('handleMessageQueued', () => {
  afterEach(() => vi.useRealTimers())

  it('returns null for a malformed payload (missing text)', () => {
    expect(handleMessageQueued({ sessionId: 's1' }, null)).toBeNull()
  })

  it('resolves sessionId, falling back to the active session', () => {
    expect(handleMessageQueued({ text: 'x' }, 's-active')?.sessionId).toBe('s-active')
    expect(handleMessageQueued({ sessionId: 's1', text: 'x' }, 's-active')?.sessionId).toBe('s1')
  })

  it('appends a confirmed entry when no optimistic copy exists', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1234)
    const builder = handleMessageQueued({ sessionId: 's1', clientMessageId: 'uin-1', text: 'hi' }, null)!
    expect(builder.applyTo([])).toEqual({
      queuedMessages: [{ clientMessageId: 'uin-1', text: 'hi', queuedAt: 1234, status: 'confirmed' }],
    })
  })

  it('flips the matching optimistic entry to confirmed and adopts the server text', () => {
    const current: QueuedSessionMessage[] = [
      { clientMessageId: 'uin-1', text: 'draft', queuedAt: 10, status: 'pending' },
    ]
    const builder = handleMessageQueued({ sessionId: 's1', clientMessageId: 'uin-1', text: 'rewritten' }, null)!
    expect(builder.applyTo(current)).toEqual({
      queuedMessages: [{ clientMessageId: 'uin-1', text: 'rewritten', queuedAt: 10, status: 'confirmed' }],
    })
  })

  it('is a no-op (referential) for a duplicate confirmed message_queued', () => {
    const current = [confirmed('uin-1', 'hi')]
    const builder = handleMessageQueued({ sessionId: 's1', clientMessageId: 'uin-1', text: 'hi' }, null)!
    expect(builder.applyTo(current).queuedMessages).toBe(current)
  })

  it('appends (no dedup) when the server echoes no clientMessageId', () => {
    const current = [confirmed('uin-1', 'a')]
    const builder = handleMessageQueued({ sessionId: 's1', text: 'b' }, null)!
    const next = builder.applyTo(current).queuedMessages
    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({ text: 'b', status: 'confirmed', clientMessageId: undefined })
  })
})

describe('handleMessageDequeued', () => {
  it('removes the matching entry by clientMessageId', () => {
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b')]
    const builder = handleMessageDequeued({ sessionId: 's1', clientMessageId: 'uin-1', reason: 'flush' }, null)
    expect(builder.applyTo(current)).toEqual({ queuedMessages: [confirmed('uin-2', 'b')] })
  })

  it('removes the FIFO head when no clientMessageId is echoed', () => {
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b')]
    const builder = handleMessageDequeued({ sessionId: 's1', reason: 'flush' }, null)
    expect(builder.applyTo(current)).toEqual({ queuedMessages: [confirmed('uin-2', 'b')] })
  })

  it('treats interrupted the same as flush (removes the entry)', () => {
    const current = [confirmed('uin-1', 'a')]
    const builder = handleMessageDequeued({ sessionId: 's1', clientMessageId: 'uin-1', reason: 'interrupted' }, null)
    expect(builder.applyTo(current)).toEqual({ queuedMessages: [] })
  })

  it('removes only the cancelled entry (#5943), leaving the rest of the queue', () => {
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b'), confirmed('uin-3', 'c')]
    const builder = handleMessageDequeued({ sessionId: 's1', clientMessageId: 'uin-2', reason: 'cancelled' }, null)
    expect(builder.applyTo(current)).toEqual({ queuedMessages: [confirmed('uin-1', 'a'), confirmed('uin-3', 'c')] })
  })

  it('is a no-op (referential) for an unknown id', () => {
    const current = [confirmed('uin-1', 'a')]
    const builder = handleMessageDequeued({ sessionId: 's1', clientMessageId: 'uin-9', reason: 'flush' }, null)
    expect(builder.applyTo(current).queuedMessages).toBe(current)
  })
})
