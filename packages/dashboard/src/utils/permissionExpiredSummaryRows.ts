/**
 * Splice synthetic `permission-expired-summary` rows into a chat-view row
 * list (#7365) — dashboard-only, downstream of the shared
 * `buildChatViewMessages` pipeline.
 *
 * Each {@link ExpiredPermissionTurnSummary} (from `@chroxy/store-core`)
 * anchors to a turn by its `turnEndMessageId` — the RAW store message that
 * carries `turnBoundary: true` (see `@chroxy/store-core`'s
 * `turn-boundaries.ts`). That raw message does not always have its OWN row
 * in `rows`, though:
 *   - it can be absorbed into a collapsed `tool_group` (a contiguous run of
 *     2+ `tool_use`/`thinking` messages renders as one synthetic row keyed
 *     by the group, not by any individual message's id) — see
 *     `chatToolGroupPayloads`;
 *   - it can be filtered out entirely — a `type: 'system'` row never reaches
 *     `rows` at all (system events render on the System tab), and
 *     `tool_use`/`thinking` rows vanish session-wide under the dashboard's
 *     compact-chat toggle (`hideToolAndThinking`).
 *
 * `resolveAnchorRowId` walks BACKWARD from the raw message through
 * `storeMessages` (the pipeline's raw input) until it finds one that DOES
 * have a row — either directly (`rows` contains its own id) or via
 * `chatToolGroupPayloads` (it was absorbed into a group whose key IS a row).
 * The summary is then spliced immediately after THAT row. This is the
 * position-independent replacement for the round-1 fix's
 * "insert before the next turn's `user_input`" rule, which no longer applies
 * now that turns are delimited by `turnBoundary`, not `user_input` position
 * (see `permission-turn-summary.ts`'s doc for why).
 *
 * The trailing (still-open) turn — `turnEndMessageId: null` — has no anchor
 * yet and is appended at the very end of `rows`, same as before.
 */
import type { ChatMessage, ExpiredPermissionTurnSummary } from '@chroxy/store-core'
import type { ChatViewMessage } from '../components/ChatView'

/** Deterministic row id for a turn's summary — stable across re-renders. */
export function permissionExpiredSummaryRowId(anchorKey: string): string {
  return `permission-expired-summary-${anchorKey}`
}

/** Sentinel anchor key for the trailing (not yet ended) turn — distinguishable from any real message id (`nextMessageId` prefixes never produce this literal string). */
const TRAILING_ANCHOR_KEY = '__current_turn__'

export interface InsertPermissionExpiredSummaryRowsResult {
  /** `rows` with one synthetic row spliced in per qualifying turn. */
  rows: ChatViewMessage[]
  /** Row id -> the summary payload, for the `renderMessage` lookup. */
  payloads: Map<string, ExpiredPermissionTurnSummary>
}

/**
 * Resolve the raw message id `rawId` to the `rows` id it renders as (or was
 * absorbed into), walking backward through `storeMessages` from `rawId`'s own
 * position until one resolves. Returns `null` only in the degenerate case
 * where NOTHING from the start of the transcript up to and including `rawId`
 * has a row at all (the whole prefix was filtered) — vanishingly rare, and
 * the caller drops that summary rather than mis-anchoring it.
 */
export function resolveAnchorRowId(
  rawId: string,
  storeMessages: ChatMessage[],
  rowIdSet: ReadonlySet<string>,
  chatToolGroupPayloads: ReadonlyMap<string, { messages: ChatMessage[]; isActive: boolean }>,
): string | null {
  const rawIdToRowId = new Map<string, string>()
  for (const [groupKey, payload] of chatToolGroupPayloads) {
    for (const m of payload.messages) rawIdToRowId.set(m.id, groupKey)
  }
  const startIdx = storeMessages.findIndex((m) => m.id === rawId)
  if (startIdx === -1) return null
  for (let i = startIdx; i >= 0; i--) {
    const candidateRawId = storeMessages[i]!.id
    const mapped = rawIdToRowId.get(candidateRawId) ?? candidateRawId
    if (rowIdSet.has(mapped)) return mapped
  }
  return null
}

export function insertPermissionExpiredSummaryRows(
  rows: ChatViewMessage[],
  summaries: ExpiredPermissionTurnSummary[],
  storeMessages: ChatMessage[],
  chatToolGroupPayloads: ReadonlyMap<string, { messages: ChatMessage[]; isActive: boolean }>,
): InsertPermissionExpiredSummaryRowsResult {
  const payloads = new Map<string, ExpiredPermissionTurnSummary>()
  if (summaries.length === 0) return { rows, payloads }

  const rowIdSet = new Set(rows.map((r) => r.id))
  const byAnchorRowId = new Map<string, ExpiredPermissionTurnSummary>()
  let trailing: ExpiredPermissionTurnSummary | null = null

  for (const s of summaries) {
    if (s.turnEndMessageId === null) {
      trailing = s
      continue
    }
    const anchor = resolveAnchorRowId(s.turnEndMessageId, storeMessages, rowIdSet, chatToolGroupPayloads)
    if (anchor === null) continue // degenerate — nothing to anchor to; drop rather than mis-render
    byAnchorRowId.set(anchor, s)
  }

  const out: ChatViewMessage[] = []
  for (const row of rows) {
    out.push(row)
    const summary = byAnchorRowId.get(row.id)
    if (summary) {
      const rowId = permissionExpiredSummaryRowId(row.id)
      payloads.set(rowId, summary)
      out.push({ id: rowId, type: 'permission-expired-summary', content: '', timestamp: row.timestamp })
    }
  }

  if (trailing) {
    const rowId = permissionExpiredSummaryRowId(TRAILING_ANCHOR_KEY)
    payloads.set(rowId, trailing)
    const lastTimestamp = out.length > 0 ? out[out.length - 1]!.timestamp : 0
    out.push({ id: rowId, type: 'permission-expired-summary', content: '', timestamp: lastTimestamp })
  }

  return { rows: out, payloads }
}
