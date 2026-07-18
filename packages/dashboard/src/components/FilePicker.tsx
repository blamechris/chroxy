/**
 * FilePicker — dropdown for selecting files from the project tree.
 *
 * Triggered by `@` in InputBar. Displays files from `list_files` WS response,
 * plus (#6823) any MCP-server resources the session exposes as a distinct
 * "MCP Resources" section — selecting a resource inserts its URI.
 */
import { useMemo, useRef, useEffect } from 'react'
import type { FilePickerItem, MCPResourceItem } from '../store/types'

export type { FilePickerItem }

/**
 * Max file rows rendered before the "N more files..." overflow hint. Exported
 * (#6844 review) so InputBar's keyboard-nav math can span the SAME capped row
 * count the DOM renders — resource rows start right after the capped files,
 * not after the uncapped list.
 */
export const FILE_PICKER_DISPLAY_CAP = 200

export interface FilePickerProps {
  files: FilePickerItem[] | null
  filter: string
  onSelect: (path: string) => void
  onClose: () => void
  selectedIndex?: number
  /** #6823 — MCP-server resources surfaced alongside project files. */
  resources?: MCPResourceItem[] | null
  /** #6823 — called with the resource URI when a resource row is chosen. */
  onSelectResource?: (uri: string) => void
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FilePicker({
  files, filter, onSelect, onClose, selectedIndex = 0, resources, onSelectResource,
}: FilePickerProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const items = listRef.current.querySelectorAll('[role="option"]')
      const el = items[selectedIndex] as HTMLElement | undefined
      el?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [selectedIndex])

  const filtered = useMemo(() => {
    if (!files) return null
    if (!filter) return files
    const lower = filter.toLowerCase()
    return files.filter(f => f.path.toLowerCase().includes(lower))
  }, [files, filter])

  // #6823 — resources filtered by the same substring on uri OR name.
  const filteredResources = useMemo(() => {
    const list = Array.isArray(resources) ? resources : []
    if (!filter) return list
    const lower = filter.toLowerCase()
    return list.filter(r => r.uri.toLowerCase().includes(lower) || r.name.toLowerCase().includes(lower))
  }, [resources, filter])

  if (filtered === null && filteredResources.length === 0) {
    return (
      <div ref={ref} className="file-picker" data-testid="file-picker">
        <div className="file-picker-empty">Loading files...</div>
      </div>
    )
  }

  const filesList = filtered ?? []
  const overflow = filesList.length > FILE_PICKER_DISPLAY_CAP ? filesList.length - FILE_PICKER_DISPLAY_CAP : 0
  const display = overflow > 0 ? filesList.slice(0, FILE_PICKER_DISPLAY_CAP) : filesList
  // #6844 review: resource rows continue the flat keyboard-nav index after the
  // CAPPED file rows actually rendered (display.length), not the uncapped
  // filesList.length — with >200 files the uncapped base desynced the
  // highlight/scroll-into-view from the DOM's option order. InputBar's nav
  // math uses the same FILE_PICKER_DISPLAY_CAP so selection stays aligned.
  const resourceBase = display.length

  if (filesList.length === 0 && filteredResources.length === 0) {
    return (
      <div ref={ref} className="file-picker" data-testid="file-picker">
        <div className="file-picker-empty">No files found</div>
      </div>
    )
  }

  return (
    <div ref={ref} className="file-picker" data-testid="file-picker">
      <div ref={listRef} role="listbox" aria-label="File picker">
        {display.map((file, i) => (
          <div
            key={file.path}
            role="option"
            aria-selected={i === selectedIndex}
            className={`file-picker-item${i === selectedIndex ? ' selected' : ''}`}
            onClick={() => onSelect(file.path)}
          >
            <span className="file-picker-path">{file.path}</span>
            {file.size !== null && (
              <span className="file-picker-size">{formatSize(file.size)}</span>
            )}
          </div>
        ))}
        {overflow > 0 && (
          <div className="file-picker-overflow">{overflow} more files...</div>
        )}
        {filteredResources.length > 0 && (
          <div className="file-picker-group" role="presentation" data-testid="file-picker-resources-group">
            MCP Resources
          </div>
        )}
        {filteredResources.map((res, ri) => {
          const idx = resourceBase + ri
          return (
            <div
              key={`mcp-resource:${res.server}:${res.uri}`}
              role="option"
              aria-selected={idx === selectedIndex}
              className={`file-picker-item${idx === selectedIndex ? ' selected' : ''}`}
              data-testid="file-picker-resource"
              onClick={() => onSelectResource?.(res.uri)}
            >
              <span className="file-picker-path">{res.name}</span>
              <span className="file-picker-resource-meta">{res.server}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
