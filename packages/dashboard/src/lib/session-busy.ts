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
import type { ChatMessage, QueuedSessionMessage } from '@chroxy/store-core'

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
 * "Must match" is now a FACT rather than an aspiration (#7378). The InputBar's
 * props are no longer written inline in App.tsx: they come from
 * {@link inputBarBusyProps} below, which builds `isStreaming` and `isBusy` from
 * the same two clauses this function ORs — so `isStreaming || isBusy` equals
 * `isSessionBusy(s)` by construction, for every input including nullish ones.
 * `input-bar-busy-wiring.test.ts` fails if a seventh inline copy appears at any
 * of those prop sites, and `session-busy.test.ts` pins the identity itself.
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

/** The two busy props the InputBar (and the components that forward to it) take. */
export interface InputBarBusyProps {
  isStreaming: boolean
  isBusy: boolean
}

/**
 * #7378 — the InputBar's busy props, derived here so `isStreaming || isBusy` is
 * {@link isSessionBusy} BY CONSTRUCTION rather than by everyone spelling it the
 * same way.
 *
 * The header comment above used to claim that match as a fact. It was not one:
 * the props were hand-written inline in App.tsx at six sites as
 * `isBusy={!isIdle}` / `isStreaming={streamingMessageId !== null}` — a third
 * copy of the predicate, in a different spelling from both others.
 *
 * `!isIdle` and `isIdle === false` agree only while the field is a strict
 * boolean. **They invert when it is nullish**: `!undefined` is `true` (busy),
 * `undefined === false` is `false` (idle). The store types `isIdle` as
 * `boolean`, but this surface evidently does not trust that — `App.tsx` writes
 * `isIdle: isIdle ?? true` in one place and passes `state?.isIdle` in another.
 *
 * The decision, taken deliberately here rather than differing per call site:
 * **an absent `isIdle` means IDLE.** That follows `isIdle === false`, which is
 * what both other copies already use (`sendInput`, and the per-session busy map
 * in App.tsx), and what `isIdle ?? true` independently implies. `!isIdle` was
 * the outlier, and it was the one wired to the UI.
 *
 * Note the SIBLING field keeps the opposite convention: `streamingMessageId
 * !== null` reads an absent id as streaming, i.e. busy. That is deliberate and
 * left alone — it is inherited unchanged from `isSessionBusy`, which also backs
 * `hasInterruptibleWork`, where a destructive-action warning should fail toward
 * warning. Both conventions are pinned by tests below so neither is accidental.
 *
 * Returns BOTH props rather than one merged boolean because the InputBar draws
 * a real distinction between them — `isBusy && !isStreaming` gates a separate
 * affordance — so collapsing them would change the UI, not just the wiring.
 */
export function inputBarBusyProps(
  s: Pick<SessionBusyState, 'streamingMessageId' | 'isIdle'>,
): InputBarBusyProps {
  return { isStreaming: s.streamingMessageId !== null, isBusy: s.isIdle === false }
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

/** The fields of a session state {@link isAwaitingFirstOutput} reads. */
export interface AwaitingFirstOutputState extends SessionBusyState {
  queuedMessages?: ReadonlyArray<QueuedSessionMessage>
}

/**
 * #8703 — is this session busy with a turn that has produced NO output yet?
 *
 * True when {@link isSessionBusy} AND the transcript's latest (non-queued) user
 * message has no assistant output after it. A Stop here ends the turn before it
 * starts, which is rarely what a user pressing Escape out of habit means, so the
 * dashboard's interrupt door asks first.
 *
 * "Assistant output" is any message the model or provider produced for the turn:
 * `response` (streamed text), `tool_use` (a tool call and its result), a real
 * `thinking` block (id other than the `'thinking'` placeholder), a `prompt`
 * (permission request / question card: the model asked for something) and an
 * `error` (a provider error: the turn has already answered). NOT output: the
 * client-side `'thinking'` spinner placeholder (`filterThinking`'s target),
 * `system` lines, an EMPTY `response` (the slot a `stream_start` opens before
 * its first delta; claude-tui, the default provider, emits it as the turn
 * begins), and user bubbles that are still queued (they are follow-ups
 * behind the running turn, not the turn's own prompt).
 *
 * Known edges, documented not fixed: a queued bubble missing from
 * `queuedMessages` (for example mid-replay) reads as the latest user message
 * and so fails toward confirming; a server-initiated turn with an older
 * no-output `user_input` at the tail could gate; and if the first token lands
 * while the dialog is open, Confirm still stops the turn, which is the user's
 * explicit choice.
 *
 * Deliberately derived from the transcript and NOT from
 * `streamingMessageId === 'pending'`: `sendMessage`'s 5 s stall safety net
 * clears that sentinel while the SDK may still be starting, which would close
 * the window exactly when a slow start needs the confirmation.
 */
export function isAwaitingFirstOutput(s: AwaitingFirstOutputState): boolean {
  if (!isSessionBusy(s)) return false
  const queued = new Set(
    (s.queuedMessages ?? []).map((q) => q.clientMessageId).filter((id): id is string => !!id),
  )
  let sawUser = false
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]
    if (!m) continue
    if (m.type === 'user_input') {
      if (queued.has(m.id)) continue
      sawUser = true
      break
    }
    if (m.type === 'thinking' && m.id === 'thinking') continue
    if (m.type === 'system') continue
    // A `response` is output only once it holds text. claude-tui emits
    // `stream_start` as the turn begins (#4010) and the dashboard appends an
    // EMPTY response slot for it, so the slot alone must not close the window.
    if (m.type === 'response' && (m.content ?? '').trim() === '') continue
    return false
  }
  return sawUser
}
