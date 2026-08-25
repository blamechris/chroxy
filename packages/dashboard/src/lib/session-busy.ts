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
import { countLivePermissionPrompts } from '@chroxy/store-core'
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
 * `isIdle` is the server-authoritative working flag (#4639); `streamingMessageId`
 * additionally covers the optimistic pre-status window. Either ⇒ busy.
 *
 * Deliberately does NOT consider pending permissions: this predicate mirrors an
 * INPUT-BAR affordance, and widening it would make a send optimistically claim
 * the server queued it in a state where the server would not.
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
 * holding a live unanswered permission prompt. The third clause is defence in
 * depth rather than the fix — a session paused on a prompt already reports
 * `isIdle === false` — but it keeps the warning honest if that server-side
 * signal is ever late, dropped, or reconciled out of order, and a false
 * POSITIVE here only costs an extra sentence of confirm copy while a false
 * negative costs the user their turn.
 *
 * `now` is injected (not read from the clock) so the expiry half of
 * `isLivePermissionPrompt` is testable.
 */
export function hasInterruptibleWork(s: SessionBusyState, now: number): boolean {
  return isSessionBusy(s) || countLivePermissionPrompts(s.messages, now) > 0
}
