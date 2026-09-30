/**
 * Position-independent turn-end marking (#7365 review follow-up).
 *
 * The original #7365 implementation split `messages` into turns at
 * `user_input` boundaries. Review caught that this is unsound under
 * send-while-busy (#5939/epic #5935 ④): the SERVER records a mid-turn queued
 * follow-up to history — and echoes the live `user_input` broadcast — at
 * ENQUEUE time (`input-handlers.js`'s `handleInput` → `commitForwardedEffects`
 * → `recordHistoryEntry`), not at actual dispatch time. Concretely,
 * `commitForwardedEffects` fires the moment the provider ADMITS the send
 * (`onInputAdmission`'s `accepted` branch covers BOTH `status: 'accepted'`
 * and `status: 'queued'`), which for a queued send happens well before the
 * running turn's own `result`. The `user_input` row therefore lands — and
 * stays, permanently, since history is append-only and nothing ever moves or
 * removes it — in the MIDDLE of the still-running turn's later output.
 *
 * Tracking "is this row still in the outgoing queue" (the first follow-up fix)
 * only covers the WINDOW between enqueue and the server's `message_dequeued`
 * (auto-flush on the running turn's `result`). Once flushed, the row is
 * indistinguishable from a real turn start under a position-only split — so
 * anything the ORIGINAL turn produces after the row was queued, once that
 * turn's `result` finally arrives and the row is dequeued, reads as belonging
 * to the NEXT (not-yet-started) turn instead. And after a reconnect / history
 * replay, the client never even OBSERVED the row transition through
 * `queuedMessages` — it just materializes at its history position with no
 * queued-vs-not history at all.
 *
 * The fix: stop keying boundaries off `user_input` entirely. `result` IS a
 * real, position-independent turn-end signal — and unlike `user_input`, its
 * OWN history entry lands at its true chronological position no matter how
 * many follow-ups were queued ahead of it (`session-message-history.js`'s
 * `case 'result'` records one in the ring exactly when the turn ends, and
 * `ws-history.js`'s `sendHistoryEntry` replays it as a literal `type: 'result'`
 * frame — the SAME wire shape a live turn-end uses, verified: the dashboard's
 * `case 'result'` in message-handler.ts is UNCONDITIONAL on live-vs-replay,
 * per #7515's removal of the old `!isSessionReplaying` gate). So marking
 * "the last message in `messages` when `result` was processed" reconstructs
 * IDENTICALLY on replay: the same frames arrive in the same order, so the
 * same message ends up last at the same relative position, live or not.
 */
import type { ChatMessage } from './types'

/**
 * Stamp `turnBoundary: true` on the LAST message in `messages` — call this
 * from wherever a `result` (turn-end) event is processed, live or replayed.
 *
 * Idempotent and referentially stable when there is nothing new to mark: an
 * empty array is returned unchanged, and re-marking an already-marked last
 * message (a turn that produced no new content, or a duplicate/retried
 * `result`) returns the SAME array reference rather than allocating —
 * matching this codebase's "referential no-op skips the write" convention
 * (e.g. `reconcileQueueLength`).
 */
export function markTurnBoundary(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages
  const lastIdx = messages.length - 1
  const last = messages[lastIdx]!
  if (last.turnBoundary === true) return messages
  const next = messages.slice()
  next[lastIdx] = { ...last, turnBoundary: true }
  return next
}
