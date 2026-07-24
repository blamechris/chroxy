import { useState, useCallback, useRef, useEffect, useId } from 'react'
import type { SearchResult } from '../store/types'

export interface ConversationSearchProps {
  searchResults: SearchResult[]
  searchLoading: boolean
  searchQuery: string
  searchConversations: (query: string) => void
  clearSearchResults: () => void
  onResumeSession: (conversationId: string, cwd: string) => void
  /**
   * #6863 (epic #6765) — open a read-only transcript viewer for this
   * conversation instead of resuming it. NEVER calls `createSession` /
   * spawns a provider — reading is the entire contract, unlike
   * `onResumeSession`. Additive: the row's existing click/Enter → Resume
   * behavior is unchanged; View is only reachable via its own button.
   */
  onViewConversation: (conversationId: string, cwd: string) => void
}

const DEBOUNCE_MS = 300

export function ConversationSearch({
  searchResults,
  searchLoading,
  searchQuery,
  searchConversations,
  clearSearchResults,
  onResumeSession,
  onViewConversation,
}: ConversationSearchProps) {
  const [inputValue, setInputValue] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listboxId = useId()

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setInputValue(value)

    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = setTimeout(() => {
      const trimmed = value.trim()
      if (trimmed) {
        searchConversations(trimmed)
      } else {
        clearSearchResults()
      }
    }, DEBOUNCE_MS)
  }, [searchConversations, clearSearchResults])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && searchResults.length > 0) {
      e.preventDefault()
      const options = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')
      if (options && options.length > 0) options[0]!.focus()
    }
  }, [searchResults.length])

  const handleOptionKeyDown = useCallback((e: React.KeyboardEvent, index: number, result: SearchResult) => {
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const options = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')
        if (options && index + 1 < options.length) options[index + 1]!.focus()
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        if (index === 0) {
          inputRef.current?.focus()
        } else {
          const options = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')
          if (options) options[index - 1]!.focus()
        }
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        onResumeSession(result.conversationId, result.cwd ?? '')
        break
      }
    }
  }, [onResumeSession])

  const hasQuery = searchQuery.length > 0
  const showNoResults = hasQuery && !searchLoading && searchResults.length === 0

  return (
    <div className="conversation-search">
      <input
        ref={inputRef}
        type="text"
        className="conversation-search-input"
        placeholder="Search conversations..."
        value={inputValue}
        onChange={handleChange}
        onKeyDown={handleInputKeyDown}
        role="combobox"
        aria-expanded={searchResults.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
      />

      {searchLoading && (
        <div className="conversation-search-status">Searching...</div>
      )}

      {showNoResults && (
        <div className="conversation-search-status">No results found</div>
      )}

      {searchResults.length > 0 && (
        <ul className="conversation-search-results" role="listbox" id={listboxId} ref={listRef}>
          {searchResults.map((result, index) => (
            <li
              key={result.conversationId}
              className="conversation-search-result"
              role="option"
              tabIndex={-1}
              aria-selected={false}
              onClick={() => onResumeSession(result.conversationId, result.cwd ?? '')}
              onKeyDown={e => handleOptionKeyDown(e, index, result)}
            >
              <div className="conversation-search-result-title">
                {result.preview || 'Untitled conversation'}
              </div>
              <div className="conversation-search-result-snippet">
                {result.snippet}
              </div>
              <div className="conversation-search-result-meta">
                {result.projectName} &middot; {result.matchCount} match{result.matchCount !== 1 ? 'es' : ''}
              </div>
              {/* #6863 — View / Resume actions, additive alongside the row's
                  existing click/Enter → Resume behavior above. stopPropagation
                  on both so a button click doesn't ALSO fire the row's onClick
                  (which would double-dispatch a resume). */}
              <div className="conversation-search-result-actions">
                <button
                  type="button"
                  className="conversation-search-result-action conversation-search-result-action-view"
                  data-testid={`conversation-search-view-${result.conversationId}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onViewConversation(result.conversationId, result.cwd ?? '')
                  }}
                >
                  View
                </button>
                <button
                  type="button"
                  className="conversation-search-result-action conversation-search-result-action-resume"
                  data-testid={`conversation-search-resume-${result.conversationId}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onResumeSession(result.conversationId, result.cwd ?? '')
                  }}
                >
                  Resume
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
