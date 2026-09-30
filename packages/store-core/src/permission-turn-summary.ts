/**
 * Per-turn aggregation of permission prompts that expired unanswered (#7365).
 *
 * Split out of #7351 (Defect 2): when a permission prompt expires with no
 * answer, the agent continues without that tool — silently. #7364 fixed the
 * *notification* half (chroxy never even requested `Notification` permission,
 * so nothing ever fired). This module fixes the *aggregate* half: the
 * per-prompt marker (`PermissionPrompt.tsx`'s "Permission expired — Claude
 * will continue without this tool") is easy to miss once the turn has moved
 * on, because it is one collapsed row in a long transcript. Nothing
 * summarised "this turn ran without N tools it asked for" at the point where
 * the user reads the result — until now.
 *
 * Turn attribution: the store carries no explicit turn id on `ChatMessage`.
 * A `result` wire message IS "a guaranteed turn boundary" (see
 * message-handler.ts's `case 'result'`), but it is never itself appended to
 * `messages` — only side effects (cost, contextUsage, clearing activeTools)
 * ride on it. The one boundary that DOES land in the array is `user_input`:
 * every turn starts with exactly one, and no producer emits a second before
 * the first turn's `result` — so "everything from one `user_input` up to
 * (not including) the next" is the turn. This is derived from existing state
 * rather than adding a wire turn id, per #7365's proposal.
 *
 * CORRECTION (post-review, still #7365): that invariant is false under
 * send-while-busy (#5939/epic #5935 ④). `addUserMessage(text, attachments,
 * { queued: true })` appends a REAL `type: 'user_input'` row to `messages`
 * the moment the user sends a follow-up while a turn is still running —
 * long before that turn's `result` arrives. The message is not fake; it is
 * queued content the SERVER has not started processing yet
 * (`dequeueNextOutgoing()` in `base-session.js` only flushes it on the
 * running turn's own `result`). So a second `user_input` can legitimately
 * appear mid-turn without the first turn having ended, and a naive
 * position-only split misattributes anything the RUNNING turn does after
 * that point (including a permission that expires) to the queued,
 * not-yet-started turn instead.
 *
 * The fix does not need a wire change: the client already tracks exactly
 * which `user_input` ids are still queued, in the per-session
 * `queuedMessages: QueuedSessionMessage[]` array (`handlers/outgoing-queue.ts`)
 * — populated the instant a queued send is added (`clientMessageId` equals
 * the `ChatMessage.id`, see `addUserMessage`) and REMOVED only when the
 * server's `message_dequeued` confirms the turn has actually started
 * (`reason: 'flush'`) or the send was cancelled/interrupted. There is no
 * "sent" timestamp recorded on the `ChatMessage` itself — the entry's
 * ABSENCE from `queuedMessages` at evaluation time is the turn-start
 * signal. `getExpiredPermissionTurnSummaries` takes the caller's current
 * still-queued id set and treats a `user_input` whose id is in it as
 * ordinary content, not a boundary: nothing before it in transcript order
 * gets flushed, and it does not become a new `turnStartMessageId`. Once the
 * server dequeues it (removing it from the set), the NEXT recomputation
 * (the same store update that clears the "Queued" badge) sees it as a real
 * boundary — no polling, no extra clock.
 *
 * Other turn-start producers were checked and do not need the same
 * treatment: plan approval and every other user-initiated send funnel
 * through the SAME `sendInput` → `addUserMessage(..., { queued: busy })`
 * gate (dashboard `connection.ts`), so a send while the session is genuinely
 * idle (busy === false, e.g. answering a plan-approval prompt) is never
 * queued and always starts a real turn. Answering an AskUserQuestion sends
 * a distinct `user_question_response` wire message and never calls
 * `addUserMessage` at all — no new `user_input` row is appended, so it
 * cannot introduce a boundary of either kind.
 */
import { isExpiredUnansweredPermissionPrompt } from './pending-permissions'
import type { ChatMessage } from './types'

/** One turn's worth of permission prompts that expired without an answer. */
export interface ExpiredPermissionTurnSummary {
  /** id of the `user_input` message that opened this turn. */
  turnStartMessageId: string
  /**
   * `requestId` of every permission prompt in the turn that expired
   * unanswered, in transcript order. Always non-empty — a turn with zero
   * qualifying prompts never produces a summary (see
   * {@link getExpiredPermissionTurnSummaries}).
   */
  requestIds: string[]
  /**
   * Tool name for each entry in `requestIds`, same order/index. Falls back
   * to `'permission'` when the prompt's `tool` is missing, mirroring
   * `handlePermissionTimeout`'s convention for the same gap.
   */
  tools: string[]
  /** `requestIds.length`, exposed directly so renderers don't recompute it. */
  count: number
}

/** Shared empty-set default so callers that pass nothing don't allocate. */
const EMPTY_ID_SET: ReadonlySet<string> = new Set()

/**
 * Group `messages` into turns delimited by `user_input` rows and return one
 * summary per turn that contains at least one expired-unanswered permission
 * prompt. Turns with zero qualifying prompts are omitted entirely — including
 * a turn where every permission prompt WAS answered, which must render no
 * summary at all (a summary on every ordinary turn would be noise, per the
 * issue's own acceptance criteria).
 *
 * Messages preceding the first `user_input` (e.g. a replay window that opens
 * mid-conversation) belong to no turn and are ignored — there is no earlier
 * turn in the transcript to attach them to.
 *
 * The still-open (current) turn — the one after the last real `user_input`,
 * with no following `result` yet — is gated by `isSessionIdle` (see below):
 * the issue's own wording is "AT TURN END", so a still-running turn produces
 * no summary until it actually ends. (An earlier revision rendered it
 * immediately on the reasoning that a `result` boundary may never arrive;
 * review caught that this also made the row's list POSITION unstable — it
 * re-anchored to the transcript tail on every re-render of a still-streaming
 * turn, since the row is always "whatever comes after the last thing seen so
 * far". Gating on turn-end fixes both: the row appears once, at a position
 * that never moves again, and the per-prompt marker in `PermissionPrompt.tsx`
 * — which renders instantly, independent of turn state — remains the
 * guaranteed-to-appear signal if a turn never completes at all.)
 *
 * Pure and order-preserving; same inputs yield identical outputs. `now` is
 * threaded through to {@link isExpiredUnansweredPermissionPrompt} rather than
 * read internally, so callers can recompute this on every relevant re-render
 * (mirrors how `derivePendingPermissionCounts` is called with a fresh
 * `Date.now()` inline rather than off a ticking interval) instead of this
 * module owning a clock.
 *
 * @param stillQueuedMessageIds ids of `user_input` messages sitting in the
 *   per-session outgoing queue (send-while-busy, #5939) — sent optimistically
 *   but not yet dequeued/flushed, so the turn they would start has not
 *   actually begun. Treated as ordinary (non-boundary) content: nothing
 *   before one in transcript order is flushed, and it never becomes a
 *   `turnStartMessageId`. Defaults to empty, matching every caller that has
 *   no live queue (a closed/historical transcript).
 * @param isSessionIdle whether the LAST real turn boundary in `messages` has
 *   actually ended. Every EARLIER real boundary has, by construction,
 *   already ended — turns are strictly sequential server-side (the next
 *   queued send is only dequeued after the current turn's `result`), so only
 *   the trailing turn's completion is ever ambiguous. Sourced from the
 *   session's own server-authoritative `isIdle` flag (#4639) — the same
 *   signal `isSessionBusy` already reads — so this needs no new wire field.
 *   Defaults to `true`: a closed/historical transcript (no live session
 *   behind it, e.g. `TranscriptViewer`) has no "still running" turn by
 *   definition.
 */
export function getExpiredPermissionTurnSummaries(
  messages: ChatMessage[],
  now: number,
  stillQueuedMessageIds: ReadonlySet<string> = EMPTY_ID_SET,
  isSessionIdle = true,
): ExpiredPermissionTurnSummary[] {
  const summaries: ExpiredPermissionTurnSummary[] = []

  let turnStartMessageId: string | null = null
  let requestIds: string[] = []
  let tools: string[] = []

  const flush = () => {
    if (turnStartMessageId !== null && requestIds.length > 0) {
      summaries.push({ turnStartMessageId, requestIds, tools, count: requestIds.length })
    }
  }

  for (const m of messages) {
    if (m.type === 'user_input') {
      // A still-queued send is not a turn boundary — the server has not
      // started processing it, so it is ordinary content belonging to
      // whichever turn (or no turn, before the first real boundary) is
      // already open. Fold it through without flushing or reassigning.
      if (stillQueuedMessageIds.has(m.id)) continue
      // This flush is for the PREVIOUS turn, which has necessarily already
      // ended (see `isSessionIdle`'s doc) — always unconditional.
      flush()
      turnStartMessageId = m.id
      requestIds = []
      tools = []
      continue
    }
    // Messages before the first `user_input` belong to no turn.
    if (turnStartMessageId === null) continue
    if (m.requestId && isExpiredUnansweredPermissionPrompt(m, now)) {
      requestIds.push(m.requestId)
      tools.push(m.tool ?? 'permission')
    }
  }
  // The trailing turn's flush is the one ambiguous case — only emit it once
  // the caller confirms that turn has actually ended.
  if (isSessionIdle) flush()

  return summaries
}
