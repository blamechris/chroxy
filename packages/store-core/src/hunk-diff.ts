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
import type { DiffHunk, DiffHunkLine } from './types/git'

/** Default unified-diff context lines around each change. */
export const DEFAULT_CONTEXT_LINES = 3

/**
 * Combined-line ceiling before the differ bails to a single whole-file-replace
 * hunk. The LCS table is O(n·m); at 4000 combined lines that is ~4M cells worst
 * case, which is fine, and beyond it a per-hunk review isn't ergonomic anyway.
 */
export const MAX_DIFF_LINES = 4000

type EditOp = { op: 'eq' | 'del' | 'ins'; oldIndex: number; newIndex: number; content: string }

/**
 * Split file content into lines such that `lines.join('\n') === content`, so the
 * round-trip is lossless — a trailing newline becomes a trailing empty element
 * the diff treats like any other line.
 *
 * The one special case is the **empty file**: `''` maps to `[]` (0 lines), NOT
 * `['']`. This matches git's unified-diff model — a `'' → 'x'` diff is then a
 * pure addition (`@@ -0,0 +1,1 @@`, one addition line) rather than a phantom
 * deletion of an empty line — so `computeHunks` output stays consistent with the
 * server's git diff. `[].join('\n') === ''`, so the round-trip is still lossless.
 * (A single newline `'\n'` is `['', '']`, distinct from the empty file.)
 */
function toLines(content: string): string[] {
  return content === '' ? [] : content.split('\n')
}

/**
 * LCS line diff → an ordered edit script. Each op carries the 0-indexed
 * position in the original (`oldIndex`) and proposed (`newIndex`) it sits at,
 * which the hunk builder turns into `@@` line numbers.
 */
function diffLines(a: string[], b: string[]): EditOp[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const ops: EditOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'eq', oldIndex: i, newIndex: j, content: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ op: 'del', oldIndex: i, newIndex: j, content: a[i]! })
      i++
    } else {
      ops.push({ op: 'ins', oldIndex: i, newIndex: j, content: b[j]! })
      j++
    }
  }
  while (i < n) {
    ops.push({ op: 'del', oldIndex: i, newIndex: j, content: a[i]! })
    i++
  }
  while (j < m) {
    ops.push({ op: 'ins', oldIndex: i, newIndex: j, content: b[j]! })
    j++
  }
  return ops
}

/** A single whole-file-replace hunk — the large-input + no-common-line fallback. */
function wholeFileReplaceHunk(a: string[], b: string[]): DiffHunk {
  const lines: DiffHunkLine[] = [
    ...a.map((content): DiffHunkLine => ({ type: 'deletion', content })),
    ...b.map((content): DiffHunkLine => ({ type: 'addition', content })),
  ]
  // git convention: a 0-count side uses a 0-based start (new file `@@ -0,0 +1,N @@`,
  // deleted file `@@ -1,N +0,0 @@`); a non-empty side is 1-based. Keeps the header
  // consistent with `parseOriginalRange`'s count-0 insertion math.
  const oldStart = a.length === 0 ? 0 : 1
  const newStart = b.length === 0 ? 0 : 1
  return { header: `@@ -${oldStart},${a.length} +${newStart},${b.length} @@`, lines }
}

/**
 * Compute the hunks transforming `original` into `proposed`, in the canonical
 * `DiffHunk` shape (git-style `@@ -o,c +n,c @@` header + context/deletion/
 * addition lines with the +/-/space PREFIX omitted, exactly as the server's
 * parser emits). Returns `[]` when the two are identical. Hunks are ordered and
 * non-overlapping, each padded with up to `contextLines` unchanged lines and
 * merged when they would otherwise abut.
 */
export function computeHunks(original: string, proposed: string, contextLines = DEFAULT_CONTEXT_LINES): DiffHunk[] {
  if (original === proposed) return []
  const a = toLines(original)
  const b = toLines(proposed)
  if (a.length + b.length > MAX_DIFF_LINES) return [wholeFileReplaceHunk(a, b)]

  const ops = diffLines(a, b)
  const changed = ops.map((o) => o.op !== 'eq')

  // Expand each changed op by `contextLines` in both directions, then merge
  // overlapping/abutting ranges into hunk op-ranges [start, end).
  const ranges: Array<[number, number]> = []
  for (let k = 0; k < ops.length; k++) {
    if (!changed[k]) continue
    const start = Math.max(0, k - contextLines)
    const end = Math.min(ops.length, k + contextLines + 1)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }

  return ranges.map(([start, end]) => {
    const slice = ops.slice(start, end)
    const first = slice[0]!
    const oldCount = slice.filter((o) => o.op !== 'ins').length
    const newCount = slice.filter((o) => o.op !== 'del').length
    // git convention: for a non-empty side the start is 1-indexed (0-indexed+1);
    // for a 0-count side it is the 0-indexed line the change sits AFTER.
    const oldStart = oldCount === 0 ? first.oldIndex : first.oldIndex + 1
    const newStart = newCount === 0 ? first.newIndex : first.newIndex + 1
    const lines: DiffHunkLine[] = slice.map((o) => ({
      type: o.op === 'eq' ? 'context' : o.op === 'del' ? 'deletion' : 'addition',
      content: o.content,
    }))
    return { header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, lines }
  })
}

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

  const orig = toLines(original)
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
