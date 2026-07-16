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

import type { ChatMessage, QueuedSessionMessage } from '../types'
import { resolveSessionId } from './_shared'

/**
 * Subset of session-state the queue handlers read to reconcile a faked-fresh
 * optimistic turn (#6291). The client may OPTIMISTICALLY show a live "working"
 * turn (a `'thinking'` bubble + `streamingMessageId: 'pending'`) for a send it
 * judged would start a turn; when the server instead QUEUES that send, the
 * `message_queued` echo must atomically retire that optimistic turn as the entry
 * flips to confirmed-queued. Both clients' `BaseSessionState` carry these fields.
 */
export interface FakedFreshTurnState {
  streamingMessageId: string | null
  messages: ChatMessage[]
  /**
   * #6302 — the `clientMessageId` that OWNS the current 'pending' optimistic
   * turn (set by the client alongside `streamingMessageId: 'pending'`). The
   * reconcile fires ONLY when the incoming `message_queued`'s `clientMessageId`
   * matches this — so another client's broadcast queued send (an id this client
   * doesn't own) can never retire this client's own optimistic turn.
   */
  pendingClientMessageId: string | null
}

/** The patch a faked-fresh-turn reconcile produces (omitted fields are unchanged). */
export interface FakedFreshTurnPatch {
  streamingMessageId?: string | null
  messages?: ChatMessage[]
  /** #6302 — null the pending-turn owner when the optimistic turn is retired. */
  pendingClientMessageId?: string | null
}

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
  /**
   * #6291 — reconcile a client-faked optimistic "working" turn in the SAME state
   * update that confirms this queued entry. Only `handleMessageQueued` populates
   * this. Given the session's current `{ streamingMessageId, messages }`, returns
   * a patch that clears the `'pending'` streamingMessageId and strips the
   * optimistic `'thinking'` bubble when this `message_queued` corresponds to that
   * optimistic turn; returns `null` (no patch) otherwise so the spinner→badge
   * swap happens in one step immediately rather than after the client's 5s
   * stream-stall safety net.
   */
  reconcileFakedFreshTurn?: (state: FakedFreshTurnState) => FakedFreshTurnPatch | null
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

/** Read a finite numeric field, else undefined. */
function optionalNumber(msg: Record<string, unknown>, key: string): number | undefined {
  const v = msg[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * #5950 — defense-in-depth orphan-badge safety net. The server stamps every
 * `message_queued` / `message_dequeued` with the AUTHORITATIVE post-event
 * `queueLength`. If a `message_dequeued` is ever lost (a dropped frame, or a
 * server edge that flushes without emitting), a stale entry would otherwise keep
 * its "Queued" badge until a reconnect re-syncs. Reconciling against the
 * server's count on every queue event self-heals that orphan on the next queue
 * activity.
 *
 * STATUS-AWARE — this is load-bearing. Only `'confirmed'` entries correspond to
 * messages the server is actually holding (and thus counted in `queueLength`).
 * Optimistic `'pending'` entries (added synchronously on send, before their
 * `message_queued` round-trips) are NOT yet server-acknowledged, so they
 * legitimately make the local queue longer than `queueLength` and must NEVER be
 * trimmed — they resolve via their own `message_queued` confirmation. A blind
 * length trim would, on two fast queued sends, drop the just-confirmed entry
 * while keeping an unconfirmed one (a normal-path data-loss bug, no dropped
 * frame required). So we reconcile the CONFIRMED count only.
 *
 * Behaviour:
 *   - confirmed-count <= target → no-op (returns `current`, referential — React
 *     skips the re-render). Also covers "local SHORTER than server": we never
 *     PAD, since a missing confirmed entry's text was never seen (left for the
 *     planned reconnect snapshot #5937 to backfill).
 *   - confirmed-count > target → drop the oldest (FIFO-head) CONFIRMED orphans
 *     until the confirmed count equals `target`, preserving every pending entry
 *     and overall order.
 *   - non-finite/absent `queueLength` (older server) → returns `current`.
 *
 * FIFO-head trim is exact for the dominant case (a dropped flush retires the
 * front of the queue, so the orphan IS the oldest confirmed entry). A dropped
 * dequeue for a mid-queue `cancel_queued` of a confirmed entry is the only case
 * where head-trim could drop a different still-valid confirmed entry; that
 * compound failure is vanishingly unlikely, keeps the correct NUMBER of bubbles,
 * and self-corrects on the reconnect snapshot.
 */
export function reconcileQueueLength(
  current: QueuedSessionMessage[],
  serverQueueLength: number | undefined,
): QueuedSessionMessage[] {
  if (typeof serverQueueLength !== 'number' || !Number.isFinite(serverQueueLength)) {
    return current
  }
  const target = Math.max(0, Math.floor(serverQueueLength))
  const confirmedCount = current.reduce((n, m) => (m.status === 'confirmed' ? n + 1 : n), 0)
  if (confirmedCount <= target) return current
  // Drop the oldest confirmed orphans (filter walks head→tail) until the
  // confirmed count matches the server's; pending entries always survive.
  let toDrop = confirmedCount - target
  return current.filter((m) => {
    if (toDrop > 0 && m.status === 'confirmed') {
      toDrop--
      return false
    }
    return true
  })
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
  const queueLength = optionalNumber(msg, 'queueLength')

  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    // #6291 — when the client optimistically faked a fresh "working" turn for
    // this send (streamingMessageId === 'pending' + a 'thinking' bubble) but the
    // server queued it instead, retire that optimistic turn atomically as the
    // entry confirms. Without this the live turn evaporates and re-labels itself
    // "Queued" ~5s later when the client's stream-stall safety net fires, with no
    // user action. We key off the literal 'pending' sentinel the client writes
    // (it never sets streamingMessageId to a real clientMessageId before
    // stream_start), so this fires only for a faked-fresh turn — a genuinely live
    // turn carries a real stream id and is left untouched.
    //
    // #6302 — and ONLY for OUR OWN optimistic send: the reconcile fires only when
    // this `message_queued`'s clientMessageId matches the session's
    // `pendingClientMessageId` (the id that owns the 'pending' turn). In a
    // multi-client session another client's mid-turn send is broadcast as a
    // `message_queued` too; without this owner check that broadcast would clear
    // THIS client's pending turn early. A 'a user bubble with this id exists'
    // check is insufficient — mid-turn sends are echoed across clients, so this
    // client also holds bubbles for other clients' ids. When the queued send has
    // no clientMessageId at all (legacy/idless), it can't be correlated to any
    // owner, so it never retires a faked-fresh turn.
    reconcileFakedFreshTurn: ({ streamingMessageId, messages, pendingClientMessageId }) => {
      if (streamingMessageId !== 'pending') return null
      if (!clientMessageId || clientMessageId !== pendingClientMessageId) return null
      const patch: FakedFreshTurnPatch = { streamingMessageId: null, pendingClientMessageId: null }
      // Strip the optimistic 'thinking' bubble by its singleton id (matching the
      // canonical filterThinking in utils.ts) — NOT by type, which would also
      // delete real persisted thinking content that carries a non-'thinking' id.
      // Keep the array reference (and omit the field) when there's nothing to
      // remove so the dispatcher can elide a needless re-render.
      const stripped = messages.filter((m) => m.id !== 'thinking')
      if (stripped.length !== messages.length) patch.messages = stripped
      return patch
    },
    applyTo: (current) => {
      // #5950 — reconcile the result against the server's authoritative
      // queueLength so a leftover CONFIRMED orphan (from a dropped earlier
      // dequeue) is trimmed. Status-aware: optimistic pending entries are never
      // trimmed, so a 2nd fast send queued before the 1st confirms is safe. A
      // no-op (referential) when the confirmed count is already in sync.
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
            return { queuedMessages: reconcileQueueLength(current, queueLength) }
          }
          const next = current.slice()
          next[idx] = { ...existing, text, status: 'confirmed' }
          return { queuedMessages: reconcileQueueLength(next, queueLength) }
        }
      }
      const entry: QueuedSessionMessage = {
        clientMessageId,
        text,
        queuedAt: Date.now(),
        status: 'confirmed',
      }
      return { queuedMessages: reconcileQueueLength([...current, entry], queueLength) }
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
  const queueLength = optionalNumber(msg, 'queueLength')
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    // #5950 — after removing the dequeued entry, reconcile against the server's
    // authoritative queueLength so any leftover orphan (from a dropped earlier
    // dequeue) is trimmed too. Referential no-op when already in sync.
    applyTo: (current) => ({
      queuedMessages: reconcileQueueLength(removeQueuedMessage(current, clientMessageId), queueLength),
    }),
  }
}

/**
 * #6627 — reconcile the queued list against a turn-complete `result`'s
 * authoritative `queueLength`. `message_dequeued` self-heals only on queue events;
 * if that frame is dropped/late, a stale "Queued" bubble would otherwise persist
 * until the next queue event (or a reconnect). Stamping every `result` with the
 * server's queue length gives a self-heal point on every turn boundary.
 *
 * Returns null when the result carries no finite `queueLength` (older server), so
 * the caller skips the state write entirely. `reconcileQueueLength` only trims
 * CONFIRMED orphans down to the server's count — it never drops a `'pending'`
 * (unconfirmed) entry or a genuinely-still-queued message, so this is safe to run
 * on every result.
 */
export function handleResultQueueReconcile(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): QueuedMessagesBuilder | null {
  const queueLength = optionalNumber(msg, 'queueLength')
  if (queueLength === undefined) return null
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => ({ queuedMessages: reconcileQueueLength(current, queueLength) }),
  }
}
