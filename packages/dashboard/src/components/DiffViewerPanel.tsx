/**
 * DiffViewerPanel — inline diff viewer for uncommitted changes.
 *
 * Shows files changed in the active session's repo with:
 * - File list sidebar with addition/deletion counts
 * - Unified diff view with syntax-highlighted lines
 * - Unified/split view toggle
 * - Auto-refresh on mount, manual refresh button
 * - #6800: per-line inline comments + a one-click "Review code" trigger. A line
 *   in either the unified or split view can be annotated with free text; pending
 *   comments across files are queued and submitted together as the next user
 *   turn for the agent to address (via the normal `input` wire path — no new WS
 *   message type). This is always on (not gated behind features.ide) since it
 *   acts on already-written uncommitted changes, not the pre-write edit surface.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  composeCommentReviewPrompt,
  composeReviewRequestPrompt,
  parseHunkStartLines,
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
 * Commenting wiring threaded down to the diff lines (unified + split). Absent
 * for the read-only PreWriteDiffReview render, which stays unchanged.
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

/** The gutter "+"/"×" button that opens a line's inline comment editor. */
function CommentGutterButton({
  target,
  hasComment,
  onOpen,
}: {
  target: LineCommentTarget
  hasComment: boolean
  onOpen: (target: LineCommentTarget) => void
}) {
  return (
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
  )
}

/**
 * The saved-comment note (with a Remove control) or the open editor for one
 * line. Shared by the unified `CommentableLine` (rendered inline below the
 * line) and the split-view row (rendered full-width below the pair), so both
 * modes present an identical comment surface.
 */
function CommentBody({
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
  return (
    <>
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
        <CommentGutterButton target={target} hasComment={hasComment} onOpen={onOpen} />
        <span className="diff-line-prefix">{prefix}</span>
        <span className="diff-line-content">{line.content}</span>
      </div>
      <CommentBody
        target={target}
        hasComment={hasComment}
        existingText={existingText}
        isEditing={isEditing}
        draft={draft}
        onOpen={onOpen}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onCancel={onCancel}
        onRemove={onRemove}
      />
    </>
  )
}

/** One side of a split-view row: the line plus its index in `hunk.lines`. */
type SplitCell = { line: DiffHunkLine; index: number } | null

/** Comment wiring for the split view — the panel-level API + per-line targets. */
type SplitCommentApi = { api: CommentApi; targets: LineCommentTarget[] }

/**
 * One split-view row (#6800 follow-up). Read-only when `comment` is absent —
 * byte-identical to the original render. With `comment`, each non-empty cell
 * gets the same gutter button as a unified line, keyed by the cell's underlying
 * `hunk.lines` index, and any saved comment / open editor renders full-width
 * below the row. A context line is the same index on both sides, so it shares a
 * single comment surface; a deletion/addition pair carries one per side.
 *
 * #6947: a context line's left and right cells resolve to the same comment
 * target, so rendering the gutter button on both sides offered two clickable
 * affordances for one logical comment. The button now renders once — on the
 * new-file (right) side, matching the target's derived new-file line number —
 * while the left cell still renders the line content and (if present) the
 * has-comment accent. Deletion/addition cells are single-sided already and are
 * unaffected.
 */
function SplitLine({
  left,
  right,
  comment,
}: {
  left: SplitCell
  right: SplitCell
  comment?: SplitCommentApi
}) {
  const leftLine = left?.line ?? null
  const rightLine = right?.line ?? null

  const renderCell = (cell: SplitCell, line: DiffHunkLine | null, side: 'left' | 'right') => {
    const base = line
      ? side === 'left'
        ? (line.type === 'deletion' ? 'diff-line-del' : 'diff-line-ctx')
        : (line.type === 'addition' ? 'diff-line-add' : 'diff-line-ctx')
      : 'diff-line-empty'
    if (!comment || !cell) {
      return (
        <div className={`diff-split-cell ${base}`}>
          {line && <span className="diff-line-content">{line.content}</span>}
        </div>
      )
    }
    const target = comment.targets[cell.index]!
    const hasComment = comment.api.comments.some((c) => c.id === target.key)
    // #6947: a context line is the same target on both sides — only the
    // right (new-file) cell gets the button, so a single comment offers a
    // single affordance. Deletion (left-only) and addition (right-only)
    // cells always show their one button as before.
    const showButton = line?.type !== 'context' || side === 'right'
    return (
      <div
        className={`diff-split-cell diff-split-cell-commentable${hasComment ? ' diff-split-cell-has-comment' : ''} ${base}`}
      >
        {showButton && (
          <CommentGutterButton target={target} hasComment={hasComment} onOpen={comment.api.onOpen} />
        )}
        {line && <span className="diff-line-content">{line.content}</span>}
      </div>
    )
  }

  // Distinct underlying line indices in this row: a context line is the same
  // index on both sides (one comment surface); a deletion/addition pair is two.
  const indices: number[] = []
  if (left) indices.push(left.index)
  if (right && (!left || right.index !== left.index)) indices.push(right.index)

  return (
    <>
      <div className="diff-split-row" data-testid="split-row">
        {renderCell(left, leftLine, 'left')}
        {renderCell(right, rightLine, 'right')}
      </div>
      {comment &&
        indices.map((idx) => {
          const target = comment.targets[idx]!
          const existing = comment.api.comments.find((c) => c.id === target.key)
          const isEditing = comment.api.editingKey === target.key
          if (!existing && !isEditing) return null
          return (
            <CommentBody
              key={target.key}
              target={target}
              hasComment={!!existing}
              existingText={existing?.comment}
              isEditing={isEditing}
              draft={comment.api.draft}
              onOpen={comment.api.onOpen}
              onDraftChange={comment.api.onDraftChange}
              onSave={comment.api.onSave}
              onCancel={comment.api.onCancel}
              onRemove={comment.api.onRemove}
            />
          )
        })}
    </>
  )
}

/**
 * Build the per-line comment targets for a hunk in a single forward pass over
 * `hunk.lines`, accumulating the old/new line counters exactly as
 * deriveLineNumber does (deletions resolve to the old-file line, everything
 * else to the new-file line). Shared by the unified and split renders so a
 * comment keyed on line index `i` lands on the same line — with the same
 * derived line number and comment id — in either mode.
 */
function buildLineTargets(hunk: DiffHunk, filePath: string, hunkIndex: number): LineCommentTarget[] {
  const starts = parseHunkStartLines(hunk.header)
  let oldLine = starts?.oldStart ?? 0
  let newLine = starts?.newStart ?? 0
  return hunk.lines.map((line, i) => {
    const lineNumber = starts ? (line.type === 'deletion' ? oldLine : newLine) : null
    if (line.type === 'deletion') oldLine++
    else if (line.type === 'addition') newLine++
    else {
      oldLine++
      newLine++
    }
    return {
      key: lineKey(filePath, hunkIndex, i),
      filePath,
      lineNumber,
      lineType: line.type,
      lineContent: line.content,
    }
  })
}

function buildSplitPairs(lines: DiffHunkLine[]): { left: SplitCell; right: SplitCell }[] {
  const pairs: { left: SplitCell; right: SplitCell }[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.type === 'context') {
      pairs.push({ left: { line, index: i }, right: { line, index: i } })
      i++
    } else if (line.type === 'deletion') {
      // Collect consecutive deletions and additions to pair them
      const dels: SplitCell[] = []
      while (i < lines.length && lines[i]!.type === 'deletion') {
        dels.push({ line: lines[i]!, index: i })
        i++
      }
      const adds: SplitCell[] = []
      while (i < lines.length && lines[i]!.type === 'addition') {
        adds.push({ line: lines[i]!, index: i })
        i++
      }
      const max = Math.max(dels.length, adds.length)
      for (let j = 0; j < max; j++) {
        pairs.push({ left: dels[j] ?? null, right: adds[j] ?? null })
      }
    } else {
      // Standalone addition (no preceding deletion)
      pairs.push({ left: null, right: { line, index: i } })
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
  /** #6800: identity + comment wiring for the inline comments (unified + split). */
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
  // Inline comments in BOTH unified and split view, whenever a CommentApi +
  // filePath are supplied. Read-only consumers (PreWriteDiffReview) pass
  // neither, so their render is byte-for-byte unchanged.
  const commentsOn = !!commentApi && filePath != null
  // #6930: precompute the per-line targets once (single forward pass over
  // hunk.lines — mirrors deriveLineNumber's logic without the O(n^2) per-line
  // rescan). Shared by the unified lines and the split cells so a comment keyed
  // on index `i` resolves to the same line number + id in either mode.
  const targets = commentsOn ? buildLineTargets(hunk, filePath!, hunkIndex) : null
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
        targets
          ? hunk.lines.map((line, i) => {
              const api = commentApi!
              const target = targets[i]!
              const existing = api.comments.find((c) => c.id === target.key)
              return (
                <CommentableLine
                  key={i}
                  line={line}
                  target={target}
                  hasComment={!!existing}
                  existingText={existing?.comment}
                  isEditing={api.editingKey === target.key}
                  draft={api.draft}
                  onOpen={api.onOpen}
                  onDraftChange={api.onDraftChange}
                  onSave={api.onSave}
                  onCancel={api.onCancel}
                  onRemove={api.onRemove}
                />
              )
            })
          : hunk.lines.map((line, i) => <UnifiedLine key={i} line={line} />)
      ) : (
        buildSplitPairs(hunk.lines).map((pair, i) =>
          targets ? (
            <SplitLine
              key={i}
              left={pair.left}
              right={pair.right}
              comment={{ api: commentApi!, targets }}
            />
          ) : (
            <SplitLine key={i} left={pair.left} right={pair.right} />
          ),
        )
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
      // #6946: any diff push — the manual Refresh landing OR an unprompted
      // auto-refresh/reconnect — can shift line positions, invalidating
      // position-keyed comments. Clear them here (not just in handleRefresh)
      // so an auto-refresh matches mobile's DiffViewer, which drops pending
      // comments on every diff (re)request.
      setFiles(result.files)
      setError(result.error)
      setLoading(false)
      setComments([])
      setEditing(null)
      setDraft('')
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
    // Clear immediately for snappy UI feedback (the toolbar's submit control
    // isn't gated on `loading`, so it would otherwise still show a stale
    // count while the new diff is in flight). The setDiffCallback callback
    // above clears again once the new diff actually lands, covering the
    // auto-refresh/reconnect path that never calls this handler (#6946).
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
