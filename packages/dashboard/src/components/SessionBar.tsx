/**
 * SessionBar — horizontal tab strip for session management.
 *
 * Features: active highlight, status dot, close/rename, cwd badge, model badge, provider badge.
 *
 * #4831 — tabs are drag-and-drop reorderable. Native HTML5 DnD (no new deps).
 * Reordering also supports keyboard: focus a tab, press Shift+Space to "lift"
 * it into reorder mode, then Arrow Left / Right to move it, then Space /
 * Enter / Escape to drop. The `+` (new session) button is anchored at the
 * right edge and is NOT draggable / not a drop target.
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import type { SessionVisualStatus } from '@chroxy/store-core'
import { getProviderInfo } from '../lib/provider-labels'

export type SessionStatus = SessionVisualStatus

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: 'Session idle — ready for input',
  working: 'Session working — response, tool, or agent active',
  stale: 'Session stale — idle for 1 hour or more',
}

export interface SessionTabData {
  sessionId: string
  name: string
  isBusy: boolean
  isActive: boolean
  cwd?: string
  model?: string
  provider?: string
  status?: SessionStatus
  // #3567: latched stdin-forwarding-disabled flag from session_list
  // metadata. Renders an inline badge on the tab so the disabled state
  // is visible even when another session is active and the bigger
  // banner isn't shown.
  stdinForwardingDisabled?: boolean
}

export interface SessionBarProps {
  sessions: SessionTabData[]
  onSwitch: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
  onNewSession: () => void
  /**
   * #4831 — invoked when the user drops a tab in a new position.
   * `nextOrder` is the full array of sessionIds in the new visual order
   * (same membership as `sessions`, just permuted). Optional so existing
   * callers continue to compile without reorder support.
   */
  onReorder?: (nextOrder: string[]) => void
}

function shortenModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d.*$/, '')
}

function abbreviateCwd(cwd: string): string {
  const parts = cwd.split('/')
  return parts[parts.length - 1] || cwd
}

function shortenProvider(provider: string): string {
  return getProviderInfo(provider).short
}

/**
 * #4831 — pure reorder helper, exported for tests. Moves the entry at
 * `fromIndex` to `toIndex` (insert-before semantics; matches typical drop
 * UX where the dragged tab takes the dropped-on tab's slot and pushes it
 * one over). Returns a NEW array; never mutates the input.
 */
export function reorderTabs(ids: string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex === toIndex) return ids
  if (fromIndex < 0 || fromIndex >= ids.length) return ids
  if (toIndex < 0 || toIndex > ids.length) return ids
  const next = ids.slice()
  const [moved] = next.splice(fromIndex, 1)
  if (moved === undefined) return ids
  // After removal the indices to the right shift left by one; clamp the
  // insertion point so a drop on the far right lands at the new array's end.
  const adjusted = toIndex > fromIndex ? toIndex - 1 : toIndex
  next.splice(adjusted, 0, moved)
  return next
}

export function SessionBar({ sessions, onSwitch, onClose, onRename, onNewSession, onReorder }: SessionBarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelledRef = useRef(false)
  const showClose = sessions.length > 1

  // #4831 — drag state. `draggingId` is the sessionId of the tab being
  // dragged (set on dragstart, cleared on dragend); `dragOverId` is the
  // sessionId of the tab currently under the cursor (set on dragover,
  // cleared on dragleave / drop). Both are used purely for visual
  // affordance — the actual reorder is computed on drop from index lookups.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // #4831 — keyboard reorder. When non-null, arrows move the tab without
  // a pointer; Space / Enter commits, Escape cancels.
  const [keyboardLiftId, setKeyboardLiftId] = useState<string | null>(null)

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renamingId])

  const startRename = useCallback((session: SessionTabData) => {
    cancelledRef.current = false
    setRenamingId(session.sessionId)
    setRenameValue(session.name)
  }, [])

  const commitRename = useCallback((sessionId: string) => {
    if (cancelledRef.current) return
    const trimmed = renameValue.trim()
    const session = sessions.find(s => s.sessionId === sessionId)
    if (trimmed && session && trimmed !== session.name.trim()) {
      onRename(sessionId, trimmed)
    }
    setRenamingId(null)
  }, [renameValue, onRename, sessions])

  const cancelRename = useCallback(() => {
    cancelledRef.current = true
    setRenamingId(null)
  }, [])

  // #4831 — emit a reorder. `from` and `to` are sessionIds, not indices,
  // so we look up indices from the live `sessions` array (which already
  // reflects the user's current order, since App.tsx feeds it back in via
  // `onReorder`). No-ops when `onReorder` isn't wired.
  const emitReorder = useCallback((from: string, to: string) => {
    if (!onReorder) return
    if (from === to) return
    const ids = sessions.map(s => s.sessionId)
    const fromIdx = ids.indexOf(from)
    const toIdx = ids.indexOf(to)
    if (fromIdx === -1 || toIdx === -1) return
    const next = reorderTabs(ids, fromIdx, toIdx)
    onReorder(next)
  }, [sessions, onReorder])

  // #4831 — keyboard step. `dir` is +1 (right) / -1 (left). Mutates via
  // `emitReorder` (insert-before semantics: stepping right swaps with the
  // next neighbor by inserting after it).
  const stepKeyboard = useCallback((sessionId: string, dir: 1 | -1) => {
    if (!onReorder) return
    const ids = sessions.map(s => s.sessionId)
    const idx = ids.indexOf(sessionId)
    if (idx === -1) return
    const target = idx + dir
    if (target < 0 || target >= ids.length) return
    // For insert-before semantics, swapping with the right neighbor means
    // inserting at (idx+2) so the dragged tab lands after the neighbor.
    const insertAt = dir > 0 ? idx + 2 : idx - 1
    const next = reorderTabs(ids, idx, insertAt)
    onReorder(next)
  }, [sessions, onReorder])

  return (
    <div className="session-bar" data-testid="session-bar">
      <div className="session-tabs" role="tablist">
        {sessions.map(session => {
          const isDragging = draggingId === session.sessionId
          const isDragOver = dragOverId === session.sessionId && draggingId !== null && draggingId !== session.sessionId
          const isLifted = keyboardLiftId === session.sessionId
          const reorderDisabled = !onReorder
          return (
          <div
            key={session.sessionId}
            className={
              `session-tab${session.isActive ? ' active' : ''}` +
              `${isDragging ? ' dragging' : ''}` +
              `${isDragOver ? ' drag-over' : ''}` +
              `${isLifted ? ' lifted' : ''}`
            }
            data-testid={`session-tab-${session.sessionId}`}
            role="tab"
            aria-selected={session.isActive}
            aria-grabbed={isLifted || isDragging ? true : undefined}
            tabIndex={0}
            // #4831 — native HTML5 DnD attributes. `draggable` is only enabled
            // when a reorder callback is wired (so consumers that don't opt
            // in don't get an unexpected interaction). Rename mode suppresses
            // dragging so the user can select text inside the input.
            draggable={!reorderDisabled && renamingId !== session.sessionId}
            onDragStart={e => {
              if (reorderDisabled) return
              setDraggingId(session.sessionId)
              // setData is required for Firefox to actually start the drag;
              // the payload isn't read on drop (we resolve from state).
              try { e.dataTransfer.setData('text/plain', session.sessionId) } catch { /* jsdom */ }
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => {
              setDraggingId(null)
              setDragOverId(null)
            }}
            onDragOver={e => {
              if (reorderDisabled || !draggingId || draggingId === session.sessionId) return
              // Calling preventDefault is what makes this element a valid
              // drop target — without it the drop event never fires.
              e.preventDefault()
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
              if (dragOverId !== session.sessionId) setDragOverId(session.sessionId)
            }}
            onDragLeave={() => {
              if (dragOverId === session.sessionId) setDragOverId(null)
            }}
            onDrop={e => {
              if (reorderDisabled || !draggingId) return
              e.preventDefault()
              emitReorder(draggingId, session.sessionId)
              setDraggingId(null)
              setDragOverId(null)
            }}
            onClick={() => {
              if (!session.isActive) onSwitch(session.sessionId)
            }}
            onKeyDown={e => {
              if (renamingId === session.sessionId) return
              // #4831 — keyboard reorder ladder. Shift+Space toggles "lift"
              // mode. While lifted, ArrowLeft / ArrowRight step the tab,
              // and Enter / Space / Escape commit / cancel the lift.
              // Plain Space / Enter retain their existing tab-activate
              // behaviour so we don't break established UX for users who
              // never engage reorder mode.
              if (e.key === ' ' && e.shiftKey && !reorderDisabled) {
                e.preventDefault()
                setKeyboardLiftId(prev => prev === session.sessionId ? null : session.sessionId)
                return
              }
              if (keyboardLiftId === session.sessionId) {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setKeyboardLiftId(null)
                  return
                }
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setKeyboardLiftId(null)
                  return
                }
                if (e.key === 'ArrowRight') {
                  e.preventDefault()
                  stepKeyboard(session.sessionId, 1)
                  return
                }
                if (e.key === 'ArrowLeft') {
                  e.preventDefault()
                  stepKeyboard(session.sessionId, -1)
                  return
                }
              }
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (!session.isActive) onSwitch(session.sessionId)
              } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const tabs = (e.currentTarget.parentElement as HTMLElement)?.querySelectorAll<HTMLElement>('[role="tab"]')
                if (!tabs) return
                const idx = Array.from(tabs).indexOf(e.currentTarget)
                const next = e.key === 'ArrowRight'
                  ? (idx + 1) % tabs.length
                  : (idx - 1 + tabs.length) % tabs.length
                tabs[next]?.focus()
              }
            }}
          >
            {(() => {
              const effectiveStatus = session.status ?? (session.isBusy ? 'working' : 'idle')
              // #4630 — the dot already had `title` for browser hover, but
              // screen readers ignore `title` on a bare span. `aria-label`
              // duplicates the same human-readable string so SR users hear
              // "session working" / "session idle" rather than nothing.
              // #4873 — the dot intentionally does NOT carry
              // `role="status"`. With N tabs and frequent busy/idle
              // churn from background agents, a polite live region per
              // tab would make the chat unusable on a screen reader.
              // aria-label keeps the dot discoverable on focus/hover
              // without flooding the SR queue.
              return (
                <span
                  className={`tab-status-dot status-${effectiveStatus}`}
                  data-testid="status-dot"
                  title={STATUS_LABELS[effectiveStatus]}
                  aria-label={STATUS_LABELS[effectiveStatus]}
                />
              )
            })()}

            {renamingId === session.sessionId ? (
              <input
                ref={inputRef}
                className="tab-rename-input"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitRename(session.sessionId)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    cancelRename()
                  }
                }}
                onBlur={() => commitRename(session.sessionId)}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span
                className="tab-name"
                onDoubleClick={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  startRename(session)
                }}
              >
                {session.name}
              </span>
            )}

            {/* #4630 — cwd/model/provider chips had at most a `title` (and
                tab-model had nothing). Pair each with `aria-label` so the
                browser hover tooltip and the screen-reader announcement
                stay in lockstep. */}
            {session.cwd && (
              <span
                className="tab-cwd"
                title={session.cwd}
                aria-label={`Working directory: ${session.cwd}`}
              >
                {abbreviateCwd(session.cwd)}
              </span>
            )}

            {session.model && (
              <span
                className="tab-model"
                title={`Model: ${session.model}`}
                aria-label={`Model: ${session.model}`}
              >
                {shortenModel(session.model)}
              </span>
            )}

            {session.provider && (
              <span
                className="tab-provider"
                data-provider={getProviderInfo(session.provider).type}
                title={getProviderInfo(session.provider).tooltip}
                aria-label={getProviderInfo(session.provider).tooltip}
              >
                {shortenProvider(session.provider)}
              </span>
            )}

            {session.stdinForwardingDisabled && (
              <span
                className="tab-stdin-disabled-badge"
                data-testid="tab-stdin-disabled-badge"
                title="Stdin forwarding lost — restart this session"
                aria-label="Stdin forwarding disabled"
              >
                stdin lost
              </span>
            )}

            {showClose && (
              <button
                className="tab-close"
                data-testid="tab-close"
                aria-label={`Close session ${session.name}`}
                onClick={e => {
                  e.stopPropagation()
                  onClose(session.sessionId)
                }}
                type="button"
              >
                &times;
              </button>
            )}
          </div>
          )
        })}
      </div>

      <button
        className="btn-new-session"
        data-testid="new-session-btn"
        onClick={onNewSession}
        aria-label="Create new session"
        title="New session (Ctrl+N)"
        type="button"
      >
        +
      </button>
    </div>
  )
}
