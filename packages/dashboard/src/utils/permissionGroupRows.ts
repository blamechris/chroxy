/**
 * Collapse runs of identical RESOLVED permission prompts into one synthetic
 * `permission-group` row (#6894) -- dashboard-only, downstream of the shared
 * `buildChatViewMessages` pipeline (the mobile app collapses answered prompts to
 * pills on its own and does not call this).
 *
 * Runs are decided by `@chroxy/store-core`'s `findResolvedPermissionRuns` (the
 * one place that knows what "identical" and "resolved" mean); this file only
 * splices. Applied AFTER the expired-permission summary rows are spliced in
 * (`permissionExpiredSummaryRows.ts` anchors on raw row ids, which a group would
 * hide) -- and a summary row between two prompts is itself a row with no store
 * message, so it breaks the run.
 *
 * Only ADJACENT rows group. A tool bubble between two identical prompts breaks
 * the run: grouping across it would reorder what the transcript says happened.
 */
import { findResolvedPermissionRuns, type ChatMessage } from '@chroxy/store-core'
import type { ChatViewMessage } from '../components/ChatView'

/** Deterministic row id for a run -- keyed on its first member, so it is stable as later identical prompts join. */
export function permissionGroupRowId(firstMessageId: string): string {
  return `permission-group-${firstMessageId}`
}

export interface CollapseResolvedPermissionRunsResult {
  /** `rows` with each run replaced by one synthetic row. `rows` itself when nothing groups. */
  rows: ChatViewMessage[]
  /** Group row id -> the store message ids it stands for, in transcript order. */
  groups: Map<string, string[]>
}

export function collapseResolvedPermissionRuns(
  rows: ChatViewMessage[],
  storeMsgMap: ReadonlyMap<string, ChatMessage>,
): CollapseResolvedPermissionRunsResult {
  const groups = new Map<string, string[]>()
  const runs = findResolvedPermissionRuns(rows, (row) => storeMsgMap.get(row.id))
  if (runs.length === 0) return { rows, groups }

  const out: ChatViewMessage[] = []
  let cursor = 0
  for (const run of runs) {
    for (; cursor < run.startIndex; cursor++) out.push(rows[cursor]!)
    const first = run.items[0]!
    const last = run.items[run.items.length - 1]!
    const id = permissionGroupRowId(first.id)
    groups.set(id, run.items.map((r) => r.id))
    out.push({
      id,
      type: 'permission-group',
      // The members share one description; carrying it keeps in-session find
      // (which reads a row's `content`) matching a grouped prompt.
      content: first.content,
      timestamp: last.timestamp,
    })
    cursor = run.startIndex + run.items.length
  }
  for (; cursor < rows.length; cursor++) out.push(rows[cursor]!)
  return { rows: out, groups }
}
