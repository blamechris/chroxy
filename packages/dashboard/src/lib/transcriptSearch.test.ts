/**
 * Unit tests for the pure transcript-search helpers (#6788).
 *
 * These pin the match semantics the mobile app already ships (case-insensitive
 * substring, document order, thinking excluded) and the wrap-around navigation,
 * independent of React and the virtualized ChatView.
 */
import { describe, it, expect } from 'vitest'
import { computeTranscriptMatches, stepMatchIndex, type SearchableRow } from './transcriptSearch'

const rows: SearchableRow[] = [
  { id: 'a', type: 'user_input', text: 'Please refactor the Auth module' },
  { id: 'b', type: 'response', text: 'Sure — I updated the authentication flow' },
  { id: 'c', type: 'thinking', text: 'the user wants auth changes' },
  { id: 'd', type: 'tool_use', text: 'Read src/auth.ts' },
  { id: 'e', type: 'response', text: 'Done. No auth left to touch.' },
]

describe('computeTranscriptMatches', () => {
  it('returns [] for a blank query', () => {
    expect(computeTranscriptMatches(rows, '')).toEqual([])
  })

  it('returns [] for a whitespace-only query', () => {
    expect(computeTranscriptMatches(rows, '   ')).toEqual([])
  })

  it('matches case-insensitively', () => {
    // "auth" appears in a (Auth), b (authentication), d (auth.ts), e (auth).
    // c is a thinking row and is excluded even though it contains "auth".
    expect(computeTranscriptMatches(rows, 'AUTH')).toEqual(['a', 'b', 'd', 'e'])
  })

  it('matches an arbitrary substring, not just word boundaries', () => {
    expect(computeTranscriptMatches(rows, 'hentica')).toEqual(['b'])
  })

  it('preserves document order', () => {
    expect(computeTranscriptMatches(rows, 'o')).toEqual(['a', 'b', 'e'])
  })

  it('excludes thinking rows from matches', () => {
    // Only the thinking row contains "wants"; it must not match.
    expect(computeTranscriptMatches(rows, 'wants')).toEqual([])
  })

  it('returns [] when nothing matches', () => {
    expect(computeTranscriptMatches(rows, 'zzz-nope')).toEqual([])
  })

  it('trims surrounding whitespace before matching', () => {
    expect(computeTranscriptMatches(rows, '  refactor  ')).toEqual(['a'])
  })
})

describe('stepMatchIndex', () => {
  it('advances forward', () => {
    expect(stepMatchIndex(0, 3, 1)).toBe(1)
    expect(stepMatchIndex(1, 3, 1)).toBe(2)
  })

  it('wraps forward past the end back to 0', () => {
    expect(stepMatchIndex(2, 3, 1)).toBe(0)
  })

  it('steps backward', () => {
    expect(stepMatchIndex(2, 3, -1)).toBe(1)
  })

  it('wraps backward from 0 to the last index', () => {
    expect(stepMatchIndex(0, 3, -1)).toBe(2)
  })

  it('returns 0 for an empty list', () => {
    expect(stepMatchIndex(0, 0, 1)).toBe(0)
    expect(stepMatchIndex(0, 0, -1)).toBe(0)
  })

  it('stays at 0 for a single-match list', () => {
    expect(stepMatchIndex(0, 1, 1)).toBe(0)
    expect(stepMatchIndex(0, 1, -1)).toBe(0)
  })
})
