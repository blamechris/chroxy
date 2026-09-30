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
 *
 * CORRECTION (review round 2): "the last message" is not quite right either.
 * The queued follow-up's `user_input` row lands at enqueue time (see above),
 * which for the CURRENTLY RUNNING turn can be at, or after, that turn's own
 * last real output — so when `result` fires, the trailing run of the array
 * can be one or more of the user's OWN `user_input` rows, enqueued mid-turn,
 * that have nothing to do with the turn that just ended. Stamping literally
 * the last message would land the mark on the user's OWN next message, and
 * the summary card would then render AFTER it — reading as commentary on
 * what the user just said rather than on the turn that dropped the tool.
 * `markTurnBoundary` now walks back past any TRAILING `user_input` rows and
 * marks the last REAL content message instead — the true end of the turn
 * that is actually closing.
 */
import type { ChatMessage } from './types'

/**
 * Stamp `turnBoundary: true` on the last NON-`user_input` message in
 * `messages` — call this from wherever a `result` (turn-end) event is
 * processed, live or replayed.
 *
 * Walks backward past any trailing `user_input` rows before marking: a
 * mid-turn queued follow-up is recorded (and lands in `messages`) as soon as
 * the server admits it, well before this turn's own `result` — so one or
 * more sitting at the tail when `result` arrives belong to the turn that is
 * ABOUT to start, not the one that just ended (see this module's doc).
 *
 * Edge case: if EVERY message is `user_input` (a turn that produced zero
 * output before `result` — e.g. an immediate error with no visible content),
 * there is nothing eligible to mark. Returns `messages` unchanged rather than
 * stamping a `user_input` row anyway: the previous boundary (if any) stands,
 * and a turn with no content to mark also has nothing an expired-permission
 * summary could ever attribute to it.
 *
 * Idempotent and referentially stable when there is nothing new to mark: an
 * empty array is returned unchanged, and re-marking an already-marked target
 * (a turn that produced no NEW content since the last mark, or a
 * duplicate/retried `result`) returns the SAME array reference rather than
 * allocating — matching this codebase's "referential no-op skips the write"
 * convention (e.g. `reconcileQueueLength`).
 */
export function markTurnBoundary(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages
  let idx = messages.length - 1
  while (idx >= 0 && messages[idx]!.type === 'user_input') idx--
  if (idx < 0) return messages
  const target = messages[idx]!
  if (target.turnBoundary === true) return messages
  const next = messages.slice()
  next[idx] = { ...target, turnBoundary: true }
  return next
}
