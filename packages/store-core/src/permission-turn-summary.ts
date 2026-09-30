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
 * The still-open (current) turn — the one after the last `user_input`, with
 * no following `result` yet — is included too: an expiry can be discovered
 * mid-turn (a tool waited out its full timeout with no `result` yet), and
 * there is no reason to wait for a turn boundary that may not arrive soon
 * before surfacing it.
 *
 * Pure and order-preserving; same inputs yield identical outputs. `now` is
 * threaded through to {@link isExpiredUnansweredPermissionPrompt} rather than
 * read internally, so callers can recompute this on every relevant re-render
 * (mirrors how `derivePendingPermissionCounts` is called with a fresh
 * `Date.now()` inline rather than off a ticking interval) instead of this
 * module owning a clock.
 */
export function getExpiredPermissionTurnSummaries(
  messages: ChatMessage[],
  now: number,
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
  flush()

  return summaries
}
