/**
 * Client-side line hunk diff (#6542, IDE P3.1) — the shared foundation for the
 * edit-in-place / per-hunk-review surfaces (#6543 feature B, #6544 feature A).
 *
 * The server's git `getDiff` can only diff what's on disk, so a pre-write diff
 * (original → an in-editor buffer, or an agent's proposed content) has to be
 * computed on the client. This module produces the SAME `DiffHunk` shape the
 * server emits (so `HunkView` renders both identically) and adds `applyHunks`,
 * which reconstructs a file applying only an operator-selected SUBSET of hunks —
 * the core of per-hunk accept/reject.
 *
 * The differ is a straightforward LCS line diff (correct + easy to reason about)
 * with a size guard: past `MAX_DIFF_LINES` combined lines it falls back to a
 * single whole-file-replace hunk rather than allocate an O(n·m) table.
 *
 * Headers follow git's unified-diff convention, INCLUDING the empty-side cases —
 * a new file is `@@ -0,0 +1,N @@` (pure additions, no phantom deletion) and a
 * deleted file is `@@ -1,N +0,0 @@` — so the output stays consistent with the
 * server's git diff and `applyHunks` can round-trip a git-style count-0 hunk.
 *
 * Round-trip contract (the load-bearing invariants, verified in the tests):
 *   - `applyHunks(original, computeHunks(original, proposed), ALL)  === proposed`
 *   - `applyHunks(original, computeHunks(original, proposed), NONE) === original`
 *   - selecting any subset yields a valid interleaving of the two sides.
 */
import type { DiffHunk } from './types/git'
import { computeHunks, splitContentLines, DEFAULT_CONTEXT_LINES, MAX_DIFF_LINES } from '@chroxy/protocol'

// The differ itself is shared with the server (#8446): see @chroxy/protocol's hunk-diff.
export { computeHunks, DEFAULT_CONTEXT_LINES, MAX_DIFF_LINES }

/** Parse the 0-indexed original region `[start, start+count)` a hunk covers. */
function parseOriginalRange(header: string): { start: number; count: number } | null {
  const m = /^@@ -(\d+),(\d+) /.exec(header)
  if (!m) return null
  const oldStart = Number(m[1])
  const count = Number(m[2])
  // Inverse of computeHunks's header math: count 0 → oldStart is the 0-indexed
  // insertion position; count > 0 → oldStart is 1-indexed, so subtract 1.
  const start = count === 0 ? oldStart : oldStart - 1
  return { start, count }
}

/** The proposed-side content of a hunk (context + additions, in order). */
function proposedSide(hunk: DiffHunk): string[] {
  return hunk.lines.filter((l) => l.type !== 'deletion').map((l) => l.content)
}

/**
 * Reconstruct a file by applying only the SELECTED hunks (by their index in
 * `hunks`); unselected hunks keep the original lines. `selected` may be a Set or
 * array of indices, or a predicate `(index) => boolean`.
 *
 * Contract: `applyHunks(original, hunks, () => true) === proposed` and
 * `applyHunks(original, hunks, () => false) === original` for hunks produced by
 * `computeHunks(original, proposed)`. A hunk whose header can't be parsed is
 * treated as unselected-safe (its original region is preserved) so a malformed
 * hunk can never corrupt or drop content.
 */
export function applyHunks(
  original: string,
  hunks: DiffHunk[],
  selected: Set<number> | number[] | ((index: number) => boolean),
): string {
  const isSelected =
    typeof selected === 'function'
      ? selected
      : ((s) => (index: number) => s.has(index))(selected instanceof Set ? selected : new Set(selected))

  const orig = splitContentLines(original)
  const out: string[] = []
  let cursor = 0
  hunks.forEach((hunk, index) => {
    const range = parseOriginalRange(hunk.header)
    if (!range) return // unparseable → leave its region to the tail copy below
    // Copy the untouched gap before this hunk.
    if (range.start > cursor) out.push(...orig.slice(cursor, range.start))
    if (isSelected(index)) {
      // Take the proposed side (context + additions).
      out.push(...proposedSide(hunk))
    } else {
      // Keep the original region verbatim.
      out.push(...orig.slice(range.start, range.start + range.count))
    }
    cursor = range.start + range.count
  })
  // Copy the trailing gap after the last hunk.
  if (cursor < orig.length) out.push(...orig.slice(cursor))
  return out.join('\n')
}

/**
 * A hunk of the reviewed diff, as the server needs to find it again: the numbers of
 * its `@@ -oldStart,oldCount +newStart,newCount @@` header. The server rebuilds the
 * approved Write/Edit from the RAW tool input and these ranges (#8446), because the
 * client only ever sees the redacted copy and must not send content the server
 * writes. Git's convention, as `computeHunks` emits it.
 */
export interface HunkRange {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

/**
 * The `editedInput` a permission response carries: text fields the server's content
 * whitelist reads (a Bash `command`), and for a hunk-reviewed Write/Edit the hunk
 * decisions, `droppedHunks` and `keptHunks`.
 */
export type PermissionEditedInput = { [field: string]: string | HunkRange[] }

/** Every hunk of a reviewed diff, split into the ones the operator dropped and kept. */
export type HunkDecisions = {
  droppedHunks: HunkRange[]
  keptHunks: HunkRange[]
}

/**
 * The header ranges of EVERY hunk, split by the operator's choice. `selected` is the
 * set of KEPT hunk indices, as `applyHunks` takes it. Both lists are sent: the server
 * checks that the lines outside all hunks are unchanged lines, which is what proves
 * each range is a region of the real diff. A hunk whose header cannot be parsed is not
 * reported; `computeHunks` never produces one.
 */
export function hunkDecisions(hunks: DiffHunk[], selected: Set<number> | number[]): HunkDecisions {
  const kept = selected instanceof Set ? selected : new Set(selected)
  const decisions: HunkDecisions = { droppedHunks: [], keptHunks: [] }
  hunks.forEach((hunk, index) => {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(hunk.header)
    if (!m) return
    const range = { oldStart: Number(m[1]), oldCount: Number(m[2]), newStart: Number(m[3]), newCount: Number(m[4]) }
    ;(kept.has(index) ? decisions.keptHunks : decisions.droppedHunks).push(range)
  })
  return decisions
}
