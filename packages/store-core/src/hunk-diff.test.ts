/**
 * hunk-diff tests (#6542, IDE P3.1) — the client-side line differ + per-hunk
 * apply. The round-trip invariants (apply-all === proposed, apply-none ===
 * original) are the load-bearing correctness proof; the rest pins hunk shape,
 * subset application, edge cases, and the size guard.
 */
import { describe, it, expect } from 'vitest'
import { computeHunks, applyHunks, hunkDecisions, MAX_DIFF_LINES } from './hunk-diff'

/** Assert the two round-trip invariants for a case. */
function assertRoundTrip(original: string, proposed: string) {
  const hunks = computeHunks(original, proposed)
  expect(applyHunks(original, hunks, () => true)).toBe(proposed)
  expect(applyHunks(original, hunks, () => false)).toBe(original)
}

describe('computeHunks (#6542)', () => {
  it('returns no hunks when content is identical', () => {
    expect(computeHunks('a\nb\nc', 'a\nb\nc')).toEqual([])
    expect(computeHunks('', '')).toEqual([])
  })

  it('produces a git-style header + prefix-free lines for a modification', () => {
    const hunks = computeHunks('a\nb\nc', 'a\nB\nc')
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
    const types = hunks[0]!.lines.map((l) => l.type)
    expect(types).toContain('deletion')
    expect(types).toContain('addition')
    // content carries NO +/-/space prefix (the renderer adds it)
    const del = hunks[0]!.lines.find((l) => l.type === 'deletion')!
    expect(del.content).toBe('b')
  })

  it('splits distant changes into separate hunks, merges near ones', () => {
    const original = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    const far = original.split('\n')
    far[2] = 'CHANGED-2'
    far[25] = 'CHANGED-25'
    expect(computeHunks(original, far.join('\n'))).toHaveLength(2) // far apart → 2 hunks

    const near = original.split('\n')
    near[10] = 'CHANGED-10'
    near[12] = 'CHANGED-12'
    expect(computeHunks(original, near.join('\n'))).toHaveLength(1) // within 2·context → merged
  })

  it('handles pure addition, pure deletion, insert-at-start, insert-at-end', () => {
    assertRoundTrip('a\nb\nc', 'a\nb\nc\nd\ne')       // append
    assertRoundTrip('a\nb\nc', 'a\nc')                 // delete middle
    assertRoundTrip('b\nc', 'a\nb\nc')                 // insert at start
    assertRoundTrip('a\nb', 'a\nb\nc')                 // insert at end
    assertRoundTrip('', 'x')                            // empty → content
    assertRoundTrip('x', '')                            // content → empty
    assertRoundTrip('a\nb\nc', 'x\ny\nz')               // whole-file replace (no common lines)
  })

  it('preserves a trailing newline losslessly (round-trip)', () => {
    assertRoundTrip('a\nb\n', 'a\nB\n')
    assertRoundTrip('a\nb', 'a\nb\n')  // adding a trailing newline
  })

  it('emits git-style empty-side headers (new file / deleted file), no phantom line', () => {
    // new file: pure addition, 0-based old start, no phantom '' deletion
    const created = computeHunks('', 'x\ny')
    expect(created).toHaveLength(1)
    expect(created[0]!.header).toBe('@@ -0,0 +1,2 @@')
    expect(created[0]!.lines.map((l) => l.type)).toEqual(['addition', 'addition'])
    // deleted file: pure deletion, 0-based new start
    const deleted = computeHunks('x\ny', '')
    expect(deleted[0]!.header).toBe('@@ -1,2 +0,0 @@')
    expect(deleted[0]!.lines.map((l) => l.type)).toEqual(['deletion', 'deletion'])
    // and both still round-trip
    assertRoundTrip('', 'x\ny')
    assertRoundTrip('x\ny', '')
  })

  it('round-trips CRLF content without mangling line endings', () => {
    assertRoundTrip('a\r\nb\r\nc', 'a\r\nB\r\nc')
    assertRoundTrip('a\r\nb\r\n', 'a\r\nb\r\nc\r\n')
    // a lone \r stays attached to its line's content (split is on \n only)
    const hunks = computeHunks('a\r\nb', 'a\r\nB')
    expect(hunks[0]!.lines.find((l) => l.type === 'deletion')!.content).toBe('b')
    expect(hunks[0]!.lines.find((l) => l.type === 'addition')!.content).toBe('B')
  })

  it('round-trips a spread of realistic edits', () => {
    const cases: Array<[string, string]> = [
      ['const x = 1\nconst y = 2\n', 'const x = 1\nconst y = 3\nconst z = 4\n'],
      ['line1\nline2\nline3\nline4\nline5', 'line1\nline3\nline4\nline5\nline6'],
      ['a\na\na\na', 'a\nb\na\na'],            // repeated lines
      ['x', 'x\nx\nx'],                         // one → many identical
      ['keep\nremove1\nremove2\nkeep2', 'keep\nkeep2'],
    ]
    for (const [o, p] of cases) assertRoundTrip(o, p)
  })
})

describe('applyHunks subset selection (#6542)', () => {
  const original = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
  const editedArr = original.split('\n')
  editedArr[2] = 'A-CHANGED'
  editedArr[25] = 'B-CHANGED'
  const proposed = editedArr.join('\n')
  const hunks = computeHunks(original, proposed)

  it('applying only hunk 0 keeps hunk 1 region original', () => {
    const result = applyHunks(original, hunks, new Set([0])).split('\n')
    expect(result[2]).toBe('A-CHANGED')  // hunk 0 applied
    expect(result[25]).toBe('line25')    // hunk 1 rejected → original
  })

  it('applying only hunk 1 keeps hunk 0 region original', () => {
    const result = applyHunks(original, hunks, [1]).split('\n')
    expect(result[2]).toBe('line2')      // hunk 0 rejected
    expect(result[25]).toBe('B-CHANGED') // hunk 1 applied
  })

  it('accepts a Set, an array, or a predicate for selection', () => {
    expect(applyHunks(original, hunks, new Set([0, 1]))).toBe(proposed)
    expect(applyHunks(original, hunks, [0, 1])).toBe(proposed)
    expect(applyHunks(original, hunks, () => true)).toBe(proposed)
    expect(applyHunks(original, hunks, [])).toBe(original)
  })
})

describe('applyHunks robustness + size guard (#6542)', () => {
  it('an unparseable hunk header leaves its content untouched (never corrupts)', () => {
    const original = 'a\nb\nc'
    const hunks = computeHunks(original, 'a\nX\nc')
    const corrupt = [{ ...hunks[0]!, header: 'not-a-header' }]
    // malformed → the original is returned unchanged rather than dropping lines
    expect(applyHunks(original, corrupt, () => true)).toBe(original)
  })

  it('falls back to a single whole-file-replace hunk past MAX_DIFF_LINES', () => {
    const big = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `l${i}`).join('\n')
    const bigChanged = big + '\nextra'
    const hunks = computeHunks(big, bigChanged)
    expect(hunks).toHaveLength(1)
    // still round-trips through the fallback shape
    expect(applyHunks(big, hunks, () => true)).toBe(bigChanged)
    expect(applyHunks(big, hunks, () => false)).toBe(big)
  })
})

describe('hunkDecisions (#8446)', () => {
  // The same fixture is driven through the server's permission path in
  // packages/server/tests/edited-input-redaction.test.js, which hard-codes these
  // ranges: a change to the differ's output or to this helper fails here first.
  const SECRET = 'sk-' + 'Ab12'.repeat(12)
  const oldLines = Array.from({ length: 30 }, (_, i) => `line${String(i).padStart(2, '0')}`)
  oldLines[12] = `const apiKey = "${SECRET}"`
  const newLines = [...oldLines]
  newLines[1] = 'line01 CHANGED'
  newLines[27] = 'line27 CHANGED'
  // What the reviewing client holds: the REDACTED copy of the tool input.
  const redact = (s: string) => s.replace(SECRET, '[REDACTED]')
  const hunks = computeHunks(oldLines.map(redact).join('\n'), newLines.map(redact).join('\n'))
  const A = { oldStart: 1, oldCount: 5, newStart: 1, newCount: 5 }
  const B = { oldStart: 25, oldCount: 6, newStart: 25, newCount: 6 }

  it('splits EVERY hunk into dropped and kept by the operator\'s choice', () => {
    expect(hunks.map((h) => h.header)).toEqual(['@@ -1,5 +1,5 @@', '@@ -25,6 +25,6 @@'])
    expect(hunkDecisions(hunks, new Set([0]))).toEqual({ droppedHunks: [B], keptHunks: [A] })
    expect(hunkDecisions(hunks, new Set([1]))).toEqual({ droppedHunks: [A], keptHunks: [B] })
    expect(hunkDecisions(hunks, [0, 1])).toEqual({ droppedHunks: [], keptHunks: [A, B] })
    expect(hunkDecisions(hunks, new Set())).toEqual({ droppedHunks: [A, B], keptHunks: [] })
  })

  it('hunks that change the line count: the new-side ranges are not the old-side ranges', () => {
    // 1 line -> 3 at the top, one line deleted near the end. Mirrored by the
    // "line count" cases in the server test.
    const grown = [...oldLines]
    grown.splice(27, 1)
    grown.splice(1, 1, 'line01 CHANGED', 'extra1', 'extra2')
    const h = computeHunks(oldLines.map(redact).join('\n'), grown.map(redact).join('\n'))
    expect(h.map((x) => x.header)).toEqual(['@@ -1,5 +1,7 @@', '@@ -25,6 +27,5 @@'])
    expect(hunkDecisions(h, new Set()).droppedHunks).toEqual([
      { oldStart: 1, oldCount: 5, newStart: 1, newCount: 7 },
      { oldStart: 25, oldCount: 6, newStart: 27, newCount: 5 },
    ])
  })

  it('a new file is one hunk whose old side is empty', () => {
    const h = computeHunks('', 'a\nb\nc')
    expect(hunkDecisions(h, new Set())).toEqual({
      droppedHunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 }],
      keptHunks: [],
    })
  })

  it('never carries text: only numbers leave the client', () => {
    const json = JSON.stringify(hunkDecisions(hunks, new Set([0])))
    expect(json.includes('line') || json.includes('REDACTED')).toBe(false)
  })
})
