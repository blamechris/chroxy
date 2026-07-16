import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  handleMessageQueued,
  handleMessageDequeued,
  handleResultQueueReconcile,
  enqueueOptimisticQueuedMessage,
  removeQueuedMessage,
  reconcileQueueLength,
} from './outgoing-queue'
import type { ChatMessage, QueuedSessionMessage } from '../types'

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

const pending = (clientMessageId: string, text: string, queuedAt = 0): QueuedSessionMessage => ({
  clientMessageId,
  text,
  queuedAt,
  status: 'pending',
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

describe('reconcileQueueLength (#5950 orphan-badge safety net)', () => {
  it('returns the same array (referential) when local length already matches', () => {
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b')]
    expect(reconcileQueueLength(current, 2)).toBe(current)
  })

  it('returns the same array when local is SHORTER than the server count (never pads)', () => {
    const current = [confirmed('uin-1', 'a')]
    // We are missing a confirmed entry we never saw the text for — leave it for
    // the reconnect snapshot to backfill rather than fabricate a blank bubble.
    expect(reconcileQueueLength(current, 3)).toBe(current)
  })

  it('trims the oldest (FIFO-head) confirmed orphans down to the authoritative count', () => {
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b'), confirmed('uin-3', 'c')]
    // Server says only 1 remains → a dropped message_dequeued left 2 orphans;
    // drop the two oldest, keep the newest.
    expect(reconcileQueueLength(current, 1)).toEqual([confirmed('uin-3', 'c')])
  })

  it('clears all CONFIRMED entries when the server says zero remain', () => {
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b')]
    expect(reconcileQueueLength(current, 0)).toEqual([])
  })

  it('NEVER trims pending (optimistic) entries — only confirmed ones count toward queueLength', () => {
    // Two fast queued sends before the 1st confirms: uin-1 just flipped to
    // confirmed, uin-2 is still optimistic pending. The server has only seen
    // uin-1 so queueLength is 1. A blind length trim (len 2 > 1) would drop the
    // confirmed uin-1 and keep the unconfirmed uin-2 — the regression. Status-
    // aware: confirmedCount(1) == target(1) → no trim, both survive.
    const current = [confirmed('uin-1', 'a'), pending('uin-2', 'b')]
    expect(reconcileQueueLength(current, 1)).toBe(current)
  })

  it('reaps a confirmed orphan while preserving an interleaved pending entry', () => {
    // [orphan(confirmed), pending, confirmed] with server queueLength 1 → drop
    // the oldest confirmed (orphan), keep the pending and the newest confirmed.
    const current = [confirmed('uin-0', 'orphan'), pending('uin-1', 'live'), confirmed('uin-2', 'a')]
    expect(reconcileQueueLength(current, 1)).toEqual([pending('uin-1', 'live'), confirmed('uin-2', 'a')])
  })

  it('is a no-op (referential) when queueLength is absent/non-finite (older server)', () => {
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b')]
    expect(reconcileQueueLength(current, undefined)).toBe(current)
    expect(reconcileQueueLength(current, NaN)).toBe(current)
  })

  it('floors a fractional count and never goes negative', () => {
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b')]
    expect(reconcileQueueLength(current, 1.9)).toEqual([confirmed('uin-2', 'b')])
    expect(reconcileQueueLength(current, -5)).toEqual([])
  })
})

describe('queueLength reconciliation through the wire handlers (#5950)', () => {
  it('message_dequeued self-heals a leftover orphan using the authoritative queueLength', () => {
    // Local queue carries a stale orphan (uin-0) whose dequeue was lost. The
    // server now dequeues uin-1 and stamps queueLength: 0 (nothing remains).
    const current = [confirmed('uin-0', 'orphan'), confirmed('uin-1', 'a')]
    const builder = handleMessageDequeued(
      { sessionId: 's1', clientMessageId: 'uin-1', queueLength: 0, reason: 'flush' },
      null,
    )
    expect(builder.applyTo(current)).toEqual({ queuedMessages: [] })
  })

  it('message_queued trims a leftover confirmed orphan after appending the new confirmed entry', () => {
    // Local: one orphan + one confirmed (2). A new queued message arrives; the
    // server's authoritative count is 2 (the orphan already left server-side),
    // so after appending the new entry (→ 3 confirmed) we trim back to 2.
    const current = [confirmed('uin-0', 'orphan'), confirmed('uin-1', 'a')]
    const builder = handleMessageQueued(
      { sessionId: 's1', clientMessageId: 'uin-2', text: 'b', queueLength: 2 },
      null,
    )
    const next = builder!.applyTo(current).queuedMessages
    expect(next.map((m) => m.clientMessageId)).toEqual(['uin-1', 'uin-2'])
  })

  it('does NOT drop a confirmed entry when a 2nd send is still optimistic pending (regression guard)', () => {
    // Two fast queued sends: both optimistically enqueued as pending. The
    // server's message_queued for uin-1 arrives first (queueLength: 1) while
    // uin-2 is still pending locally. Confirming uin-1 must NOT trim it away —
    // confirmedCount(1) == queueLength(1), the pending uin-2 is not yet counted.
    const current = [pending('uin-1', 'first'), pending('uin-2', 'second')]
    const builder = handleMessageQueued(
      { sessionId: 's1', clientMessageId: 'uin-1', text: 'first', queueLength: 1 },
      null,
    )
    const next = builder!.applyTo(current).queuedMessages
    expect(next).toEqual([confirmed('uin-1', 'first'), pending('uin-2', 'second')])
  })

  it('leaves a correctly-synced queue untouched (referential) when queueLength matches', () => {
    const current = [confirmed('uin-1', 'a')]
    const builder = handleMessageDequeued(
      { sessionId: 's1', clientMessageId: 'uin-9', queueLength: 1, reason: 'flush' },
      null,
    )
    // unknown id → no removal, length already matches → referential no-op
    expect(builder.applyTo(current).queuedMessages).toBe(current)
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

describe('handleMessageQueued — faked-fresh-turn reconcile (#6291 / #6302)', () => {
  const userMsg = (id: string): ChatMessage => ({ id, type: 'user_input', content: 'hi', timestamp: 0 })
  const thinkingMsg = (): ChatMessage => ({ id: 'thinking', type: 'thinking', content: '', timestamp: 0 })

  it('clears a pending streamingMessageId and strips the thinking bubble in one step (owner matches)', () => {
    const builder = handleMessageQueued({ sessionId: 's1', clientMessageId: 'uin-1', text: 'hi' }, null)!
    const patch = builder.reconcileFakedFreshTurn!({
      streamingMessageId: 'pending',
      messages: [userMsg('uin-1'), thinkingMsg()],
      pendingClientMessageId: 'uin-1',
    })
    expect(patch).toEqual({
      streamingMessageId: null,
      pendingClientMessageId: null,
      messages: [userMsg('uin-1')],
    })
  })

  it('does NOT strip a real (non-thinking) message when there is no thinking bubble', () => {
    const builder = handleMessageQueued({ sessionId: 's1', clientMessageId: 'uin-1', text: 'hi' }, null)!
    // streamingMessageId is still the 'pending' sentinel (no stream_start yet) but
    // the thinking bubble was already removed — clear the id + owner, leave messages.
    const patch = builder.reconcileFakedFreshTurn!({
      streamingMessageId: 'pending',
      messages: [userMsg('uin-1')],
      pendingClientMessageId: 'uin-1',
    })
    expect(patch).toEqual({ streamingMessageId: null, pendingClientMessageId: null })
    expect(patch).not.toHaveProperty('messages')
  })

  it('is a no-op (null) when a genuinely live turn owns a real stream id', () => {
    const builder = handleMessageQueued({ sessionId: 's1', clientMessageId: 'uin-2', text: 'hi' }, null)!
    // A live turn carries a real stream id, not the 'pending' sentinel — leave it.
    const patch = builder.reconcileFakedFreshTurn!({
      streamingMessageId: 'resp-7',
      messages: [userMsg('uin-1'), thinkingMsg()],
      pendingClientMessageId: 'uin-2',
    })
    expect(patch).toBeNull()
  })

  it('is a no-op (null) when nothing is streaming', () => {
    const builder = handleMessageQueued({ sessionId: 's1', text: 'hi' }, null)!
    expect(
      builder.reconcileFakedFreshTurn!({ streamingMessageId: null, messages: [], pendingClientMessageId: null }),
    ).toBeNull()
  })

  it('#6302 — is a no-op (null) when ANOTHER client\'s queued send arrives (owner mismatch)', () => {
    // Multi-client: this client faked a fresh turn for uin-1 (it owns the pending
    // turn). A DIFFERENT client's mid-turn send (uin-2) is broadcast as a
    // message_queued — even though streamingMessageId is still 'pending', the
    // owner ids differ, so this client's optimistic turn must stay intact.
    const builder = handleMessageQueued({ sessionId: 's1', clientMessageId: 'uin-2', text: 'theirs' }, null)!
    const patch = builder.reconcileFakedFreshTurn!({
      streamingMessageId: 'pending',
      messages: [userMsg('uin-1'), thinkingMsg()],
      pendingClientMessageId: 'uin-1',
    })
    expect(patch).toBeNull()
  })

  it('#6302 — is a no-op (null) when the queued send has no clientMessageId (uncorrelatable)', () => {
    // An idless queued send can't be matched to any owner, so it never retires a
    // faked-fresh turn — even with a 'pending' sentinel outstanding.
    const builder = handleMessageQueued({ sessionId: 's1', text: 'idless' }, null)!
    const patch = builder.reconcileFakedFreshTurn!({
      streamingMessageId: 'pending',
      messages: [userMsg('uin-1'), thinkingMsg()],
      pendingClientMessageId: 'uin-1',
    })
    expect(patch).toBeNull()
  })

  it('#6302 — is a no-op (null) when no owner is recorded (pendingClientMessageId null)', () => {
    const builder = handleMessageQueued({ sessionId: 's1', clientMessageId: 'uin-1', text: 'hi' }, null)!
    const patch = builder.reconcileFakedFreshTurn!({
      streamingMessageId: 'pending',
      messages: [userMsg('uin-1'), thinkingMsg()],
      pendingClientMessageId: null,
    })
    expect(patch).toBeNull()
  })

  it('strips ONLY the singleton thinking placeholder, preserving real persisted thinking content', () => {
    // Real thinking content carries a non-'thinking' id (e.g. 'th1') even though
    // its type is 'thinking'; only the optimistic placeholder uses id 'thinking'.
    // Filtering by id (not type) must keep the real content. (#6291 review)
    const realThinking: ChatMessage = { id: 'th1', type: 'thinking', content: 'reasoning…', timestamp: 0 }
    const builder = handleMessageQueued({ sessionId: 's1', clientMessageId: 'uin-1', text: 'hi' }, null)!
    const patch = builder.reconcileFakedFreshTurn!({
      streamingMessageId: 'pending',
      messages: [realThinking, userMsg('uin-1'), thinkingMsg()],
      pendingClientMessageId: 'uin-1',
    })
    expect(patch).toEqual({
      streamingMessageId: null,
      pendingClientMessageId: null,
      messages: [realThinking, userMsg('uin-1')],
    })
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

describe('handleResultQueueReconcile (#6627 — self-heal a stale queued bubble on turn boundary)', () => {
  it('returns null when the result carries no queueLength (older server) — caller skips', () => {
    expect(handleResultQueueReconcile({ sessionId: 's1' }, null)).toBeNull()
    expect(handleResultQueueReconcile({ sessionId: 's1', queueLength: undefined }, null)).toBeNull()
  })

  it('trims a stale CONFIRMED orphan down to the result queueLength (dropped message_dequeued)', () => {
    // Client still shows 2 confirmed, but the server flushed one and the
    // message_dequeued was lost — the next result carries queueLength: 1.
    const current = [confirmed('uin-1', 'a'), confirmed('uin-2', 'b')]
    const builder = handleResultQueueReconcile({ sessionId: 's1', queueLength: 1 }, null)!
    const next = builder.applyTo(current).queuedMessages
    expect(next.map((m) => m.clientMessageId)).toEqual(['uin-2'])
  })

  it('is a referential no-op when already in sync (React skips the re-render)', () => {
    const current = [confirmed('uin-1', 'a')]
    const builder = handleResultQueueReconcile({ sessionId: 's1', queueLength: 1 }, null)!
    expect(builder.applyTo(current).queuedMessages).toBe(current)
  })

  it('never trims a PENDING (unconfirmed) entry — only confirmed orphans', () => {
    // A just-sent optimistic entry legitimately makes the local queue longer than
    // the server's confirmed count; it must survive a result reconcile.
    const current = [confirmed('uin-1', 'a'), pending('uin-2', 'b')]
    const builder = handleResultQueueReconcile({ sessionId: 's1', queueLength: 0 }, null)!
    const next = builder.applyTo(current).queuedMessages
    expect(next.map((m) => m.clientMessageId)).toEqual(['uin-2'])
  })

  it('resolves the target session from the result msg', () => {
    const builder = handleResultQueueReconcile({ sessionId: 'sess-x', queueLength: 0 }, 'active')!
    expect(builder.sessionId).toBe('sess-x')
  })
})
