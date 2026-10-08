/**
 * Collapse runs of identical RESOLVED permission prompts into one synthetic
 * `permission-group` row (#6894) -- dashboard-only, downstream of the shared
 * `buildChatViewMessages` pipeline (the mobile app collapses answered prompts to
 * pills on its own and does not call this).
 *
 * Runs are decided by `@chroxy/store-core`'s `findResolvedPermissionRuns` (the
 * one place that knows what "identical", "resolved" and "same turn" mean); this
 * file only splices.
 *
 * A real turn records each approved prompt next to the tool run it gated
 * (`tool bubble, permission record, tool bubble, permission record, ...`), so the
 * identical prompts are SEPARATED by tool rows. The group row takes the position
 * of the FIRST member; the later members' rows are dropped; every tool row stays
 * exactly where it was. The group is therefore one line ahead of the tool runs
 * the later prompts approved -- the price of a single line, and the group expands
 * to the individual records.
 *
 * Applied AFTER the expired-permission summary rows are spliced in
 * (`permissionExpiredSummaryRows.ts` anchors on raw row ids, which a group would
 * hide); a summary row is a row with no store message, so it ends a run.
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
  chatToolGroupPayloads: ReadonlyMap<string, { messages: ChatMessage[] }> = new Map(),
): CollapseResolvedPermissionRunsResult {
  const groups = new Map<string, string[]>()
  const runs = findResolvedPermissionRuns(rows, (row): readonly ChatMessage[] => {
    // A collapsed tool group stands for its messages; a plain row for its own.
    const payload = chatToolGroupPayloads.get(row.id)
    if (payload) return payload.messages
    const m = storeMsgMap.get(row.id)
    return m ? [m] : []
  })
  if (runs.length === 0) return { rows, groups }

  // First member index -> its run; every later member index is dropped.
  const runAt = new Map<number, (typeof runs)[number]>()
  const dropped = new Set<number>()
  for (const run of runs) {
    runAt.set(run.indices[0]!, run)
    for (const idx of run.indices.slice(1)) dropped.add(idx)
  }

  const out: ChatViewMessage[] = []
  for (let i = 0; i < rows.length; i++) {
    const run = runAt.get(i)
    if (run) {
      const first = run.items[0]!
      const id = permissionGroupRowId(first.id)
      groups.set(id, run.items.map((r) => r.id))
      out.push({
        id,
        type: 'permission-group',
        // The members share one description; carrying it keeps in-session find
        // (which reads a row's `content`) matching a grouped prompt.
        content: first.content,
        // The group sits at the first member's position, so it carries that time.
        timestamp: first.timestamp,
      })
    } else if (!dropped.has(i)) {
      out.push(rows[i]!)
    }
  }
  return { rows: out, groups }
}
