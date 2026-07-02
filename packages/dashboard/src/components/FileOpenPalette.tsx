/**
 * FileOpenPalette — Cmd+P quick-open (#6473, IDE epic #6469).
 *
 * A fuzzy file palette over the existing `list_files` backend: opening it fetches
 * the workspace file list (bounded, server-side), the input filters by path
 * substring, and Enter opens the selected file in the FileBrowserPanel viewer
 * (via the `openFileInBrowser` store action, which switches to the Files view).
 *
 * Gated by the caller on the opt-in `ide` capability — App only opens it when the
 * server advertises `features.ide`.
 */
import { useState, useEffect, useMemo, useRef, useCallback, type KeyboardEvent } from 'react'
import { useConnectionStore } from '../store/connection'

export interface FileOpenPaletteProps {
  isOpen: boolean
  onClose: () => void
}

const DISPLAY_CAP = 200

export function FileOpenPalette({ isOpen, onClose }: FileOpenPaletteProps) {
  const fetchFileList = useConnectionStore(s => s.fetchFileList)
  const files = useConnectionStore(s => s.filePickerFiles)
  const openFileInBrowser = useConnectionStore(s => s.openFileInBrowser)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // On open: pull the (bounded) workspace file list, reset, and focus the input.
  useEffect(() => {
    if (!isOpen) return
    fetchFileList()
    setQuery('')
    setSelectedIndex(0)
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [isOpen, fetchFileList])

  const filtered = useMemo(() => {
    if (!files) return []
    if (!query) return files
    const lower = query.toLowerCase()
    return files.filter(f => f.path.toLowerCase().includes(lower))
  }, [files, query])

  // Keep the selection in range as the filter narrows.
  useEffect(() => {
    setSelectedIndex(i => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)))
  }, [filtered.length])

  // Keep the highlighted row in view.
  useEffect(() => {
    const items = listRef.current?.querySelectorAll('[role="option"]')
    const el = items?.[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  const openAt = useCallback((idx: number) => {
    const f = filtered[idx]
    if (f) {
      openFileInBrowser(f.path)
      onClose()
    }
  }, [filtered, openFileInBrowser, onClose])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); openAt(selectedIndex) }
  }, [filtered.length, selectedIndex, openAt, onClose])

  if (!isOpen) return null

  const overflow = filtered.length > DISPLAY_CAP ? filtered.length - DISPLAY_CAP : 0
  const display = overflow > 0 ? filtered.slice(0, DISPLAY_CAP) : filtered
  const loading = files === null

  return (
    <div
      className="file-open-palette-overlay"
      data-modal-overlay
      data-testid="file-open-palette"
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="file-open-palette" role="dialog" aria-label="Go to file">
        <input
          ref={inputRef}
          className="file-open-palette-input"
          type="text"
          placeholder="Go to file…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
          data-testid="file-open-palette-input"
          aria-label="Go to file"
        />
        <div ref={listRef} className="file-open-palette-list" role="listbox" aria-label="Files">
          {loading && <div className="file-open-palette-status">Loading files…</div>}
          {!loading && filtered.length === 0 && (
            <div className="file-open-palette-status" data-testid="file-open-palette-empty">No files found</div>
          )}
          {display.map((file, i) => (
            <div
              key={file.path}
              role="option"
              aria-selected={i === selectedIndex}
              className={`file-open-palette-item${i === selectedIndex ? ' selected' : ''}`}
              data-testid={`file-open-item-${file.path}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onMouseDown={(e) => { e.preventDefault(); openAt(i) }}
            >
              <span className="file-open-palette-path">{file.path}</span>
            </div>
          ))}
          {overflow > 0 && <div className="file-open-palette-status">{overflow} more…</div>}
        </div>
      </div>
    </div>
  )
}
