/**
 * Unit tests for the pure transcript-search helpers (#6788).
 *
 * These pin the match semantics the mobile app already ships (case-insensitive
 * substring, document order, thinking excluded) and the wrap-around navigation,
 * independent of React and the virtualized ChatView.
 */
import { describe, it, expect } from 'vitest'
import {
  computeTranscriptMatches,
  extractRowSearchText,
  stepMatchIndex,
  type SearchableRow,
  type SearchTextSourceMessage,
} from './transcriptSearch'

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

describe('extractRowSearchText', () => {
  const NO_GROUPS = new Map<string, { messages: SearchTextSourceMessage[] }>()
  const NO_STORE = new Map<string, SearchTextSourceMessage>()

  it('includes a singleton tool row result from the store message (#6811 review Major)', () => {
    // The common shape: assistant → ONE tool → assistant. The tool's stdout
    // lives on the store message's toolResult, NOT in the row's content.
    const storeMsgMap = new Map<string, SearchTextSourceMessage>([
      ['t1', { content: 'Bash: npm test', toolResult: '742 passing needle-in-stdout' }],
    ])
    const row = { id: 't1', type: 'tool_use', content: 'Bash: npm test' }

    // Precondition the fix exists for: the needle is absent from content alone.
    expect(row.content.includes('needle-in-stdout')).toBe(false)

    const text = extractRowSearchText(row, NO_GROUPS, storeMsgMap)
    expect(text).toContain('needle-in-stdout')
    expect(text).toContain('Bash: npm test')

    // End-to-end with the matcher: the singleton tool's result text matches…
    const withResult: SearchableRow[] = [{ id: 't1', type: 'tool_use', text }]
    expect(computeTranscriptMatches(withResult, 'needle-in-stdout')).toEqual(['t1'])
    // …while matching content alone (the pre-fix behaviour) finds nothing.
    const contentOnly: SearchableRow[] = [{ id: 't1', type: 'tool_use', text: row.content }]
    expect(computeTranscriptMatches(contentOnly, 'needle-in-stdout')).toEqual([])
  })

  it('falls back to the row content when a singleton tool has no result yet', () => {
    // In-flight tool (no toolResult), or a row missing from the store map.
    const storeMsgMap = new Map<string, SearchTextSourceMessage>([
      ['t1', { content: 'Bash: sleep 5' }],
    ])
    expect(
      extractRowSearchText({ id: 't1', type: 'tool_use', content: 'Bash: sleep 5' }, NO_GROUPS, storeMsgMap),
    ).toBe('Bash: sleep 5')
    expect(
      extractRowSearchText({ id: 'missing', type: 'tool_use', content: 'Read foo.ts' }, NO_GROUPS, NO_STORE),
    ).toBe('Read foo.ts')
  })

  it('joins inner tool summaries + results for a collapsed tool_group', () => {
    const groups = new Map<string, { messages: SearchTextSourceMessage[] }>([
      ['activity-a', {
        messages: [
          { content: 'Read src/a.ts', toolResult: 'const alpha = 1' },
          { content: 'Grep beta', toolResult: 'src/b.ts: beta-hit' },
        ],
      }],
    ])
    const text = extractRowSearchText(
      { id: 'activity-a', type: 'tool_group', content: '' },
      groups,
      NO_STORE,
    )
    expect(text).toContain('Read src/a.ts')
    expect(text).toContain('const alpha = 1')
    expect(text).toContain('beta-hit')
  })

  it('falls back to row content for a tool_group with no payload', () => {
    expect(
      extractRowSearchText({ id: 'activity-x', type: 'tool_group', content: '' }, NO_GROUPS, NO_STORE),
    ).toBe('')
  })

  it('returns plain content for non-tool rows', () => {
    expect(
      extractRowSearchText({ id: 'r1', type: 'response', content: 'hello world' }, NO_GROUPS, NO_STORE),
    ).toBe('hello world')
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
