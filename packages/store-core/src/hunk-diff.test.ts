/**
 * hunk-diff tests (#6542, IDE P3.1) — the client-side line differ + per-hunk
 * apply. The round-trip invariants (apply-all === proposed, apply-none ===
 * original) are the load-bearing correctness proof; the rest pins hunk shape,
 * subset application, edge cases, and the size guard.
 */
import { describe, it, expect } from 'vitest'
import { computeHunks, applyHunks, MAX_DIFF_LINES } from './hunk-diff'

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
