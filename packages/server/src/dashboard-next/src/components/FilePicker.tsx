/**
 * FilePicker — dropdown for selecting files from the project tree.
 *
 * Triggered by `@` in InputBar. Displays files from `list_files` WS response.
 */
import { useMemo, useRef, useEffect } from 'react'
import type { FilePickerItem } from '../store/types'

export type { FilePickerItem }

export interface FilePickerProps {
  files: FilePickerItem[] | null
  filter: string
  onSelect: (path: string) => void
  onClose: () => void
  selectedIndex?: number
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FilePicker({
  files, filter, onSelect, onClose, selectedIndex = 0,
}: FilePickerProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const filtered = useMemo(() => {
    if (!files) return null
    if (!filter) return files
    const lower = filter.toLowerCase()
    return files.filter(f => f.path.toLowerCase().includes(lower))
  }, [files, filter])

  if (filtered === null) {
    return (
      <div ref={ref} className="file-picker" data-testid="file-picker">
        <div className="file-picker-empty">Loading files...</div>
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div ref={ref} className="file-picker" data-testid="file-picker">
        <div className="file-picker-empty">No files found</div>
      </div>
    )
  }

  return (
    <div ref={ref} className="file-picker" data-testid="file-picker">
      <div role="listbox" aria-label="File picker">
        {filtered.map((file, i) => (
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
      </div>
    </div>
  )
}
