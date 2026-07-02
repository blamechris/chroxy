/**
 * ReferencesPalette — find-all-references result list (#6477, IDE epic #6469).
 *
 * Opened by alt/option+click on a token in the file viewer (FileBrowserPanel),
 * which dispatches `requestFindReferences` and flips `referencesOpen`. Unlike the
 * Cmd+Shift+F palette there's no query input — the symbol is fixed by the click;
 * this just lists the referencing sites (`references_result`). Enter / click jumps
 * to a site via `openFileInBrowser(file, line)`.
 *
 * Gated by the caller on the opt-in `ide` capability. Reuses the file-open-palette
 * chrome + the code-search preview row.
 */
import { useState, useEffect, useMemo, useRef, useCallback, type KeyboardEvent } from 'react'
import { useConnectionStore } from '../store/connection'
import type { SearchResultEntry } from '@chroxy/protocol'

export interface ReferencesPaletteProps {
  isOpen: boolean
  onClose: () => void
}

const DISPLAY_CAP = 200

export function ReferencesPalette({ isOpen, onClose }: ReferencesPaletteProps) {
  const snapshot = useConnectionStore(s => s.referencesResult)
  const loading = useConnectionStore(s => s.referencesLoading)
  const symbol = useConnectionStore(s => s.referencesSymbol)
  const openFileInBrowser = useConnectionStore(s => s.openFileInBrowser)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    setSelectedIndex(0)
    const id = window.setTimeout(() => listRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [isOpen])

  // Trust the stored result only when it's for the CURRENT symbol (a stale reply
  // for a previous click is ignored until the new one lands).
  const isCurrent = !!snapshot && snapshot.symbol === symbol
  const results = useMemo<SearchResultEntry[]>(() => (isCurrent ? snapshot!.results : []), [snapshot, isCurrent])

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
  const searching = loading || !isCurrent

  return (
    <div
      className="file-open-palette-overlay"
      data-modal-overlay
      data-testid="references-palette"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="file-open-palette" role="dialog" aria-label="References">
        <div className="file-open-palette-header" data-testid="references-header">
          References to <code>{symbol}</code>
          {isCurrent && !searching && <span className="references-count"> · {results.length}</span>}
        </div>
        <div
          ref={listRef}
          className="file-open-palette-list"
          role="listbox"
          aria-label="References"
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          {searching && <div className="file-open-palette-status">Searching…</div>}
          {!searching && results.length === 0 && (
            <div className="file-open-palette-status" data-testid="references-empty">No references found</div>
          )}
          {!searching && display.map((r, i) => (
            <div
              key={`${r.file}:${r.line}:${r.column}:${i}`}
              role="option"
              aria-selected={i === selectedIndex}
              className={`file-open-palette-item${i === selectedIndex ? ' selected' : ''}`}
              data-testid={`references-item-${i}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onMouseDown={(e) => { e.preventDefault(); openAt(i) }}
            >
              <span className="code-search-preview" title={r.text}>{r.text.trim() || ' '}</span>
              <span className="symbol-item-line">{r.file.split('/').pop()}:{r.line}</span>
            </div>
          ))}
          {overflow > 0 && <div className="file-open-palette-status">{overflow} more…</div>}
          {isCurrent && snapshot!.truncated && display.length > 0 && (
            <div className="file-open-palette-status" data-testid="references-truncated">Results truncated</div>
          )}
        </div>
      </div>
    </div>
  )
}
