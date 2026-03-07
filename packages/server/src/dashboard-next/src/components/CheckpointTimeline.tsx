/**
 * CheckpointTimeline — visual timeline of conversation checkpoints.
 *
 * Shows checkpoints as nodes on a vertical timeline with:
 * - Name, description, and timestamp
 * - Message count and git snapshot badge
 * - Restore (branch from any point) and delete actions
 * - Create checkpoint button
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useConnectionStore } from '../store/connection'
import type { Checkpoint } from '../store/types'

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
}

function CheckpointNode({
  checkpoint, isLatest, onRestore, onDelete, confirmingDelete, setConfirmingDelete,
}: CheckpointNodeProps) {
  const isConfirming = confirmingDelete === checkpoint.id

  return (
    <div className={`cp-node${isLatest ? ' cp-latest' : ''}`} data-testid="checkpoint-node">
      <div className="cp-dot" />
      <div className="cp-card">
        <div className="cp-header">
          <span className="cp-name" title={checkpoint.name || checkpoint.id}>
            {checkpoint.name || `Checkpoint ${checkpoint.id.slice(0, 8)}`}
          </span>
          <span className="cp-time" title={formatTimestamp(checkpoint.createdAt)}>
            {formatRelativeTime(checkpoint.createdAt)}
          </span>
        </div>
        {checkpoint.description && (
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
            title="Restore to this checkpoint (creates new session)"
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

  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)

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
    restoreCheckpoint(id)
  }, [restoreCheckpoint])

  const handleDelete = useCallback((id: string) => {
    deleteCheckpoint(id)
  }, [deleteCheckpoint])

  return (
    <div className="checkpoint-timeline" data-testid="checkpoint-timeline">
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
            />
          ))}
        </div>
      )}
    </div>
  )
}
