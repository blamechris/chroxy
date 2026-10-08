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

/** What the run finder walks: a transcript row, or a hidden message that ends a turn. */
type Entry = { kind: 'row'; rowIndex: number; row: ChatViewMessage } | { kind: 'boundary'; message: ChatMessage }

/**
 * The rows, with each HIDDEN turn boundary spliced in where it sits.
 *
 * `markTurnBoundary` stamps the last non-`user_input` message of a turn, and that
 * can be a message the chat view filters out: a `system` row, or a `tool_use` /
 * `thinking` row under the compact-chat filter. It has no row, so a finder that
 * walks rows alone never sees the turn end and would fold the next turn's prompts
 * into this one. `storeMsgMap` holds every store message in transcript order, so a
 * stamped message that is on no row is placed between the rows around it.
 */
function entriesWithHiddenBoundaries(
  rows: readonly ChatViewMessage[],
  storeMsgMap: ReadonlyMap<string, ChatMessage>,
  chatToolGroupPayloads: ReadonlyMap<string, { messages: ChatMessage[] }>,
): Entry[] {
  const onRow = new Set<string>()
  for (const row of rows) {
    const payload = chatToolGroupPayloads.get(row.id)
    if (payload) for (const m of payload.messages) onRow.add(m.id)
    else onRow.add(row.id)
  }
  // Transcript position of every message, and the stamped messages no row shows.
  const position = new Map<string, number>()
  const hidden: { message: ChatMessage; at: number }[] = []
  let at = 0
  for (const m of storeMsgMap.values()) {
    position.set(m.id, at)
    if (m.turnBoundary && !onRow.has(m.id)) hidden.push({ message: m, at })
    at++
  }
  if (hidden.length === 0) return rows.map((row, rowIndex) => ({ kind: 'row', rowIndex, row }))

  const entries: Entry[] = []
  let next = 0 // next hidden boundary not yet placed
  rows.forEach((row, rowIndex) => {
    const first = chatToolGroupPayloads.get(row.id)?.messages[0]?.id ?? row.id
    const rowAt = position.get(first)
    // Rows with no store message (a turn summary) have no position; they end a run anyway.
    if (rowAt !== undefined) {
      while (next < hidden.length && hidden[next]!.at < rowAt) entries.push({ kind: 'boundary', message: hidden[next++]!.message })
    }
    entries.push({ kind: 'row', rowIndex, row })
  })
  return entries
}

export function collapseResolvedPermissionRuns(
  rows: ChatViewMessage[],
  storeMsgMap: ReadonlyMap<string, ChatMessage>,
  chatToolGroupPayloads: ReadonlyMap<string, { messages: ChatMessage[] }> = new Map(),
): CollapseResolvedPermissionRunsResult {
  const groups = new Map<string, string[]>()
  const entries = entriesWithHiddenBoundaries(rows, storeMsgMap, chatToolGroupPayloads)
  const runs = findResolvedPermissionRuns(entries, (entry): readonly ChatMessage[] => {
    // A hidden boundary is its own (never-transparent) message: it ends the run.
    if (entry.kind === 'boundary') return [entry.message]
    // A collapsed tool group stands for its messages; a plain row for its own.
    const payload = chatToolGroupPayloads.get(entry.row.id)
    if (payload) return payload.messages
    const m = storeMsgMap.get(entry.row.id)
    return m ? [m] : []
  })
  if (runs.length === 0) return { rows, groups }

  // First member row index -> its run; every later member row is dropped.
  const runAt = new Map<number, { rowIds: string[]; first: ChatViewMessage }>()
  const dropped = new Set<number>()
  for (const run of runs) {
    const members = run.items.filter((e): e is Extract<Entry, { kind: 'row' }> => e.kind === 'row')
    runAt.set(members[0]!.rowIndex, { rowIds: members.map((e) => e.row.id), first: members[0]!.row })
    for (const e of members.slice(1)) dropped.add(e.rowIndex)
  }

  const out: ChatViewMessage[] = []
  for (let i = 0; i < rows.length; i++) {
    const run = runAt.get(i)
    if (run) {
      const id = permissionGroupRowId(run.first.id)
      groups.set(id, run.rowIds)
      out.push({
        id,
        type: 'permission-group',
        // The members share one description; carrying it keeps in-session find
        // (which reads a row's `content`) matching a grouped prompt.
        content: run.first.content,
        // The group sits at the first member's position, so it carries that time.
        timestamp: run.first.timestamp,
      })
    } else if (!dropped.has(i)) {
      out.push(rows[i]!)
    }
  }
  return { rows: out, groups }
}
