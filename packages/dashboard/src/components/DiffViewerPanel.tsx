/**
 * DiffViewerPanel — inline diff viewer for uncommitted changes.
 *
 * Shows files changed in the active session's repo with:
 * - File list sidebar with addition/deletion counts
 * - Unified diff view with syntax-highlighted lines
 * - Unified/split view toggle
 * - Auto-refresh on mount, manual refresh button
 * - #6800: per-line inline comments + a one-click "Review code" trigger. A line
 *   in the unified view can be annotated with free text; pending comments across
 *   files are queued and submitted together as the next user turn for the agent
 *   to address (via the normal `input` wire path — no new WS message type). This
 *   is always on (not gated behind features.ide) since it acts on already-written
 *   uncommitted changes, not the pre-write edit surface.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  composeCommentReviewPrompt,
  composeReviewRequestPrompt,
  deriveLineNumber,
  type DiffLineComment,
} from '@chroxy/store-core'
import { useConnectionStore } from '../store/connection'
import type { DiffFile, DiffHunk, DiffHunkLine, DiffResult } from '../store/types'

type ViewMode = 'unified' | 'split'

/** Stable, position-derived key for one diff line (used as the comment id). */
function lineKey(filePath: string, hunkIndex: number, lineIndex: number): string {
  return `${filePath}#${hunkIndex}#${lineIndex}`
}

/**
 * Opening a line's comment editor: everything the composer needs to build the
 * DiffLineComment on save, plus the stable key.
 */
type LineCommentTarget = {
  key: string
  filePath: string
  lineNumber: number | null
  lineType: DiffHunkLine['type']
  lineContent: string
}

/**
 * Commenting wiring threaded down to the unified-view lines. Absent for the
 * read-only / split-view / PreWriteDiffReview renders, which stay unchanged.
 */
type CommentApi = {
  comments: DiffLineComment[]
  editingKey: string | null
  draft: string
  onOpen: (target: LineCommentTarget) => void
  onDraftChange: (text: string) => void
  onSave: () => void
  onCancel: () => void
  onRemove: (key: string) => void
}

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

/**
 * A unified-view line with an inline-comment affordance (#6800). Renders the
 * same content as UnifiedLine plus a gutter "comment" button; when a comment is
 * attached it shows below the line, and clicking the button (or an existing
 * comment) opens the inline editor. Only used when a CommentApi is supplied.
 */
function CommentableLine({
  line,
  target,
  hasComment,
  existingText,
  isEditing,
  draft,
  onOpen,
  onDraftChange,
  onSave,
  onCancel,
  onRemove,
}: {
  line: DiffHunkLine
  target: LineCommentTarget
  hasComment: boolean
  existingText: string | undefined
  isEditing: boolean
  draft: string
  onOpen: (target: LineCommentTarget) => void
  onDraftChange: (text: string) => void
  onSave: () => void
  onCancel: () => void
  onRemove: (key: string) => void
}) {
  const cls =
    line.type === 'addition' ? 'diff-line-add' :
    line.type === 'deletion' ? 'diff-line-del' :
    'diff-line-ctx'
  const prefix = line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '
  return (
    <>
      <div
        className={`diff-line diff-line-commentable ${cls}${hasComment ? ' diff-line-has-comment' : ''}`}
        data-testid="diff-line"
      >
        <button
          type="button"
          className="diff-line-comment-btn"
          onClick={() => onOpen(target)}
          title={hasComment ? 'Edit comment' : 'Comment on this line'}
          aria-label={hasComment ? 'Edit comment on this line' : 'Comment on this line'}
          data-testid="diff-line-comment-btn"
        >
          <span aria-hidden="true">{hasComment ? '×' : '+'}</span>
        </button>
        <span className="diff-line-prefix">{prefix}</span>
        <span className="diff-line-content">{line.content}</span>
      </div>
      {hasComment && !isEditing && (
        <div className="diff-line-comment-note" data-testid="diff-line-comment-note">
          <button
            type="button"
            className="diff-comment-note-text"
            onClick={() => onOpen(target)}
            title="Edit comment"
          >
            {existingText}
          </button>
          <button
            type="button"
            className="diff-comment-remove"
            onClick={() => onRemove(target.key)}
            aria-label="Remove comment"
          >
            Remove
          </button>
        </div>
      )}
      {isEditing && (
        <div className="diff-line-comment-editor" data-testid="diff-line-comment-editor">
          <textarea
            className="diff-comment-input"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder="Leave a comment for Claude…"
            rows={2}
            autoFocus
            data-testid="diff-comment-input"
          />
          <div className="diff-comment-editor-actions">
            <button
              type="button"
              className="diff-comment-save"
              onClick={onSave}
              disabled={draft.trim().length === 0}
              data-testid="diff-comment-save"
            >
              Add comment
            </button>
            <button type="button" className="diff-comment-cancel" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
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

/**
 * #6542: opt-in per-hunk accept/reject. A discriminated union so `selectable`
 * ALWAYS comes with `selected` + `onToggle` — you can't create a dead checkbox
 * (a control advertising a checkbox role with no handler). Read-only viewers
 * (DiffViewerPanel) pass neither, so the existing render is byte-for-byte
 * unchanged. The selection STATE + applyHunks wiring live in the consuming
 * surface (#6543 feature B, #6544 feature A).
 */
type HunkSelectionProps =
  | { selectable?: false; selected?: never; onToggle?: never }
  | { selectable: true; selected: boolean; onToggle: () => void }

export type HunkViewProps = {
  hunk: DiffHunk
  viewMode: ViewMode
  /** #6800: identity + comment wiring for the unified-view inline comments. */
  filePath?: string
  hunkIndex?: number
  commentApi?: CommentApi
} & HunkSelectionProps

export function HunkView({
  hunk,
  viewMode,
  filePath,
  hunkIndex = 0,
  commentApi,
  selectable = false,
  selected = false,
  onToggle,
}: HunkViewProps) {
  const cls = `diff-hunk${selectable ? ` diff-hunk-selectable${selected ? '' : ' diff-hunk-rejected'}` : ''}`
  // Inline comments only in unified view, and only when a CommentApi + filePath
  // are supplied. Split view and read-only consumers keep the original render.
  const commentsOn = viewMode === 'unified' && !!commentApi && filePath != null
  return (
    <div className={cls} data-testid="diff-hunk">
      {selectable ? (
        <label className="diff-hunk-toggle-row">
          <input
            type="checkbox"
            className="diff-hunk-toggle"
            checked={selected}
            onChange={onToggle}
            data-testid="hunk-toggle"
            aria-label={selected ? 'Reject this hunk' : 'Accept this hunk'}
          />
          <HunkHeader header={hunk.header} />
        </label>
      ) : (
        <HunkHeader header={hunk.header} />
      )}
      {viewMode === 'unified' ? (
        hunk.lines.map((line, i) => {
          if (!commentsOn) return <UnifiedLine key={i} line={line} />
          const api = commentApi!
          const key = lineKey(filePath!, hunkIndex, i)
          const existing = api.comments.find((c) => c.id === key)
          return (
            <CommentableLine
              key={i}
              line={line}
              target={{
                key,
                filePath: filePath!,
                lineNumber: deriveLineNumber(hunk, i),
                lineType: line.type,
                lineContent: line.content,
              }}
              hasComment={!!existing}
              existingText={existing?.comment}
              isEditing={api.editingKey === key}
              draft={api.draft}
              onOpen={api.onOpen}
              onDraftChange={api.onDraftChange}
              onSave={api.onSave}
              onCancel={api.onCancel}
              onRemove={api.onRemove}
            />
          )
        })
      ) : (
        buildSplitPairs(hunk.lines).map((pair, i) => <SplitLine key={i} left={pair.left} right={pair.right} />)
      )}
    </div>
  )
}

function FileView({
  file,
  viewMode,
  commentApi,
}: {
  file: DiffFile
  viewMode: ViewMode
  commentApi?: CommentApi
}) {
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
        file.hunks.map((hunk, i) => (
          <HunkView
            key={i}
            hunk={hunk}
            viewMode={viewMode}
            filePath={file.path}
            hunkIndex={i}
            commentApi={commentApi}
          />
        ))
      )}
    </div>
  )
}

export function DiffViewerPanel() {
  const setDiffCallback = useConnectionStore(s => s.setDiffCallback)
  const requestDiff = useConnectionStore(s => s.requestDiff)
  const connectionPhase = useConnectionStore(s => s.connectionPhase)
  const sendInput = useConnectionStore(s => s.sendInput)

  const [files, setFiles] = useState<DiffFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('unified')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // #6800: pending inline comments + the open editor.
  const [comments, setComments] = useState<DiffLineComment[]>([])
  const [editing, setEditing] = useState<LineCommentTarget | null>(null)
  const [draft, setDraft] = useState('')
  const [justSent, setJustSent] = useState<'comments' | 'review' | null>(null)

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

  // Auto-clear the "Sent to Claude" confirmation.
  useEffect(() => {
    if (!justSent) return
    const t = setTimeout(() => setJustSent(null), 2500)
    return () => clearTimeout(t)
  }, [justSent])

  const handleRefresh = useCallback(() => {
    // A refreshed diff can shift line positions, invalidating position-keyed
    // comments — drop pending annotations so none land on the wrong line.
    setComments([])
    setEditing(null)
    setDraft('')
    setLoading(true)
    requestDiff()
  }, [requestDiff])

  const handleFileClick = useCallback((path: string) => {
    setSelectedFile(path)
    // Scroll to file in diff view
    const el = document.querySelector(`[data-diff-path="${CSS.escape(path)}"]`)
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const handleOpenComment = useCallback((target: LineCommentTarget) => {
    setEditing(target)
    setComments((prev) => {
      const existing = prev.find((c) => c.id === target.key)
      setDraft(existing?.comment ?? '')
      return prev
    })
  }, [])

  const handleSaveComment = useCallback(() => {
    if (!editing) return
    const text = draft.trim()
    if (!text) return
    setComments((prev) => {
      const next: DiffLineComment = {
        id: editing.key,
        filePath: editing.filePath,
        lineNumber: editing.lineNumber,
        lineType: editing.lineType,
        lineContent: editing.lineContent,
        comment: text,
      }
      const idx = prev.findIndex((c) => c.id === editing.key)
      if (idx >= 0) {
        const copy = [...prev]
        copy[idx] = next
        return copy
      }
      return [...prev, next]
    })
    setEditing(null)
    setDraft('')
  }, [editing, draft])

  const handleCancelComment = useCallback(() => {
    setEditing(null)
    setDraft('')
  }, [])

  const handleRemoveComment = useCallback((key: string) => {
    setComments((prev) => prev.filter((c) => c.id !== key))
    setEditing((cur) => (cur?.key === key ? null : cur))
  }, [])

  const handleSubmitComments = useCallback(() => {
    if (comments.length === 0) return
    const prompt = composeCommentReviewPrompt(comments)
    if (!prompt) return
    const result = sendInput(prompt)
    if (result) {
      setComments([])
      setEditing(null)
      setDraft('')
      setJustSent('comments')
    }
  }, [comments, sendInput])

  const handleReview = useCallback(() => {
    const prompt = composeReviewRequestPrompt(files.map((f) => ({ path: f.path })))
    const result = sendInput(prompt)
    if (result) setJustSent('review')
  }, [files, sendInput])

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0)
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0)

  const commentApi: CommentApi = {
    comments,
    editingKey: editing?.key ?? null,
    draft,
    onOpen: handleOpenComment,
    onDraftChange: setDraft,
    onSave: handleSaveComment,
    onCancel: handleCancelComment,
    onRemove: handleRemoveComment,
  }

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
          {justSent && (
            <span className="diff-toolbar-sent" data-testid="diff-toolbar-sent">
              {' '}Sent to Claude
            </span>
          )}
        </span>
        <div className="diff-toolbar-actions">
          {comments.length > 0 && (
            <button
              type="button"
              className="diff-submit-btn"
              onClick={handleSubmitComments}
              data-testid="diff-submit-comments-btn"
              title="Send your comments to Claude"
            >
              Submit {comments.length} comment{comments.length !== 1 ? 's' : ''}
            </button>
          )}
          {files.length > 0 && (
            <button
              type="button"
              className="diff-review-btn"
              onClick={handleReview}
              data-testid="diff-review-btn"
              title="Ask Claude to review these changes"
            >
              Review code
            </button>
          )}
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
              <FileView file={f} viewMode={viewMode} commentApi={commentApi} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
