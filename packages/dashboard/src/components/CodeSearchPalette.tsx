/**
 * CodeSearchPalette — Cmd+Shift+F find-in-project content grep (#6474, IDE epic
 * #6469).
 *
 * Unlike the symbol palette (#6476), the match can't happen client-side — the
 * browser has no file contents — so the query is sent to the server (debounced,
 * 2+ chars) via `requestSearchContent`, and the `code_search_results` reply lands in
 * `codeSearchResults`. Each row is a file:line match with the matched line as a
 * preview; Enter / click opens the file at that line via `openFileInBrowser`.
 *
 * Gated by the caller on the opt-in `ide` capability. Reuses the file-open-palette
 * chrome (CSS).
 */
import { useState, useEffect, useMemo, useRef, useCallback, type KeyboardEvent } from 'react'
import { useConnectionStore } from '../store/connection'
import type { SearchResultEntry } from '@chroxy/protocol'

export interface CodeSearchPaletteProps {
  isOpen: boolean
  onClose: () => void
}

const DISPLAY_CAP = 200
const DEBOUNCE_MS = 200
const MIN_QUERY = 2

export function CodeSearchPalette({ isOpen, onClose }: CodeSearchPaletteProps) {
  const requestSearchContent = useConnectionStore(s => s.requestSearchContent)
  const snapshot = useConnectionStore(s => s.codeSearchResults)
  const loading = useConnectionStore(s => s.codeSearchLoading)
  const openFileInBrowser = useConnectionStore(s => s.openFileInBrowser)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setSelectedIndex(0)
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [isOpen])

  // Debounced server-side search on query change (content grep can't run client-side).
  useEffect(() => {
    if (!isOpen) return
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    const q = query.trim()
    if (q.length < MIN_QUERY) return
    debounceRef.current = window.setTimeout(() => requestSearchContent(q), DEBOUNCE_MS)
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current) }
  }, [query, isOpen, requestSearchContent])

  const trimmed = query.trim()
  // Only trust the stored results if they're for the CURRENT query — the server
  // echoes `query`, so a reply for a stale (shorter) query is ignored while the
  // user keeps typing.
  const isCurrent = !!snapshot && snapshot.query === trimmed
  const results = useMemo<SearchResultEntry[]>(() => {
    if (trimmed.length < MIN_QUERY || !isCurrent) return []
    return snapshot!.results
  }, [snapshot, isCurrent, trimmed])

  useEffect(() => {
    setSelectedIndex(i => (results.length === 0 ? 0 : Math.min(i, Math.min(results.length, DISPLAY_CAP) - 1)))
  }, [results.length])

  useEffect(() => {
    const items = listRef.current?.querySelectorAll('[role="option"]')
    const el = items?.[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  const openAt = useCallback((idx: number) => {
    const r = results[idx]
    if (r) {
      openFileInBrowser(r.file, r.line)
      onClose()
    }
  }, [results, openFileInBrowser, onClose])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, Math.min(results.length, DISPLAY_CAP) - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); openAt(selectedIndex) }
  }, [results.length, selectedIndex, openAt, onClose])

  if (!isOpen) return null

  const overflow = results.length > DISPLAY_CAP ? results.length - DISPLAY_CAP : 0
  const display = overflow > 0 ? results.slice(0, DISPLAY_CAP) : results
  // "Searching…" while a query is in flight OR results haven't caught up to the
  // current query yet, so a stale set never renders as if it were fresh.
  const searching = trimmed.length >= MIN_QUERY && (loading || !isCurrent)

  return (
    <div
      className="file-open-palette-overlay"
      data-modal-overlay
      data-testid="code-search-palette"
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="file-open-palette" role="dialog" aria-label="Search in files">
        <input
          ref={inputRef}
          className="file-open-palette-input"
          type="text"
          placeholder="Search in files…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
          data-testid="code-search-input"
          aria-label="Search in files"
        />
        <div ref={listRef} className="file-open-palette-list" role="listbox" aria-label="Search results">
          {trimmed.length < MIN_QUERY && (
            <div className="file-open-palette-status" data-testid="code-search-hint">Type 2+ characters to search</div>
          )}
          {trimmed.length >= MIN_QUERY && searching && (
            <div className="file-open-palette-status">Searching…</div>
          )}
          {trimmed.length >= MIN_QUERY && !searching && results.length === 0 && (
            <div className="file-open-palette-status" data-testid="code-search-empty">No matches</div>
          )}
          {display.map((r, i) => (
            <div
              key={`${r.file}:${r.line}:${r.column}:${i}`}
              role="option"
              aria-selected={i === selectedIndex}
              className={`file-open-palette-item${i === selectedIndex ? ' selected' : ''}`}
              data-testid={`code-search-item-${i}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onMouseDown={(e) => { e.preventDefault(); openAt(i) }}
            >
              <span className="code-search-preview" title={r.text}>{r.text.trim() || ' '}</span>
              <span className="symbol-item-line">{r.file.split('/').pop()}:{r.line}</span>
            </div>
          ))}
          {overflow > 0 && <div className="file-open-palette-status">{overflow} more…</div>}
          {isCurrent && snapshot!.truncated && display.length > 0 && (
            <div className="file-open-palette-status" data-testid="code-search-truncated">Results truncated — refine your search</div>
          )}
        </div>
      </div>
    </div>
  )
}
