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
 * Turn attribution (REVISED, #7365 review round 2): turns are delimited by
 * `turnBoundary`-marked messages (`turn-boundaries.ts`'s `markTurnBoundary`,
 * called from `case 'result'` in message-handler.ts), NOT by `user_input`
 * position. `user_input` positions are unsound under send-while-busy: the
 * server records a mid-turn queued follow-up to history at ENQUEUE time, so
 * its row can sit permanently in the middle of the turn that's still
 * running. `result` is position-independent — it lands at its true
 * chronological spot no matter how many follow-ups were queued ahead of it,
 * live or replayed identically (see `turn-boundaries.ts` for the full
 * investigation). No wire change was needed for this — see that module's doc.
 */
import { isExpiredUnansweredPermissionPrompt } from './pending-permissions'
import type { ChatMessage } from './types'

/** One turn's worth of permission prompts that expired without an answer. */
export interface ExpiredPermissionTurnSummary {
  /**
   * id of the message marking this turn's end (the one with
   * `turnBoundary: true`) — the anchor the dashboard splices the summary row
   * immediately after. `null` for the TRAILING (not yet ended) turn, which
   * has no such message yet; the dashboard appends that one at the tail of
   * the transcript instead.
   */
  turnEndMessageId: string | null
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

/**
 * Group `messages` into turns delimited by `turnBoundary`-marked messages and
 * return one summary per turn that contains at least one expired-unanswered
 * permission prompt. Turns with zero qualifying prompts are omitted entirely
 * — including a turn where every permission prompt WAS answered, which must
 * render no summary at all (a summary on every ordinary turn would be noise,
 * per the issue's own acceptance criteria).
 *
 * `user_input` rows are NOT treated specially — a still-queued or since-
 * flushed follow-up is ordinary content wherever it happens to sit, exactly
 * like any other message. (This replaces the earlier `stillQueuedMessageIds`
 * parameter entirely — see `turn-boundaries.ts` for why position-based
 * `user_input` splitting cannot be patched to work across a flush.)
 *
 * The still-open (current) turn — everything after the last `turnBoundary`
 * mark, with no further mark yet — is gated by `isSessionIdle`: per the
 * issue's own "at turn end" wording, a still-running turn produces no
 * summary until it actually ends (also keeps the row's list POSITION stable
 * — it never re-anchors to a moving tail on every re-render of a streaming
 * turn). Every EARLIER (marked) turn is unconditional — turns are strictly
 * sequential server-side, so a later mark could not exist unless the
 * segment before it had already ended.
 *
 * Pure and order-preserving; same inputs yield identical outputs. `now` is
 * threaded through to {@link isExpiredUnansweredPermissionPrompt} rather than
 * read internally, so callers can recompute this on every relevant re-render
 * (mirrors how `derivePendingPermissionCounts` is called with a fresh
 * `Date.now()` inline rather than off a ticking interval) instead of this
 * module owning a clock. This is NOT full parity with
 * `PermissionPrompt.tsx`'s own ticking countdown — that component reads a
 * `now` it ticks every second itself, so its "Timed out" label can flip a
 * few seconds before a caller here next re-derives; low-impact lag, not a
 * guarantee.
 *
 * @param isSessionIdle whether the session's LAST (trailing) turn has
 *   actually ended — sourced from the session's own server-authoritative
 *   `isIdle` flag (#4639), the same signal `isSessionBusy` already reads.
 *   Defaults to `true`: a closed/historical transcript (no live session
 *   behind it, e.g. `TranscriptViewer`) has no "still running" turn by
 *   definition.
 */
export function getExpiredPermissionTurnSummaries(
  messages: ChatMessage[],
  now: number,
  isSessionIdle = true,
): ExpiredPermissionTurnSummary[] {
  const summaries: ExpiredPermissionTurnSummary[] = []

  let requestIds: string[] = []
  let tools: string[] = []

  const flush = (turnEndMessageId: string | null) => {
    if (requestIds.length > 0) {
      summaries.push({ turnEndMessageId, requestIds, tools, count: requestIds.length })
    }
    requestIds = []
    tools = []
  }

  for (const m of messages) {
    if (m.requestId && isExpiredUnansweredPermissionPrompt(m, now)) {
      requestIds.push(m.requestId)
      tools.push(m.tool ?? 'permission')
    }
    if (m.turnBoundary === true) {
      flush(m.id)
    }
  }
  // The trailing (possibly still-open) segment — everything after the last
  // mark — is the one ambiguous case; only emit it once the caller confirms
  // that turn has actually ended.
  if (isSessionIdle) flush(null)

  return summaries
}
