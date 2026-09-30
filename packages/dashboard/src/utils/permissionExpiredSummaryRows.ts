/**
 * Splice synthetic `permission-expired-summary` rows into a chat-view row
 * list (#7365) — dashboard-only, downstream of the shared
 * `buildChatViewMessages` pipeline.
 *
 * Each {@link ExpiredPermissionTurnSummary} (from `@chroxy/store-core`)
 * anchors to a turn by its `turnStartMessageId` (the turn's `user_input`
 * row). `user_input` rows are never dropped or grouped by
 * `buildChatViewMessages` (only `system` rows are filtered, and only
 * `tool_use`/`thinking` runs are collapsed into `tool_group`), so the anchor
 * id is always found in `rows` when a summary exists for it.
 *
 * The summary row for a turn is inserted immediately before the NEXT turn's
 * `user_input` row, or appended at the very end of `rows` when the
 * summarised turn is the last (possibly still-open) one — i.e. "attached to
 * the turn" means "the last thing rendered for that turn", without needing
 * to know which real row happened to be last inside it (which could itself
 * be a collapsed `tool_group`).
 *
 * `stillQueuedMessageIds` (post-review follow-up, #7365) must mirror the SAME
 * set passed to `getExpiredPermissionTurnSummaries` — a `user_input` row
 * whose id is in it is a send-while-busy follow-up the server has not started
 * yet (see that function's doc for the full rationale), not a turn boundary.
 * Without this, a still-open turn's summary would be flushed (and visually
 * inserted) the moment a queued row is reached, splitting it away from the
 * turn's later content that is still, correctly, part of the SAME summary.
 *
 * Turn-completion gating (`isSessionIdle`, #7365 review S3) needs NO handling
 * here: a still-running trailing turn simply produces no
 * `ExpiredPermissionTurnSummary` object at all from the aggregator, so there
 * is nothing for this function to splice in for it — the gate lives entirely
 * upstream.
 */
import type { ChatViewMessage } from '../components/ChatView'
import type { ExpiredPermissionTurnSummary } from '@chroxy/store-core'

const EMPTY_ID_SET: ReadonlySet<string> = new Set()

/** Deterministic row id for a turn's summary — stable across re-renders. */
export function permissionExpiredSummaryRowId(turnStartMessageId: string): string {
  return `permission-expired-summary-${turnStartMessageId}`
}

export interface InsertPermissionExpiredSummaryRowsResult {
  /** `rows` with one synthetic row spliced in per qualifying turn. */
  rows: ChatViewMessage[]
  /** Row id -> the summary payload, for the `renderMessage` lookup. */
  payloads: Map<string, ExpiredPermissionTurnSummary>
}

export function insertPermissionExpiredSummaryRows(
  rows: ChatViewMessage[],
  summaries: ExpiredPermissionTurnSummary[],
  stillQueuedMessageIds: ReadonlySet<string> = EMPTY_ID_SET,
): InsertPermissionExpiredSummaryRowsResult {
  const payloads = new Map<string, ExpiredPermissionTurnSummary>()
  if (summaries.length === 0) return { rows, payloads }

  const summaryByTurnStart = new Map(summaries.map((s) => [s.turnStartMessageId, s]))
  const out: ChatViewMessage[] = []
  let pending: ExpiredPermissionTurnSummary | null = null
  let lastTimestamp = 0

  const flushPending = () => {
    if (!pending) return
    const rowId = permissionExpiredSummaryRowId(pending.turnStartMessageId)
    payloads.set(rowId, pending)
    out.push({ id: rowId, type: 'permission-expired-summary', content: '', timestamp: lastTimestamp })
    pending = null
  }

  for (const row of rows) {
    // A still-queued `user_input` is not a boundary (see the module doc) —
    // it never keys `summaryByTurnStart` (the aggregator excludes it the
    // same way), so it must not flush the currently-pending turn either;
    // treat it as ordinary content and fall through to the plain push below.
    if (row.type === 'user_input' && !stillQueuedMessageIds.has(row.id)) {
      // Close out the PREVIOUS turn's summary (if any) before opening the
      // next one's tracking — this is what places the row right before the
      // turn boundary rather than at the end of the whole list.
      flushPending()
      pending = summaryByTurnStart.get(row.id) ?? null
    }
    out.push(row)
    lastTimestamp = row.timestamp
  }
  // The last (possibly still-open) turn's summary, if any — appended at the
  // very end since there is no following `user_input` to insert before.
  flushPending()

  return { rows: out, payloads }
}
