/**
 * Pure match-index helpers for in-session transcript search (#6788).
 *
 * The web dashboard's ChatView is virtualized (#5561) so the browser's
 * native find can't reach rows that are windowed out while off-screen.
 * This module holds the pure, side-effect-free matching + navigation
 * logic the find bar builds on — extracted so it can be unit-tested
 * independently of React and the windowing hook. It mirrors the mobile
 * `searchMatchArray` / `currentMatchIndex` pattern
 * (packages/app/src/screens/SessionScreen.tsx): case-insensitive substring
 * matching, `thinking` rows excluded, wrap-around prev/next navigation.
 */

/** One row of the currently loaded transcript, in document order. */
export interface SearchableRow {
  /** Stable row id — matches the ChatView row key / message id. */
  id: string
  /** Rendered text to match against (case-insensitive substring). */
  text: string
  /**
   * Row discriminator. `thinking` rows are excluded from matches, mirroring
   * mobile which skips reasoning bubbles from find.
   */
  type: string
}

/**
 * Return the ids of rows whose `text` contains `query` (case-insensitive
 * substring), in document order. A blank / whitespace-only query yields no
 * matches. `thinking` rows are never matched.
 */
export function computeTranscriptMatches(
  rows: ReadonlyArray<SearchableRow>,
  query: string,
): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const ids: string[] = []
  for (const row of rows) {
    if (row.type === 'thinking') continue
    if (row.text.toLowerCase().includes(q)) ids.push(row.id)
  }
  return ids
}

/**
 * Step over a match list with wrap-around. `dir` is +1 (next) or -1 (prev).
 * Returns 0 for an empty list. Mirrors mobile's handleSearchNext / handleSearchPrev.
 */
export function stepMatchIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0
  return (((current + dir) % count) + count) % count
}

/**
 * Minimal structural view of a store ChatMessage for search-text extraction —
 * only the fields the extractor reads, so this module stays dependency-free
 * (`@chroxy/store-core`'s ChatMessage satisfies it structurally).
 */
export interface SearchTextSourceMessage {
  content?: string
  toolResult?: string
}

/**
 * Build the searchable text for one chat-view row (#6788 review fix).
 *
 * Tool output does NOT live in `ChatViewMessage.content` — it lives on the
 * store message's `toolResult`. Mobile searches `content || toolResult` on
 * every row; the dashboard must do the same for BOTH tool shapes:
 *
 * - `tool_group` (2+ contiguous tools collapsed): `content` is empty — join
 *   every inner tool's summary + result from the group payload.
 * - singleton `tool_use` (the common case: assistant → one tool → assistant):
 *   append the store message's `toolResult` so a lone tool's stdout / file
 *   contents are just as findable as the same output inside a group.
 * - everything else: the row's own rendered `content`.
 */
export function extractRowSearchText(
  row: { id: string; type: string; content: string },
  toolGroupPayloads: ReadonlyMap<string, { messages: readonly SearchTextSourceMessage[] }>,
  storeMsgMap: ReadonlyMap<string, SearchTextSourceMessage>,
): string {
  if (row.type === 'tool_group') {
    const payload = toolGroupPayloads.get(row.id)
    if (!payload) return row.content
    let text = ''
    for (const m of payload.messages) {
      if (m.content) text += m.content + ' '
      if (m.toolResult) text += m.toolResult + ' '
    }
    return text
  }
  if (row.type === 'tool_use') {
    const result = storeMsgMap.get(row.id)?.toolResult
    return result ? `${row.content} ${result}` : row.content
  }
  return row.content
}
