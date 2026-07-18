/**
 * useTranscriptSearch — in-session find state for the dashboard ChatView (#6788).
 *
 * Owns the find bar's open/query/active-match state and derives the ordered
 * match list from the pure `computeTranscriptMatches` helper. React-free match
 * logic lives in `../lib/transcriptSearch`; this hook is only the state shell
 * (mirrors the mobile SessionScreen search state, lifted into a hook so the
 * dashboard ChatView stays lean and the behaviour is testable in isolation).
 */
import { useState, useCallback, useMemo, useEffect } from 'react'
import {
  computeTranscriptMatches,
  stepMatchIndex,
  type SearchableRow,
} from '../lib/transcriptSearch'

export interface UseTranscriptSearchResult {
  /** Whether the find bar is showing. */
  open: boolean
  /** Current query text. */
  query: string
  /** Update the query (resets the active match to the first hit). */
  setQuery: (q: string) => void
  /** Ordered ids of matching rows. */
  matchIds: string[]
  /** Set form of `matchIds` for O(1) per-row highlight checks. */
  matchIdSet: ReadonlySet<string>
  /** Number of matches for the "N/M" counter. */
  matchCount: number
  /** 0-based index of the active match within `matchIds`. */
  currentIndex: number
  /** Id of the active match row, or null when there are none. */
  currentMatchId: string | null
  /** Advance to the next match (wraps). */
  next: () => void
  /** Step to the previous match (wraps). */
  prev: () => void
  /** Show the find bar. */
  openSearch: () => void
  /** Hide the find bar and clear the query + active match. */
  closeSearch: () => void
}

export function useTranscriptSearch(
  rows: ReadonlyArray<SearchableRow>,
): UseTranscriptSearchResult {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [currentIndex, setCurrentIndex] = useState(0)

  const matchIds = useMemo(
    () => computeTranscriptMatches(rows, query),
    [rows, query],
  )
  const matchIdSet = useMemo(() => new Set(matchIds), [matchIds])

  // Reset the active match to the first hit whenever the query changes.
  // Keyed on the query string (not the match count) so an equal-count query
  // change still resets — the same guard mobile uses (#6788 parity).
  useEffect(() => {
    setCurrentIndex(0)
  }, [query])

  // Clamp the active index if the match list shrinks under it — the transcript
  // can grow/shrink while a query is live (streaming appends, a tool group
  // collapsing), which would otherwise leave `currentIndex` pointing past the
  // end.
  useEffect(() => {
    if (currentIndex > 0 && currentIndex >= matchIds.length) {
      setCurrentIndex(matchIds.length > 0 ? matchIds.length - 1 : 0)
    }
  }, [matchIds.length, currentIndex])

  const currentMatchId =
    matchIds.length > 0 ? matchIds[currentIndex] ?? null : null

  const next = useCallback(() => {
    setCurrentIndex((i) => stepMatchIndex(i, matchIds.length, 1))
  }, [matchIds.length])

  const prev = useCallback(() => {
    setCurrentIndex((i) => stepMatchIndex(i, matchIds.length, -1))
  }, [matchIds.length])

  const openSearch = useCallback(() => setOpen(true), [])

  const closeSearch = useCallback(() => {
    setOpen(false)
    setQuery('')
    setCurrentIndex(0)
  }, [])

  return {
    open,
    query,
    setQuery,
    matchIds,
    matchIdSet,
    matchCount: matchIds.length,
    currentIndex,
    currentMatchId,
    next,
    prev,
    openSearch,
    closeSearch,
  }
}
