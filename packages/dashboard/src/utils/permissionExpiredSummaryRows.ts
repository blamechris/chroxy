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
 */
import type { ChatViewMessage } from '../components/ChatView'
import type { ExpiredPermissionTurnSummary } from '@chroxy/store-core'

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
    if (row.type === 'user_input') {
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
