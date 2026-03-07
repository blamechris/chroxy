/**
 * DiffViewerPanel — inline diff viewer for uncommitted changes.
 *
 * Shows files changed in the active session's repo with:
 * - File list sidebar with addition/deletion counts
 * - Unified diff view with syntax-highlighted lines
 * - Unified/split view toggle
 * - Auto-refresh on mount, manual refresh button
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useConnectionStore } from '../store/connection'
import type { DiffFile, DiffHunk, DiffHunkLine, DiffResult } from '../store/types'

type ViewMode = 'unified' | 'split'

function statusLabel(status: DiffFile['status']): string {
  switch (status) {
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'untracked': return 'U'
    default: return 'M'
  }
}

function statusClass(status: DiffFile['status']): string {
  switch (status) {
    case 'added': return 'diff-status-added'
    case 'deleted': return 'diff-status-deleted'
    case 'renamed': return 'diff-status-renamed'
    case 'untracked': return 'diff-status-untracked'
    default: return 'diff-status-modified'
  }
}

function FileName({ file }: { file: DiffFile }) {
  const name = file.path.includes('/') ? file.path.split('/').pop()! : file.path
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : ''
  return (
    <span className="diff-file-path" title={file.path}>
      {dir && <span className="diff-file-dir">{dir}</span>}
      <span className="diff-file-name">{name}</span>
    </span>
  )
}

function HunkHeader({ header }: { header: string }) {
  return <div className="diff-hunk-header" data-testid="hunk-header">{header}</div>
}

function UnifiedLine({ line }: { line: DiffHunkLine }) {
  const cls =
    line.type === 'addition' ? 'diff-line-add' :
    line.type === 'deletion' ? 'diff-line-del' :
    'diff-line-ctx'
  const prefix = line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '
  return (
    <div className={`diff-line ${cls}`} data-testid="diff-line">
      <span className="diff-line-prefix">{prefix}</span>
      <span className="diff-line-content">{line.content}</span>
    </div>
  )
}

function SplitLine({ left, right }: { left: DiffHunkLine | null; right: DiffHunkLine | null }) {
  return (
    <div className="diff-split-row" data-testid="split-row">
      <div className={`diff-split-cell ${left ? (left.type === 'deletion' ? 'diff-line-del' : 'diff-line-ctx') : 'diff-line-empty'}`}>
        {left && <span className="diff-line-content">{left.content}</span>}
      </div>
      <div className={`diff-split-cell ${right ? (right.type === 'addition' ? 'diff-line-add' : 'diff-line-ctx') : 'diff-line-empty'}`}>
        {right && <span className="diff-line-content">{right.content}</span>}
      </div>
    </div>
  )
}

function buildSplitPairs(lines: DiffHunkLine[]): { left: DiffHunkLine | null; right: DiffHunkLine | null }[] {
  const pairs: { left: DiffHunkLine | null; right: DiffHunkLine | null }[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.type === 'context') {
      pairs.push({ left: line, right: line })
      i++
    } else if (line.type === 'deletion') {
      // Collect consecutive deletions and additions to pair them
      const dels: DiffHunkLine[] = []
      while (i < lines.length && lines[i]!.type === 'deletion') {
        dels.push(lines[i]!)
        i++
      }
      const adds: DiffHunkLine[] = []
      while (i < lines.length && lines[i]!.type === 'addition') {
        adds.push(lines[i]!)
        i++
      }
      const max = Math.max(dels.length, adds.length)
      for (let j = 0; j < max; j++) {
        pairs.push({ left: dels[j] ?? null, right: adds[j] ?? null })
      }
    } else {
      // Standalone addition (no preceding deletion)
      pairs.push({ left: null, right: line })
      i++
    }
  }
  return pairs
}

function HunkView({ hunk, viewMode }: { hunk: DiffHunk; viewMode: ViewMode }) {
  return (
    <div className="diff-hunk">
      <HunkHeader header={hunk.header} />
      {viewMode === 'unified' ? (
        hunk.lines.map((line, i) => <UnifiedLine key={i} line={line} />)
      ) : (
        buildSplitPairs(hunk.lines).map((pair, i) => <SplitLine key={i} left={pair.left} right={pair.right} />)
      )}
    </div>
  )
}

function FileView({ file, viewMode }: { file: DiffFile; viewMode: ViewMode }) {
  return (
    <div className="diff-file-view" data-testid="diff-file-view">
      <div className="diff-file-header">
        <span className={`diff-status-badge ${statusClass(file.status)}`}>
          {statusLabel(file.status)}
        </span>
        <FileName file={file} />
        <span className="diff-file-stats">
          {file.additions > 0 && <span className="diff-stat-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="diff-stat-del">-{file.deletions}</span>}
        </span>
      </div>
      {file.hunks.length === 0 ? (
        <div className="diff-empty-file">Binary file or no diff available</div>
      ) : (
        file.hunks.map((hunk, i) => <HunkView key={i} hunk={hunk} viewMode={viewMode} />)
      )}
    </div>
  )
}

export function DiffViewerPanel() {
  const setDiffCallback = useConnectionStore(s => s.setDiffCallback)
  const requestDiff = useConnectionStore(s => s.requestDiff)
  const connectionPhase = useConnectionStore(s => s.connectionPhase)

  const [files, setFiles] = useState<DiffFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('unified')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Wire callback
  useEffect(() => {
    setDiffCallback((result: DiffResult) => {
      setFiles(result.files)
      setError(result.error)
      setLoading(false)
    })
    return () => setDiffCallback(null)
  }, [setDiffCallback])

  // Request diff on mount
  useEffect(() => {
    if (connectionPhase === 'connected') {
      setLoading(true)
      requestDiff()
    }
  }, [connectionPhase, requestDiff])

  const handleRefresh = useCallback(() => {
    setLoading(true)
    requestDiff()
  }, [requestDiff])

  const handleFileClick = useCallback((path: string) => {
    setSelectedFile(path)
    // Scroll to file in diff view
    const el = document.querySelector(`[data-diff-path="${CSS.escape(path)}"]`)
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0)
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0)

  return (
    <div className="diff-viewer-panel" data-testid="diff-viewer-panel">
      {/* Toolbar */}
      <div className="diff-toolbar">
        <span className="diff-toolbar-title">
          Changes
          {files.length > 0 && (
            <span className="diff-toolbar-stats">
              {' '}{files.length} file{files.length !== 1 ? 's' : ''}
              {totalAdditions > 0 && <span className="diff-stat-add"> +{totalAdditions}</span>}
              {totalDeletions > 0 && <span className="diff-stat-del"> -{totalDeletions}</span>}
            </span>
          )}
        </span>
        <div className="diff-toolbar-actions">
          <button
            type="button"
            className={`diff-view-btn${viewMode === 'unified' ? ' active' : ''}`}
            onClick={() => setViewMode('unified')}
          >
            Unified
          </button>
          <button
            type="button"
            className={`diff-view-btn${viewMode === 'split' ? ' active' : ''}`}
            onClick={() => setViewMode('split')}
          >
            Split
          </button>
          <button
            type="button"
            className="diff-refresh-btn"
            onClick={handleRefresh}
            title="Refresh diff"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="diff-body">
        {/* File sidebar */}
        {files.length > 0 && (
          <div className="diff-sidebar" data-testid="diff-sidebar">
            {files.map(f => (
              <button
                key={f.path}
                type="button"
                className={`diff-sidebar-item${selectedFile === f.path ? ' active' : ''}`}
                onClick={() => handleFileClick(f.path)}
                title={f.path}
              >
                <span className={`diff-status-dot ${statusClass(f.status)}`} />
                <FileName file={f} />
                <span className="diff-sidebar-stats">
                  {f.additions > 0 && <span className="diff-stat-add">+{f.additions}</span>}
                  {f.deletions > 0 && <span className="diff-stat-del">-{f.deletions}</span>}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Diff content */}
        <div className="diff-content" ref={scrollRef}>
          {loading && <div className="diff-loading">Loading diff...</div>}
          {!loading && error && <div className="diff-error">{error}</div>}
          {!loading && !error && files.length === 0 && (
            <div className="diff-empty">No uncommitted changes.</div>
          )}
          {!loading && !error && files.map(f => (
            <div key={f.path} data-diff-path={f.path}>
              <FileView file={f} viewMode={viewMode} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
