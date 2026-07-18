/**
 * CheckpointTimeline — visual timeline of conversation checkpoints.
 *
 * Shows checkpoints as nodes on a vertical timeline with:
 * - Name, description, and timestamp
 * - Message count and git snapshot badge
 * - Restore files to a checkpoint and delete actions
 * - Create checkpoint button
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useConnectionStore } from '../store/connection'
import type { Checkpoint, RestoreCheckpointMode } from '../store/types'

// #6767: selective restore-mode picker. Order = display order (default first).
const RESTORE_MODES: RestoreCheckpointMode[] = ['both', 'files', 'conversation']
const RESTORE_MODE_LABEL: Record<RestoreCheckpointMode, string> = {
  both: 'Both',
  files: 'Files',
  conversation: 'Conversation',
}
const RESTORE_MODE_TITLE: Record<RestoreCheckpointMode, string> = {
  both: 'Revert the working files and branch the conversation into a new session',
  files: 'Revert only the working files — this conversation and session continue',
  conversation: 'Branch the conversation into a new session — the working files are left as they are',
}
// Honest per-mode Restore-button tooltip (only 'files' keeps the current session).
const RESTORE_BUTTON_TITLE: Record<RestoreCheckpointMode, string> = {
  both: 'Restore files and branch the conversation (opens a new session)',
  files: 'Restore files only (keeps this conversation and session)',
  conversation: 'Branch the conversation to this checkpoint (opens a new session)',
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()

  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (isToday) return time

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`

  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + time
}

// #3619: wall-clock relative-time renderer kept on `Date.now()`
// intentionally. The input `ms` is itself wall-clock (persisted across
// browser refreshes / reconnects); switching to `performance.now()`
// would subtract a process-local monotonic clock from a wall-clock
// input and produce nonsense. Same rationale applies to the analogous
// renderers in `WelcomeScreen.tsx` and `ServerPicker.tsx`.
function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

interface CheckpointNodeProps {
  checkpoint: Checkpoint
  isLatest: boolean
  onRestore: (id: string) => void
  onDelete: (id: string) => void
  confirmingDelete: string | null
  setConfirmingDelete: (id: string | null) => void
  // #6767: tooltip reflecting the currently-selected restore mode.
  restoreButtonTitle: string
}

function CheckpointNode({
  checkpoint, isLatest, onRestore, onDelete, confirmingDelete, setConfirmingDelete, restoreButtonTitle,
}: CheckpointNodeProps) {
  const isConfirming = confirmingDelete === checkpoint.id
  // #3484: trim guard on the name fallback. A whitespace-only
  // `checkpoint.name` is truthy and would render as a visually-empty
  // `<span class="cp-name">` (and a whitespace-only `title` tooltip).
  // The trim is only used as a boolean predicate — `checkpoint.name`
  // is rendered untrimmed when present so the authored value is not
  // mutated. Mirrors the description guard from #3461 and the
  // SkillsPanel guards from #3441 / #3458.
  const hasName = !!checkpoint.name?.trim()

  return (
    <div className={`cp-node${isLatest ? ' cp-latest' : ''}`} data-testid="checkpoint-node">
      <div className="cp-dot" />
      <div className="cp-card">
        <div className="cp-header">
          <span
            className="cp-name"
            title={hasName ? checkpoint.name : checkpoint.id}
          >
            {hasName ? checkpoint.name : `Checkpoint ${checkpoint.id.slice(0, 8)}`}
          </span>
          <span className="cp-time" title={formatTimestamp(checkpoint.createdAt)}>
            {formatRelativeTime(checkpoint.createdAt)}
          </span>
        </div>
        {/* #3461: trim guard suppresses whitespace-only descriptions
            that would otherwise render a blank <div class="cp-desc">
            with layout (margins, line-height) but no visible text.
            The trim is only used as a boolean predicate —
            `checkpoint.description` is rendered untrimmed so we don't
            mutate the authored value. Mirrors the SkillsPanel guards
            from #3441 / #3458. */}
        {checkpoint.description?.trim() && (
          <div className="cp-desc">{checkpoint.description}</div>
        )}
        <div className="cp-meta">
          <span className="cp-messages" title={`${checkpoint.messageCount} messages`}>
            {checkpoint.messageCount} msgs
          </span>
          {checkpoint.hasGitSnapshot && (
            <span className="cp-git-badge" title="Includes git snapshot">
              git
            </span>
          )}
        </div>
        <div className="cp-actions">
          <button
            type="button"
            className="cp-btn cp-restore"
            onClick={() => onRestore(checkpoint.id)}
            title={restoreButtonTitle}
          >
            Restore
          </button>
          {isConfirming ? (
            <>
              <button
                type="button"
                className="cp-btn cp-delete-confirm"
                onClick={() => { onDelete(checkpoint.id); setConfirmingDelete(null) }}
              >
                Confirm
              </button>
              <button
                type="button"
                className="cp-btn cp-cancel"
                onClick={() => setConfirmingDelete(null)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="cp-btn cp-delete"
              onClick={() => setConfirmingDelete(checkpoint.id)}
              title="Delete checkpoint"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function CheckpointTimeline() {
  const checkpoints = useConnectionStore(s => s.checkpoints)
  const listCheckpoints = useConnectionStore(s => s.listCheckpoints)
  const createCheckpoint = useConnectionStore(s => s.createCheckpoint)
  const restoreCheckpoint = useConnectionStore(s => s.restoreCheckpoint)
  const deleteCheckpoint = useConnectionStore(s => s.deleteCheckpoint)
  const connectionPhase = useConnectionStore(s => s.connectionPhase)
  // #6767: gate the "Conversation" restore-mode option on the active session's
  // provider being able to fork/branch a resumed transcript. Mirrors the
  // sessionRules / auto-mode-confirm capability lookups elsewhere in the store.
  const activeSessionId = useConnectionStore(s => s.activeSessionId)
  const sessions = useConnectionStore(s => s.sessions)
  const availableProviders = useConnectionStore(s => s.availableProviders)

  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [restoreMode, setRestoreMode] = useState<RestoreCheckpointMode>('both')

  const canForkConversation = useMemo(() => {
    const active = activeSessionId ? sessions.find(s => s.sessionId === activeSessionId) : undefined
    const provider = active?.provider ?? null
    return availableProviders.find(p => p.name === provider)?.capabilities?.conversationFork === true
  }, [activeSessionId, sessions, availableProviders])

  // #6767: if the picker lands on 'conversation' but the active session can't
  // fork (session switch, or a fork-capable provider that just went away), fall
  // back to the always-available 'both'.
  useEffect(() => {
    if (!canForkConversation && restoreMode === 'conversation') setRestoreMode('both')
  }, [canForkConversation, restoreMode])

  // Load checkpoints on mount
  useEffect(() => {
    if (connectionPhase === 'connected') {
      listCheckpoints()
    }
  }, [connectionPhase, listCheckpoints])

  // Sort checkpoints by creation time (newest first)
  const sorted = useMemo(
    () => [...checkpoints].sort((a, b) => b.createdAt - a.createdAt),
    [checkpoints],
  )

  const handleCreate = useCallback(() => {
    const name = newName.trim() || undefined
    createCheckpoint(name)
    setNewName('')
    setCreating(false)
  }, [newName, createCheckpoint])

  const handleRestore = useCallback((id: string) => {
    restoreCheckpoint(id, restoreMode)
  }, [restoreCheckpoint, restoreMode])

  const handleDelete = useCallback((id: string) => {
    deleteCheckpoint(id)
  }, [deleteCheckpoint])

  return (
    <div className="checkpoint-timeline" data-testid="checkpoint-timeline">
      {/* #6767: restore-mode picker — applied to whichever checkpoint's Restore
          button is clicked. 'Conversation' is disabled when the active session's
          provider can't branch a resumed transcript. */}
      <div className="cp-mode-picker" data-testid="checkpoint-restore-mode" role="group" aria-label="Restore mode">
        <span className="cp-mode-label">Restore:</span>
        {RESTORE_MODES.map((m) => {
          const disabled = m === 'conversation' && !canForkConversation
          return (
            <button
              key={m}
              type="button"
              className={`cp-btn cp-mode-btn${restoreMode === m ? ' cp-mode-active' : ''}`}
              data-testid={`checkpoint-mode-${m}`}
              aria-pressed={restoreMode === m}
              disabled={disabled}
              title={disabled
                ? "This session's provider can't branch the conversation — use Files or Both"
                : RESTORE_MODE_TITLE[m]}
              onClick={() => setRestoreMode(m)}
            >
              {RESTORE_MODE_LABEL[m]}
            </button>
          )
        })}
      </div>

      {/* Create checkpoint */}
      <div className="cp-create-section">
        {creating ? (
          <div className="cp-create-form">
            <input
              type="text"
              className="cp-create-input"
              placeholder="Checkpoint name (optional)"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
              autoFocus
            />
            <button type="button" className="cp-btn cp-create-btn" onClick={handleCreate}>
              Create
            </button>
            <button type="button" className="cp-btn cp-cancel" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="cp-btn cp-new-btn"
            onClick={() => setCreating(true)}
          >
            + New Checkpoint
          </button>
        )}
      </div>

      {/* Timeline */}
      {sorted.length === 0 ? (
        <div className="cp-empty">
          No checkpoints yet. Create one to save your current conversation state.
        </div>
      ) : (
        <div className="cp-timeline-track">
          {sorted.map((cp, i) => (
            <CheckpointNode
              key={cp.id}
              checkpoint={cp}
              isLatest={i === 0}
              onRestore={handleRestore}
              onDelete={handleDelete}
              confirmingDelete={confirmingDelete}
              setConfirmingDelete={setConfirmingDelete}
              restoreButtonTitle={RESTORE_BUTTON_TITLE[restoreMode]}
            />
          ))}
        </div>
      )}
    </div>
  )
}
