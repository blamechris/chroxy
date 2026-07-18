/**
 * useTranscriptSearch — hook-level tests (#6788 / #6811 review).
 *
 * Pins the stable-empty-reference contract: when the query is blank (the
 * steady state for every session that opened find and closed it, and for the
 * bar sitting open with no text) or when nothing matches, `matchIds` and
 * `matchIdSet` must keep the SAME references across `rows` changes — the rows
 * churn on every streaming flush, and fresh [] / new Set() allocations per
 * render would defeat downstream identity-based memos.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTranscriptSearch } from './useTranscriptSearch'
import type { SearchableRow } from '../lib/transcriptSearch'

function rowsOf(count: number): SearchableRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `r${i}`,
    type: 'response',
    text: `row ${i}`,
  }))
}

describe('useTranscriptSearch stable empty references (#6811 review)', () => {
  it('keeps matchIds / matchIdSet identities across rows changes while the query is blank', () => {
    const { result, rerender } = renderHook(
      ({ rows }: { rows: SearchableRow[] }) => useTranscriptSearch(rows),
      { initialProps: { rows: rowsOf(3) } },
    )
    const ids1 = result.current.matchIds
    const set1 = result.current.matchIdSet
    expect(ids1).toEqual([])
    expect(set1.size).toBe(0)

    // Streaming appends new rows — the blank-query empties must not churn.
    rerender({ rows: rowsOf(4) })
    expect(result.current.matchIds).toBe(ids1)
    expect(result.current.matchIdSet).toBe(set1)

    rerender({ rows: rowsOf(50) })
    expect(result.current.matchIds).toBe(ids1)
    expect(result.current.matchIdSet).toBe(set1)
  })

  it('keeps stable empty identities across rows changes for a no-match query', () => {
    const { result, rerender } = renderHook(
      ({ rows }: { rows: SearchableRow[] }) => useTranscriptSearch(rows),
      { initialProps: { rows: rowsOf(3) } },
    )
    act(() => result.current.setQuery('zzz-no-hit'))
    const ids1 = result.current.matchIds
    const set1 = result.current.matchIdSet
    expect(ids1).toEqual([])

    rerender({ rows: rowsOf(4) })
    expect(result.current.matchIds).toBe(ids1)
    expect(result.current.matchIdSet).toBe(set1)
  })

  it('shares one frozen empty across the blank and no-match cases', () => {
    const { result } = renderHook(
      ({ rows }: { rows: SearchableRow[] }) => useTranscriptSearch(rows),
      { initialProps: { rows: rowsOf(3) } },
    )
    const blankIds = result.current.matchIds
    act(() => result.current.setQuery('zzz-no-hit'))
    expect(result.current.matchIds).toBe(blankIds)
    expect(Object.isFrozen(blankIds)).toBe(true)
  })

  it('still produces real (non-empty) matches when the query hits', () => {
    const { result } = renderHook(
      ({ rows }: { rows: SearchableRow[] }) => useTranscriptSearch(rows),
      { initialProps: { rows: rowsOf(3) } },
    )
    act(() => result.current.setQuery('row 1'))
    expect(result.current.matchIds).toEqual(['r1'])
    expect(result.current.matchIdSet.has('r1')).toBe(true)
    expect(result.current.currentMatchId).toBe('r1')
  })
})
