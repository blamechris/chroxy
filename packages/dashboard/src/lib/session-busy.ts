/**
 * session-busy — the ONE definition of "this session has work that a
 * turn-interrupting action would destroy" (#7335).
 *
 * Before this module the dashboard carried two hand-written copies of the
 * question, in the same file, that disagreed:
 *
 *   - `sendInput` (connection.ts, #5952) used the two-part disjunction
 *     `streamingMessageId !== null || isIdle === false`, with a comment
 *     spelling out WHY both halves are required.
 *   - the Auto-mode confirm (connection.ts, #5609) used only the first half,
 *     `!!streamingMessageId`.
 *
 * A session paused on a permission prompt is the state where those two
 * disagree, and it is precisely the state the Auto-mode dialog exists to guard:
 * the #554 stream-split CLEARS `streamingMessageId` when a `permission_request`
 * arrives, while the server-authoritative `isIdle` stays false because the turn
 * really is still in flight (the CLI child is blocked on its PreToolUse hook).
 * So the destructive-consequence warning was suppressed in the one state where
 * users most reach for "skip all prompts" — being prompted is the reason you
 * press the #3729 panic-button — and flipping to Auto silently killed the turn
 * on `claude-cli` behind benign copy.
 *
 * The lesson, not the clause, is what this module encodes: two copies of a
 * safety predicate that can drift IS the defect, so there is one exported
 * helper and both call sites use it.
 */
import { isLivePermissionPrompt } from '@chroxy/store-core'
import type { ChatMessage } from '@chroxy/store-core'

/** The fields of a session state this module reads. */
export interface SessionBusyState {
  streamingMessageId: string | null
  isIdle: boolean
  messages: ChatMessage[]
}

/**
 * #5952 — the busy signal that must match EXACTLY what the InputBar shows as
 * busy (`isStreaming || isBusy`), because it decides whether an optimistic
 * send renders as "Queued" or as a fresh turn.
 *
 * "Must match" is the CONTRACT, not yet a fact this module can enforce: the
 * InputBar's own props are still computed inline in App.tsx as
 * `isBusy={!isIdle}` / `isStreaming={streamingMessageId !== null}` at five call
 * sites — a third copy, and `!isIdle` is not even equivalent to
 * `isIdle === false` should that field ever be nullish (they invert). Routing
 * those props through this helper is #7378. Until then, treat the sentence
 * above as the invariant to preserve rather than one already guarded.
 *
 * `isIdle` is the server-authoritative working flag (#4639); `streamingMessageId`
 * additionally covers the optimistic pre-status window. Either ⇒ busy.
 *
 * Deliberately does NOT consider pending permissions. The reason is the match
 * itself, NOT anything about server behaviour: this expression mirrors the
 * InputBar's own `isStreaming || isBusy`, and any clause added here that the
 * InputBar does not have re-opens the window #5952 closed — where the input UI
 * says one thing and the optimistic render assumes another.
 *
 * (Widening it would in fact be a no-op for the state that motivated #7335: a
 * session paused on a prompt already reports `isIdle === false`. And note the
 * server WOULD queue such a send — `CliSession.sendMessage` gates purely on
 * `_isBusy`, which a pending permission never clears — so "the server would not
 * queue it" is not a reason for anything. An earlier draft of this comment said
 * exactly that and was wrong.)
 */
export function isSessionBusy(
  s: Pick<SessionBusyState, 'streamingMessageId' | 'isIdle'>,
): boolean {
  return s.streamingMessageId !== null || s.isIdle === false
}

/**
 * #7335 — is there in-flight work a turn-interrupting action (the CLI's
 * respawn-on-auto-switch) would destroy?
 *
 * A strict superset of {@link isSessionBusy}: busy in the InputBar sense, OR
 * holding a permission prompt that is still ANSWERABLE. The second clause is
 * defence in depth rather than the fix — a session paused on a prompt already
 * reports `isIdle === false` — but it keeps the warning honest if that
 * server-side signal is ever late, dropped, or reconciled out of order.
 *
 * The `options` check is a SECOND signal, not the primary one. The primary fix
 * is in the `permission_expired` handler (message-handler.ts), which now stamps
 * `expiresAt` to the present so `isLivePermissionPrompt`'s `expiresAt > now`
 * gate goes false — previously it cleared only `options`, which that predicate
 * never reads, so a prompt the server had already killed went on counting as
 * "live" for the rest of its five minutes and this dialog cried wolf ("this
 * will INTERRUPT the running turn") at a session with nothing in flight.
 * #7335's own server half made that state ROUTINE rather than rare: every
 * auto-switch now expires the open prompt.
 *
 * Kept as well as the `expiresAt` fix because the two fail independently: a
 * retired prompt is identifiable by EITHER signal, and this is a
 * destructive-action warning where the cost of the redundancy is one extra
 * boolean. Both are pinned by tests, so neither can rot into a lie unnoticed.
 *
 * Filtered here rather than inside `isLivePermissionPrompt`, which is shared
 * cross-client (#5759) and has four other call sites.
 *
 * `now` is injected (not read from the clock) so the expiry gate is testable.
 */
export function hasInterruptibleWork(s: SessionBusyState, now: number): boolean {
  if (isSessionBusy(s)) return true
  return s.messages.some((m) => m.options !== undefined && isLivePermissionPrompt(m, now))
}
