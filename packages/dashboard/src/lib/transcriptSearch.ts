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
