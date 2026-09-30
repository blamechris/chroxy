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
 * Turn attribution has TWO sources, chosen EXPLICITLY by the caller — never
 * inferred from which signals happen to be present (a live session before
 * its first `result` has no `turnBoundary` marks either, and must not be
 * mistaken for the other source):
 *
 * - `'marker'` (default; the live chat path, `useChatMessages.ts`) — turns
 *   are delimited by `turnBoundary`-marked messages (`turn-boundaries.ts`'s
 *   `markTurnBoundary`, called from `case 'result'` in message-handler.ts).
 *   NOT `user_input` position: chroxy's OWN server records a mid-turn
 *   queued follow-up's `user_input` to its in-memory history ring at
 *   ENQUEUE time (see `turn-boundaries.ts`'s doc), so that row can sit
 *   permanently in the middle of the turn that's still running. `result` is
 *   position-independent instead — it lands at its true chronological spot
 *   no matter how many follow-ups were queued ahead of it, live or replayed
 *   identically.
 *
 * - `'user_input'` (the closed-transcript path, `TranscriptViewer.tsx`) —
 *   turns are delimited by `user_input` ROW POSITION, the round-1 model.
 *   This data source is NOT chroxy's own history ring at all: it is the raw
 *   on-disk Claude Code JSONL transcript
 *   (`packages/server/src/jsonl-reader.js`, via
 *   `handleRequestConversationTranscript`), which structurally never emits a
 *   `result`-typed entry (confirmed: its only three `type:` literals are
 *   `'user_input'`, `'response'`, `'tool_use'`) — so `'marker'` mode would
 *   find zero boundaries and collapse an entire multi-turn conversation into
 *   one summary. `user_input` position is SOUND here specifically because
 *   this transcript is Claude Code's OWN log of what the underlying CLI/SDK
 *   process actually did, not chroxy's queue bookkeeping: a message chroxy
 *   holds in `BaseSession._outgoingQueue` (`base-session.js`) is invisible to
 *   the provider until `dequeueNextOutgoing()` actually calls `sendMessage`
 *   on it — which happens only once the CURRENT turn's `result` fires (every
 *   provider's `_emitResult`-equivalent calls it: `cli-session.js`,
 *   `sdk-session.js`, `codex-app-server-session.js`, `acp-session.js`). So
 *   the CLI never sees, and therefore never logs, a queued follow-up until
 *   dispatch time — its JSONL `type: 'user'` entry lands at the position a
 *   real turn actually started, not at chroxy's earlier admission time. A
 *   closed transcript is also immutable once loaded (no further streaming,
 *   no 'thinking'-placeholder churn), so anchoring a summary on "the last
 *   message before the next `user_input`" is safe with no risk of the
 *   position later shifting.
 */
import { isExpiredUnansweredPermissionPrompt } from './pending-permissions'
import type { ChatMessage } from './types'

/** One turn's worth of permission prompts that expired without an answer. */
export interface ExpiredPermissionTurnSummary {
  /**
   * id of the message the dashboard splices the summary row immediately
   * after. In `'marker'` mode this is the `turnBoundary`-marked message; in
   * `'user_input'` mode it is the last message before the next `user_input`
   * row. `null` for the TRAILING (not yet ended) turn, which has no such
   * anchor yet — the dashboard appends that one at the tail instead.
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
 * Which signal delimits a turn — see this module's doc for the full
 * rationale for each. Always passed explicitly by the caller; never inferred
 * from which markers happen to be present in `messages`.
 */
export type TurnBoundarySource = 'marker' | 'user_input'

function getSummariesByMarker(
  messages: ChatMessage[],
  now: number,
  isSessionIdle: boolean,
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

function getSummariesByUserInputPosition(
  messages: ChatMessage[],
  now: number,
  isSessionIdle: boolean,
): ExpiredPermissionTurnSummary[] {
  const summaries: ExpiredPermissionTurnSummary[] = []
  let requestIds: string[] = []
  let tools: string[] = []
  // The anchor for the CLOSING segment is "the last message seen before the
  // next user_input (or before isSessionIdle's trailing flush)" — unlike
  // marker mode, a `user_input` row here is a turn START, not an end, so it
  // is never itself the anchor.
  let lastMessageId: string | null = null
  let turnOpen = false

  const flush = () => {
    if (requestIds.length > 0) {
      summaries.push({ turnEndMessageId: lastMessageId, requestIds, tools, count: requestIds.length })
    }
    requestIds = []
    tools = []
  }

  for (const m of messages) {
    if (m.type === 'user_input') {
      flush()
      turnOpen = true
      lastMessageId = null
      continue
    }
    // Messages before the first `user_input` belong to no turn.
    if (!turnOpen) continue
    lastMessageId = m.id
    if (m.requestId && isExpiredUnansweredPermissionPrompt(m, now)) {
      requestIds.push(m.requestId)
      tools.push(m.tool ?? 'permission')
    }
  }
  if (isSessionIdle) flush()

  return summaries
}

/**
 * Group `messages` into turns and return one summary per turn that contains
 * at least one expired-unanswered permission prompt. Turns with zero
 * qualifying prompts are omitted entirely — including a turn where every
 * permission prompt WAS answered, which must render no summary at all (a
 * summary on every ordinary turn would be noise, per the issue's own
 * acceptance criteria).
 *
 * The still-open (current) turn — everything after the last boundary, with
 * no further one yet — is gated by `isSessionIdle`: per the issue's own "at
 * turn end" wording, a still-running turn produces no summary until it
 * actually ends (also keeps the row's list POSITION stable — it never
 * re-anchors to a moving tail on every re-render of a streaming turn). Every
 * EARLIER (bounded) turn is unconditional.
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
 * @param turnBoundarySource which signal delimits a turn — `'marker'`
 *   (default) for the live chat path, `'user_input'` for a closed/historical
 *   transcript. See this module's doc for the full rationale. Always passed
 *   explicitly; a live session simply has no `turnBoundary` marks before its
 *   first `result`, which is NOT "use `user_input` instead" — it means no
 *   turn has ended yet, correctly reported as nothing-to-show (or the
 *   trailing segment, gated by `isSessionIdle`).
 */
export function getExpiredPermissionTurnSummaries(
  messages: ChatMessage[],
  now: number,
  isSessionIdle = true,
  turnBoundarySource: TurnBoundarySource = 'marker',
): ExpiredPermissionTurnSummary[] {
  return turnBoundarySource === 'user_input'
    ? getSummariesByUserInputPosition(messages, now, isSessionIdle)
    : getSummariesByMarker(messages, now, isSessionIdle)
}
