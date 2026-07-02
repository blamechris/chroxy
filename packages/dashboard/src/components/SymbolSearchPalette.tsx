/**
 * SymbolSearchPalette — Cmd+Shift+O fuzzy symbol search (#6476, IDE epic #6469).
 *
 * Opening it requests the whole-workspace symbol table (a path-less `list_symbols`
 * scan, landing in `workspaceSymbols`); the input fuzzy-filters by symbol name and
 * Enter jumps to the symbol's file:line — `openFileInBrowser(file, line)` opens the
 * file in the viewer and scrolls to the line.
 *
 * Gated by the caller on the opt-in `ide` capability. Reuses the file-open-palette
 * chrome (CSS) + the symbol-item glyph/line styles.
 */
import { useState, useEffect, useMemo, useRef, useCallback, type KeyboardEvent } from 'react'
import { useConnectionStore } from '../store/connection'
import type { SymbolEntry } from '@chroxy/protocol'

export interface SymbolSearchPaletteProps {
  isOpen: boolean
  onClose: () => void
}

const DISPLAY_CAP = 200

const SYMBOL_KIND_ICON: Record<string, string> = {
  function: 'ƒ', method: 'ƒ', class: 'C', interface: 'I',
  type: 'T', enum: 'E', const: 'k', variable: 'v',
}

export function SymbolSearchPalette({ isOpen, onClose }: SymbolSearchPaletteProps) {
  const requestWorkspaceSymbols = useConnectionStore(s => s.requestWorkspaceSymbols)
  const snapshot = useConnectionStore(s => s.workspaceSymbols)
  const loading = useConnectionStore(s => s.workspaceSymbolsLoading)
  const openFileInBrowser = useConnectionStore(s => s.openFileInBrowser)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    requestWorkspaceSymbols()
    setQuery('')
    setSelectedIndex(0)
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [isOpen, requestWorkspaceSymbols])

  const symbols = snapshot?.symbols ?? null

  const filtered = useMemo<SymbolEntry[]>(() => {
    if (!symbols) return []
    if (!query) return symbols
    const lower = query.toLowerCase()
    return symbols.filter(s => s.name.toLowerCase().includes(lower))
  }, [symbols, query])

  useEffect(() => {
    setSelectedIndex(i => (filtered.length === 0 ? 0 : Math.min(i, Math.min(filtered.length, DISPLAY_CAP) - 1)))
  }, [filtered.length])

  useEffect(() => {
    const items = listRef.current?.querySelectorAll('[role="option"]')
    const el = items?.[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  const openAt = useCallback((idx: number) => {
    const s = filtered[idx]
    if (s) {
      openFileInBrowser(s.file, s.line)
      onClose()
    }
  }, [filtered, openFileInBrowser, onClose])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, Math.min(filtered.length, DISPLAY_CAP) - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); openAt(selectedIndex) }
  }, [filtered.length, selectedIndex, openAt, onClose])

  if (!isOpen) return null

  const overflow = filtered.length > DISPLAY_CAP ? filtered.length - DISPLAY_CAP : 0
  const display = overflow > 0 ? filtered.slice(0, DISPLAY_CAP) : filtered
  // #6476 review — show "Indexing…" while a (re)scan is in flight so a reopen never
  // renders the previous scan's table as if it were fresh (workspaceSymbolsLoading
  // is set on request, cleared on snapshot).
  const isLoading = loading || symbols === null

  return (
    <div
      className="file-open-palette-overlay"
      data-modal-overlay
      data-testid="symbol-search-palette"
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="file-open-palette" role="dialog" aria-label="Search symbols">
        <input
          ref={inputRef}
          className="file-open-palette-input"
          type="text"
          placeholder="Search symbols…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
          data-testid="symbol-search-input"
          aria-label="Search symbols"
        />
        <div ref={listRef} className="file-open-palette-list" role="listbox" aria-label="Symbols">
          {isLoading && <div className="file-open-palette-status">Indexing symbols…</div>}
          {!isLoading && filtered.length === 0 && (
            <div className="file-open-palette-status" data-testid="symbol-search-empty">No symbols</div>
          )}
          {display.map((s, i) => (
            <div
              key={`${s.file}:${s.line}:${s.name}:${i}`}
              role="option"
              aria-selected={i === selectedIndex}
              className={`file-open-palette-item${i === selectedIndex ? ' selected' : ''}`}
              data-testid={`symbol-search-item-${s.name}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onMouseDown={(e) => { e.preventDefault(); openAt(i) }}
            >
              <span className="symbol-item-icon" aria-hidden="true">{SYMBOL_KIND_ICON[s.kind] ?? '•'}</span>
              <span className="file-open-palette-path">{s.name}</span>
              <span className="symbol-item-line">{s.file.split('/').pop()}:{s.line}</span>
            </div>
          ))}
          {overflow > 0 && <div className="file-open-palette-status">{overflow} more…</div>}
        </div>
      </div>
    </div>
  )
}
