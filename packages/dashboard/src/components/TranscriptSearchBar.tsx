/**
 * TranscriptSearchBar — the in-session find bar overlaid on the dashboard
 * ChatView (#6788).
 *
 * A compact Cmd/Ctrl+F-style bar: a text input, an "N/M" match counter (or a
 * "No results" state), previous / next navigation, and a close button. It is
 * purely presentational — all match state lives in `useTranscriptSearch` and
 * the scroll-to-match wiring lives in ChatView. Keyboard: Enter → next,
 * Shift+Enter → previous, Escape → close (mirrors the browser find idiom and
 * the mobile app's search controls).
 */
import { useEffect, useRef } from 'react'

export interface TranscriptSearchBarProps {
  /** Current query text. */
  query: string
  /** 0-based index of the active match. */
  currentIndex: number
  /** Total number of matches. */
  matchCount: number
  /** Update the query. */
  onQueryChange: (q: string) => void
  /** Advance to the next match. */
  onNext: () => void
  /** Step to the previous match. */
  onPrev: () => void
  /** Close the find bar. */
  onClose: () => void
}

export function TranscriptSearchBar({
  query,
  currentIndex,
  matchCount,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
}: TranscriptSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus + select the field when the bar mounts (it mounts on open) so the
  // user can type immediately, and a re-summon over an existing query replaces it.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  const hasQuery = query.trim().length > 0
  const hasMatches = matchCount > 0

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!hasMatches) return
      if (e.shiftKey) onPrev()
      else onNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Keep the Escape scoped to the find bar so it doesn't bubble up to
      // modal/overlay Escape handlers.
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      className="transcript-search"
      data-testid="transcript-search-bar"
      role="search"
    >
      <input
        ref={inputRef}
        type="text"
        className="transcript-search-input"
        data-testid="transcript-search-input"
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span
        className="transcript-search-count"
        data-testid="transcript-search-count"
        aria-live="polite"
      >
        {!hasQuery ? '' : hasMatches ? `${currentIndex + 1}/${matchCount}` : 'No results'}
      </span>
      <div className="transcript-search-nav">
        <button
          type="button"
          className="transcript-search-btn"
          data-testid="transcript-search-prev"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={!hasMatches}
          onClick={onPrev}
        >
          ↑
        </button>
        <button
          type="button"
          className="transcript-search-btn"
          data-testid="transcript-search-next"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={!hasMatches}
          onClick={onNext}
        >
          ↓
        </button>
        <button
          type="button"
          className="transcript-search-btn transcript-search-close"
          data-testid="transcript-search-close"
          aria-label="Close find"
          title="Close (Escape)"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
