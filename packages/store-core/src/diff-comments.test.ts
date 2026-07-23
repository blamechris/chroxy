/**
 * Tests for the diff line-comment → prompt composition helpers (#6800).
 *
 * Both clients (dashboard `DiffViewerPanel` + mobile `DiffViewer`) call these to
 * turn inline line comments / a review request into the user turn sent over the
 * `input` wire path. The tests double as the contract that keeps the two
 * clients' prompts identical.
 */
import { describe, it, expect } from 'vitest'
import type { DiffHunk } from './types/git'
import {
  parseHunkStartLines,
  deriveLineNumber,
  composeCommentReviewPrompt,
  composeReviewRequestPrompt,
  type DiffLineComment,
} from './diff-comments'

const HUNK: DiffHunk = {
  header: '@@ -10,6 +10,9 @@',
  lines: [
    { type: 'context', content: 'const x = 1' }, // new 10 / old 10
    { type: 'deletion', content: 'const y = 2' }, // old 11
    { type: 'addition', content: 'const y = 3' }, // new 11
    { type: 'addition', content: 'const z = 4' }, // new 12
    { type: 'context', content: 'export { x }' }, // new 13
  ],
}

function comment(over: Partial<DiffLineComment>): DiffLineComment {
  return {
    id: over.id ?? 'a#0#0',
    filePath: over.filePath ?? 'src/foo.ts',
    lineNumber: 'lineNumber' in over ? (over.lineNumber ?? null) : 10,
    lineType: over.lineType ?? 'addition',
    lineContent: over.lineContent ?? 'const x = 1',
    comment: over.comment ?? 'fix this',
  }
}

describe('parseHunkStartLines', () => {
  it('parses old and new start lines', () => {
    expect(parseHunkStartLines('@@ -10,6 +10,9 @@')).toEqual({ oldStart: 10, newStart: 10 })
  })

  it('parses single-count headers (no comma)', () => {
    expect(parseHunkStartLines('@@ -0,0 +1 @@')).toEqual({ oldStart: 0, newStart: 1 })
  })

  it('tolerates a trailing section heading', () => {
    expect(parseHunkStartLines('@@ -5,3 +7,4 @@ function foo() {')).toEqual({
      oldStart: 5,
      newStart: 7,
    })
  })

  it('returns null for a malformed header', () => {
    expect(parseHunkStartLines('not a hunk header')).toBeNull()
  })
})

describe('deriveLineNumber', () => {
  it('maps context/addition lines to their new-file line number', () => {
    expect(deriveLineNumber(HUNK, 0)).toBe(10) // context
    expect(deriveLineNumber(HUNK, 2)).toBe(11) // first addition
    expect(deriveLineNumber(HUNK, 3)).toBe(12) // second addition
    expect(deriveLineNumber(HUNK, 4)).toBe(13) // trailing context
  })

  it('maps deletion lines to their old-file line number', () => {
    expect(deriveLineNumber(HUNK, 1)).toBe(11) // deletion
  })

  it('returns null for an out-of-range index', () => {
    expect(deriveLineNumber(HUNK, 99)).toBeNull()
  })

  it('returns null when the header is unparseable', () => {
    expect(deriveLineNumber({ header: 'bad', lines: HUNK.lines }, 0)).toBeNull()
  })
})

describe('composeCommentReviewPrompt', () => {
  it('returns empty string for no comments', () => {
    expect(composeCommentReviewPrompt([])).toBe('')
  })

  it('drops whitespace-only comments', () => {
    expect(composeCommentReviewPrompt([comment({ comment: '   ' })])).toBe('')
  })

  it('composes a single comment with a line number and snippet', () => {
    const prompt = composeCommentReviewPrompt([
      comment({
        filePath: 'src/foo.ts',
        lineNumber: 42,
        lineType: 'addition',
        lineContent: '  const value = compute()',
        comment: 'handle the null case',
      }),
    ])
    expect(prompt).toContain('1 review comment on the current uncommitted changes')
    expect(prompt).toContain('src/foo.ts:')
    expect(prompt).toContain('- Line 42 (`const value = compute()`): handle the null case')
  })

  it('pluralizes the count and groups by file, ordered by line number', () => {
    const prompt = composeCommentReviewPrompt([
      comment({ id: 'b', filePath: 'src/b.ts', lineNumber: 20, comment: 'second file' }),
      comment({ id: 'a2', filePath: 'src/a.ts', lineNumber: 30, comment: 'later line' }),
      comment({ id: 'a1', filePath: 'src/a.ts', lineNumber: 5, comment: 'earlier line' }),
    ])
    expect(prompt).toContain('3 review comments')
    // first-seen file order: src/b.ts before src/a.ts
    expect(prompt.indexOf('src/b.ts:')).toBeLessThan(prompt.indexOf('src/a.ts:'))
    // within src/a.ts, line 5 sorts before line 30
    expect(prompt.indexOf('earlier line')).toBeLessThan(prompt.indexOf('later line'))
  })

  it('labels deletion lines as removed', () => {
    const prompt = composeCommentReviewPrompt([
      comment({ lineNumber: 12, lineType: 'deletion', lineContent: 'old()', comment: 'why removed?' }),
    ])
    expect(prompt).toContain('- Removed line 12 (`old()`): why removed?')
  })

  it('omits the number when line number is null', () => {
    const prompt = composeCommentReviewPrompt([
      comment({ lineNumber: null, lineType: 'context', lineContent: 'ctx', comment: 'note' }),
    ])
    expect(prompt).toContain('- Line (`ctx`): note')
  })

  it('truncates an overlong line snippet', () => {
    const long = 'x'.repeat(500)
    const prompt = composeCommentReviewPrompt([comment({ lineContent: long, comment: 'c' })])
    expect(prompt).toContain('…')
    expect(prompt.length).toBeLessThan(long.length + 200)
  })

  it('uses a wider backtick fence when the snippet itself contains backticks', () => {
    const prompt = composeCommentReviewPrompt([
      comment({
        lineNumber: 7,
        lineType: 'addition',
        lineContent: 'const msg = `hello ${name}`',
        comment: 'avoid the template literal here',
      }),
    ])
    // A single backtick fence would prematurely close on the snippet's own
    // backticks and corrupt the prompt; the fence must widen to `` and pad.
    expect(prompt).toContain('`` const msg = `hello ${name}` ``')
    expect(prompt).toContain(': avoid the template literal here')
  })
})

describe('composeReviewRequestPrompt', () => {
  it('returns a bare review request with no files', () => {
    const prompt = composeReviewRequestPrompt()
    expect(prompt).toContain('Please review the current uncommitted changes')
    expect(prompt).not.toContain('Changed files:')
  })

  it('lists changed file paths when provided', () => {
    const prompt = composeReviewRequestPrompt([{ path: 'src/a.ts' }, { path: 'src/b.ts' }])
    expect(prompt).toContain('Changed files:')
    expect(prompt).toContain('- src/a.ts')
    expect(prompt).toContain('- src/b.ts')
  })

  it('ignores empty paths', () => {
    expect(composeReviewRequestPrompt([{ path: '' }])).not.toContain('Changed files:')
  })
})
