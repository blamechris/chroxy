/**
 * Diff line-comment → prompt composition (#6800).
 *
 * Pure, client-agnostic helpers shared by the dashboard `DiffViewerPanel` and
 * the mobile `DiffViewer`. They turn a set of inline line comments (or a bare
 * "review this diff" request) into the plain-text user turn that gets sent to
 * the agent over the normal `input` wire path — no new WS message type, no
 * server-side relay. Keeping the composition here means both clients produce
 * byte-identical prompts and the logic is unit-testable without a DOM.
 */
import type { DiffHunk, DiffHunkLine } from './types/git'

/**
 * A single pending inline comment attached to one diff line.
 *
 * `id` is a stable, position-derived key the UI uses to dedup/replace a comment
 * on the same line — the prompt formatter ignores it. `lineNumber` is the
 * 1-based line number in the relevant file (new file for additions/context,
 * old file for deletions) or `null` when the hunk header can't be parsed.
 */
export interface DiffLineComment {
  id: string
  filePath: string
  lineNumber: number | null
  lineType: DiffHunkLine['type']
  lineContent: string
  comment: string
}

/** Cap a line snippet so one pathological line can't blow up the prompt. */
const MAX_LINE_SNIPPET = 160

/**
 * Parse the `@@ -oldStart,oldCount +newStart,newCount @@` header into the two
 * 1-based starting line numbers. Returns `null` for a malformed header.
 */
export function parseHunkStartLines(
  header: string,
): { oldStart: number; newStart: number } | null {
  const m = /@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/.exec(header)
  if (!m) return null
  return { oldStart: Number(m[1]), newStart: Number(m[2]) }
}

/**
 * Derive the 1-based line number for `hunk.lines[lineIndex]`.
 *
 * Additions and context lines resolve to their new-file line number; deletions
 * resolve to their old-file line number (they don't exist in the new file).
 * Returns `null` if the header can't be parsed or the index is out of range.
 */
export function deriveLineNumber(hunk: DiffHunk, lineIndex: number): number | null {
  const starts = parseHunkStartLines(hunk.header)
  if (!starts) return null
  const target = hunk.lines[lineIndex]
  if (!target) return null
  let oldLine = starts.oldStart
  let newLine = starts.newStart
  for (let i = 0; i < lineIndex; i++) {
    const t = hunk.lines[i]!.type
    if (t === 'deletion') oldLine++
    else if (t === 'addition') newLine++
    else {
      oldLine++
      newLine++
    }
  }
  return target.type === 'deletion' ? oldLine : newLine
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function locatorFor(comment: DiffLineComment): string {
  const removed = comment.lineType === 'deletion'
  if (comment.lineNumber == null) return removed ? 'Removed line' : 'Line'
  return removed ? `Removed line ${comment.lineNumber}` : `Line ${comment.lineNumber}`
}

/**
 * Compose the user turn that asks the agent to address a set of inline line
 * comments on the current uncommitted changes. Comments are grouped by file (in
 * first-seen order) and, within a file, ordered by line number ascending
 * (null line numbers last). Empty/whitespace-only comments are dropped; returns
 * `''` when nothing actionable remains (callers guard the submit action on a
 * non-empty prompt).
 */
export function composeCommentReviewPrompt(comments: DiffLineComment[]): string {
  const valid = comments.filter((c) => c.comment.trim().length > 0)
  if (valid.length === 0) return ''

  const byFile = new Map<string, DiffLineComment[]>()
  for (const c of valid) {
    const list = byFile.get(c.filePath)
    if (list) list.push(c)
    else byFile.set(c.filePath, [c])
  }

  const count = valid.length
  const out: string[] = [
    `Please address the following ${count} review comment${count === 1 ? '' : 's'} on the current uncommitted changes. Each references a specific file and line.`,
  ]

  for (const [filePath, fileComments] of byFile) {
    out.push('')
    out.push(`${filePath}:`)
    const sorted = [...fileComments].sort((a, b) => {
      if (a.lineNumber == null) return b.lineNumber == null ? 0 : 1
      if (b.lineNumber == null) return -1
      return a.lineNumber - b.lineNumber
    })
    for (const c of sorted) {
      const snippet = truncate(c.lineContent.trim(), MAX_LINE_SNIPPET)
      out.push(`  - ${locatorFor(c)} (\`${snippet}\`): ${c.comment.trim()}`)
    }
  }

  return out.join('\n')
}

/**
 * Compose the one-click "Review code" user turn over the whole uncommitted
 * diff. When `files` is provided the changed paths are listed so the agent can
 * scope its pass; otherwise a bare review request is returned.
 */
export function composeReviewRequestPrompt(
  files: readonly { path: string }[] = [],
): string {
  const base =
    'Please review the current uncommitted changes in this repository. Look for correctness bugs, missed edge cases, security issues, and style problems, and propose or make fixes as appropriate.'
  const paths = files.map((f) => f.path).filter((p) => p.length > 0)
  if (paths.length === 0) return base
  return `${base}\n\nChanged files:\n${paths.map((p) => `- ${p}`).join('\n')}`
}
