import { useState, useCallback, useRef, useEffect } from 'react'
import type { SearchResult } from '../store/types'

export interface ConversationSearchProps {
  searchResults: SearchResult[]
  searchLoading: boolean
  searchQuery: string
  searchConversations: (query: string) => void
  clearSearchResults: () => void
  onResumeSession: (conversationId: string, cwd: string) => void
}

const DEBOUNCE_MS = 300

export function ConversationSearch({
  searchResults,
  searchLoading,
  searchQuery,
  searchConversations,
  clearSearchResults,
  onResumeSession,
}: ConversationSearchProps) {
  const [inputValue, setInputValue] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const hasQuery = searchQuery.length > 0
  const showNoResults = hasQuery && !searchLoading && searchResults.length === 0

  return (
    <div className="conversation-search">
      <input
        type="text"
        className="conversation-search-input"
        placeholder="Search conversations..."
        value={inputValue}
        onChange={handleChange}
      />

      {searchLoading && (
        <div className="conversation-search-status">Searching...</div>
      )}

      {showNoResults && (
        <div className="conversation-search-status">No results found</div>
      )}

      {searchResults.length > 0 && (
        <ul className="conversation-search-results">
          {searchResults.map(result => (
            <li
              key={result.conversationId}
              className="conversation-search-result"
              role="button"
              tabIndex={0}
              onClick={() => onResumeSession(result.conversationId, result.cwd ?? '')}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onResumeSession(result.conversationId, result.cwd ?? '')
                }
              }}
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
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
