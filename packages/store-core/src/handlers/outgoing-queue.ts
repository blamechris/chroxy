/**
 * Outgoing-message queue handlers (#5937, epic #5935 slice ②).
 *
 * Parsers + pure helpers for the per-session server-authoritative outgoing
 * queue mirrored from slice ①'s `message_queued` / `message_dequeued` events
 * (server `base-session.js` `_outgoingQueue`). The shared model is a per-session
 * `queuedMessages: QueuedSessionMessage[]` on BaseSessionState; these functions
 * compute the next array. State lookup + write stay at the call site (the
 * dispatch table / each client's message-handler), matching the rest of the
 * handler family.
 *
 * Lifecycle of one queued follow-up:
 *   1. Owner sends mid-turn → client OPTIMISTICALLY enqueues a `'pending'`
 *      entry (`enqueueOptimisticQueuedMessage`) keyed by its `clientMessageId`
 *      so the UI shows the queued bubble immediately.
 *   2. Server holds it and echoes `message_queued` → `handleMessageQueued`
 *      RECONCILES: the matching `'pending'` entry flips to `'confirmed'`
 *      (deduped by `clientMessageId`, never double-added); an entry arriving
 *      with no local optimistic copy is appended as `'confirmed'`.
 *   3. Turn completes → server flushes (or an interrupt cancels) → the server
 *      emits `message_dequeued` → `handleMessageDequeued` REMOVES the entry.
 *
 * Re-exported from ./index (the barrel) so the public surface is unchanged.
 */

import type { QueuedSessionMessage } from '../types'
import { resolveSessionId } from './_shared'

/**
 * Builder result for the queue handlers, mirroring `SessionInterventionBuilder`
 * (#4653): the next array is computed from the session's CURRENT one, so the
 * call site supplies it via `applyTo`. Returning `current` unchanged (referential
 * equality) lets React skip a re-render.
 */
export interface QueuedMessagesBuilder {
  /** Session the patch targets (active-session fallback applied). */
  sessionId: string | null
  /** Apply against the session's current queue; returns the next queue patch. */
  applyTo: (current: QueuedSessionMessage[]) => { queuedMessages: QueuedSessionMessage[] }
}

/**
 * Read a well-formed, non-empty string field, else undefined. Deliberately
 * NOT `_shared`'s `parseStringField` (which trims + returns null): a
 * `clientMessageId` must not be trimmed, and `undefined` (not `null`) matches
 * the optional `QueuedSessionMessage.clientMessageId?` type so the field is
 * simply absent when unset rather than explicitly null.
 */
function optionalString(msg: Record<string, unknown>, key: string): string | undefined {
  const v = msg[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * #5937 — optimistic local enqueue for the send-while-busy path (called by a
 * client's send action, NOT a wire handler). Appends a `'pending'` entry so the
 * queued bubble renders immediately, before the server's `message_queued`
 * confirmation round-trips. Deduped by `clientMessageId`: a repeat call for an
 * id already present returns `current` unchanged (referential equality), so a
 * double-fire can't insert two bubbles for one send. An entry WITHOUT a
 * `clientMessageId` cannot be deduped/reconciled later, so it is always
 * appended — callers should pass an id whenever they have one.
 */
export function enqueueOptimisticQueuedMessage(
  current: QueuedSessionMessage[],
  entry: { clientMessageId?: string; text: string; queuedAt: number },
): QueuedSessionMessage[] {
  if (entry.clientMessageId && current.some((m) => m.clientMessageId === entry.clientMessageId)) {
    return current
  }
  return [
    ...current,
    {
      clientMessageId: entry.clientMessageId,
      text: entry.text,
      queuedAt: entry.queuedAt,
      status: 'pending',
    },
  ]
}

/**
 * #5937 — remove a queued entry by `clientMessageId`. Used by the dequeue
 * handler and available for a client-initiated cancel. Returns `current`
 * unchanged when no entry matches (so the patch is a no-op). When `id` is
 * undefined, removes the HEAD (the oldest entry) — the FIFO flush always retires
 * the front of the queue, so a `message_dequeued` that echoes no id still
 * removes the right item.
 */
export function removeQueuedMessage(
  current: QueuedSessionMessage[],
  id: string | undefined,
): QueuedSessionMessage[] {
  if (current.length === 0) return current
  if (id === undefined) return current.slice(1)
  const idx = current.findIndex((m) => m.clientMessageId === id)
  if (idx === -1) return current
  return [...current.slice(0, idx), ...current.slice(idx + 1)]
}

/**
 * Parse a `message_queued` event (wire shape
 * `{ sessionId, clientMessageId?, text, queueLength }` — see the server's
 * EventNormalizer) into a builder that RECONCILES the queued entry into the
 * target session's queue.
 *
 * `applyTo` semantics:
 *   - an existing entry with the same `clientMessageId` (the optimistic local
 *     copy) flips to `'confirmed'`, adopting the server's `text` (so a rewrite
 *     or normalization is reflected); position is preserved.
 *   - otherwise the message is APPENDED as `'confirmed'` (a queued send that
 *     never had a local optimistic entry — e.g. another of the owner's devices,
 *     or a client that didn't optimistically enqueue).
 *
 * Returns null when the payload is malformed (`text` missing/non-string) — the
 * caller leaves state untouched rather than inserting a blank bubble.
 */
export function handleMessageQueued(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): QueuedMessagesBuilder | null {
  const text = msg.text
  // Only the TYPE is guarded — an empty-string text is a valid queued entry
  // (attachment-only sends carry `text: ''` from the server; see the
  // QueuedSessionMessage doc). Do NOT tighten this to `!text`.
  if (typeof text !== 'string') return null
  const clientMessageId = optionalString(msg, 'clientMessageId')

  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => {
      if (clientMessageId) {
        const idx = current.findIndex((m) => m.clientMessageId === clientMessageId)
        // `existing` is read off the index AND truthy-guarded so it narrows to a
        // defined QueuedSessionMessage under `noUncheckedIndexedAccess` (the
        // dashboard's stricter tsconfig) — `current[idx]` is `T | undefined`
        // there even after the `findIndex` check.
        const existing = idx === -1 ? undefined : current[idx]
        if (existing) {
          // No-op (referential equality) when already confirmed with identical
          // text — a duplicate message_queued must not churn the array.
          if (existing.status === 'confirmed' && existing.text === text) {
            return { queuedMessages: current }
          }
          const next = current.slice()
          next[idx] = { ...existing, text, status: 'confirmed' }
          return { queuedMessages: next }
        }
      }
      const entry: QueuedSessionMessage = {
        clientMessageId,
        text,
        queuedAt: Date.now(),
        status: 'confirmed',
      }
      return { queuedMessages: [...current, entry] }
    },
  }
}

/**
 * Parse a `message_dequeued` event (wire shape
 * `{ sessionId, clientMessageId?, queueLength, reason: 'flush' | 'interrupted' | 'cancelled' }`)
 * into a builder that REMOVES the dequeued entry. ALL exit reasons remove the
 * entry from the queue model — the handler is reason-agnostic: `'flush'` (the
 * message is now being sent — the normal user_input / stream path takes over
 * rendering it), `'interrupted'` (the whole queue was cancelled by a Stop), and
 * `'cancelled'` (#5943 — the owner cancelled this one entry via `cancel_queued`).
 * Removal is by `clientMessageId`, or FIFO head when the server echoed no id.
 *
 * Always returns a builder (no malformed-payload null) — a `message_dequeued`
 * with no id is the legitimate FIFO-head case, and an unknown id is a safe
 * no-op via {@link removeQueuedMessage}.
 */
export function handleMessageDequeued(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): QueuedMessagesBuilder {
  const clientMessageId = optionalString(msg, 'clientMessageId')
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => ({ queuedMessages: removeQueuedMessage(current, clientMessageId) }),
  }
}
