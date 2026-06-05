/**
 * SessionBar — horizontal tab strip for session management.
 *
 * Features: active highlight, status dot, close/rename, cwd badge, model badge, provider badge.
 *
 * #4831 — tabs are drag-and-drop reorderable. Native HTML5 DnD (no new deps).
 * Reordering also supports keyboard: focus a tab, press Space (or Shift+Space)
 * to "lift" it into reorder mode, then Arrow Left / Right to move it, then
 * Space / Enter / Escape to drop. Plain Space is the WAI-ARIA grid pattern
 * and matches the #4831 acceptance criteria; Shift+Space is retained as an
 * alias. The `+` (new session) button is anchored at the right edge and is
 * NOT draggable / not a drop target.
 *
 * #4951 — accessibility follow-up to #4831 / PR #4945. `aria-grabbed` is
 * deprecated in WAI-ARIA 1.1+ (and never had reliable screen-reader
 * support); the modern pattern is a visually-hidden polite live region
 * that announces drag-state transitions ("Picked up X", "Over Y",
 * "Dropped X at position 2 of 3", "Cancelled"). Each draggable tab also
 * carries `aria-describedby` pointing at a hidden hint that explains the
 * reorder shortcut, so SR users discover it on focus.
 */
import { useState, useCallback, useRef, useEffect, useId } from 'react'
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

/**
 * #5204 — the Control Room is a special, session-independent top-level tab
 * that lives in the same strip as the session pills. It is NOT a session:
 * it can't be renamed, dragged, or reordered, and its close is always
 * available (and exempt from the session close-confirmation, #5206). When
 * `open`, it renders as a pinned tab at the left of the strip; clicking it
 * activates the host/repo table view, clicking its × closes it.
 */
export interface ControlRoomTabState {
  /** Whether the Control Room tab exists in the strip. */
  open: boolean
  /** Whether the Control Room tab is the focused view. */
  active: boolean
  /** Focus the Control Room tab (show the host/repo table). */
  onActivate: () => void
  /** Close the Control Room tab (returns to the prior session; no confirm). */
  onClose: () => void
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
  /**
   * #5204 — optional Control Room top-level tab. When provided and
   * `open`, a pinned non-session tab renders at the left of the strip.
   */
  controlRoom?: ControlRoomTabState
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
 * #4951 — visually-hidden style for the drag-state live region and the
 * reorder-shortcut hint. Mirrors the "1px clipped box" recipe used by
 * `ConnectionAnnouncer` so screen readers still announce the content
 * (unlike `display: none` / `visibility: hidden`).
 */
const SR_ONLY_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

/**
 * #4831 — pure reorder helper, exported for tests. Moves the entry at
 * `fromIndex` to `toIndex` (insert-before semantics; matches typical drop
 * UX where the dragged tab takes the dropped-on tab's slot and pushes it
 * one over). Never mutates the input.
 *
 * Return-reference contract:
 * - On a successful move (the indices are in range and not a no-op), returns
 *   a NEW array (the result of `slice() + splice()`).
 * - On a no-op (`fromIndex === toIndex`) or out-of-range indices, returns the
 *   ORIGINAL `ids` reference unchanged. Callers using referential equality to
 *   detect "nothing changed" can rely on this; callers that always want a new
 *   reference must clone explicitly.
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

export function SessionBar({ sessions, onSwitch, onClose, onRename, onNewSession, onReorder, controlRoom }: SessionBarProps) {
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

  // #4951 — live-region announcement string. Replaces deprecated
  // `aria-grabbed`. We coalesce all drag-state transitions into a single
  // polite live region so SR users get a narrative ("Picked up Alpha. …
  // Dropped Alpha at position 2 of 3.") rather than silent state changes.
  // Starts empty so the initial mount doesn't announce anything.
  const [reorderAnnouncement, setReorderAnnouncement] = useState('')
  // Stable id for the hidden reorder-shortcut hint that draggable tabs
  // reference via `aria-describedby`. `useId` keeps it unique per render
  // tree (important if multiple SessionBars are mounted in tests).
  const reorderHintId = useId()

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
  //
  // #4951 — also pushes a "Dropped …" announcement into the live region
  // describing the final position so SR users hear where the tab landed.
  const emitReorder = useCallback((from: string, to: string) => {
    if (!onReorder) return
    if (from === to) return
    const ids = sessions.map(s => s.sessionId)
    const fromIdx = ids.indexOf(from)
    const toIdx = ids.indexOf(to)
    if (fromIdx === -1 || toIdx === -1) return
    const next = reorderTabs(ids, fromIdx, toIdx)
    onReorder(next)
    const movedSession = sessions.find(s => s.sessionId === from)
    if (movedSession) {
      // 1-indexed position so the announcement reads naturally
      // ("position 2 of 3", not "position 1 of 3" for the second slot).
      const landed = next.indexOf(from) + 1
      setReorderAnnouncement(
        `Dropped ${movedSession.name} at position ${landed} of ${next.length}.`
      )
    }
  }, [sessions, onReorder])

  // #4831 — keyboard step. `dir` is +1 (right) / -1 (left). Calls
  // `onReorder` directly with the result of `reorderTabs` (insert-before
  // semantics: stepping right swaps with the next neighbor by inserting
  // after it). We don't go through `emitReorder` here because the
  // sessionId → sessionId lookup of that helper is built for the pointer
  // drop path; the keyboard step already knows the moved tab's index.
  //
  // #4951 — also pushes a "Dropped … at position N of M" announcement
  // into the live region inline (each keyboard step is a settled state
  // worth narrating, so SR users hear the new position after every
  // ArrowLeft / ArrowRight).
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
    const movedSession = sessions.find(s => s.sessionId === sessionId)
    if (movedSession) {
      const landed = next.indexOf(sessionId) + 1
      setReorderAnnouncement(
        `Dropped ${movedSession.name} at position ${landed} of ${next.length}.`
      )
    }
  }, [sessions, onReorder])

  return (
    <div className="session-bar" data-testid="session-bar">
      <div className="session-tabs" role="tablist">
        {/* #5204 — pinned, session-independent Control Room tab. Rendered
            first so it sits at the left edge; not draggable / not renamable /
            not a drop target, and its close is always shown (exempt from the
            session close-confirmation). */}
        {controlRoom?.open && (
          <div
            className={`session-tab control-room-tab${controlRoom.active ? ' active' : ''}`}
            data-testid="control-room-tab"
            role="tab"
            aria-selected={controlRoom.active}
            tabIndex={0}
            onClick={() => { if (!controlRoom.active) controlRoom.onActivate() }}
            onKeyDown={e => {
              // Only act on key events that originate on the tab itself, not
              // ones bubbling up from the close × button — otherwise pressing
              // Enter/Space to close the tab would also re-activate it.
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (!controlRoom.active) controlRoom.onActivate()
              }
            }}
          >
            <span className="control-room-tab-icon" aria-hidden="true">⌘</span>
            <span className="tab-name">Control Room</span>
            <button
              className="tab-close"
              data-testid="control-room-tab-close"
              aria-label="Close Control Room"
              onClick={e => {
                e.stopPropagation()
                controlRoom.onClose()
              }}
              type="button"
            >
              &times;
            </button>
          </div>
        )}
        {sessions.map(session => {
          const isDragging = draggingId === session.sessionId
          const isDragOver = dragOverId === session.sessionId && draggingId !== null && draggingId !== session.sessionId
          const isLifted = keyboardLiftId === session.sessionId
          const reorderDisabled = !onReorder
          // #5204 — while the Control Room tab is the focused view, it is the
          // single selected tab in the tablist. Suppress the active session's
          // selected state so we never report two aria-selected tabs (and the
          // dual-active highlight) at once.
          const isActive = session.isActive && !controlRoom?.active
          return (
          <div
            key={session.sessionId}
            className={
              `session-tab${isActive ? ' active' : ''}` +
              `${isDragging ? ' dragging' : ''}` +
              `${isDragOver ? ' drag-over' : ''}` +
              `${isLifted ? ' lifted' : ''}`
            }
            data-testid={`session-tab-${session.sessionId}`}
            role="tab"
            aria-selected={isActive}
            // #4951 — aria-grabbed (and aria-dropeffect) were removed in
            // WAI-ARIA 1.1; the lift state is conveyed via the `lifted`
            // CSS class (visual) + the live-region announcement (SR).
            // aria-describedby points SR users at the hidden reorder hint
            // so they discover the Space / Arrow shortcut on focus.
            aria-describedby={reorderDisabled ? undefined : reorderHintId}
            tabIndex={0}
            // #4949 — surface the keyboard reorder ladder on the tab
            // itself. The `title` is hover-discoverable for mouse
            // users; `aria-keyshortcuts` is the canonical a11y
            // attribute for screen readers. Both stay omitted when
            // reorder is not wired (consumers that don't pass
            // onReorder shouldn't see a tooltip pointing at a no-op).
            // Each token in aria-keyshortcuts is space-separated per
            // the WAI-ARIA 1.2 spec; we list every key the keydown
            // ladder below actually consumes (Space + Shift+Space to
            // lift, Arrow keys to step, Enter/Escape to commit/cancel)
            // so the SR announcement matches the implementation. The
            // tooltip stays in lockstep so mouse + SR users see the
            // same ladder.
            title={reorderDisabled ? undefined : 'Space (or Shift+Space) to reorder (Arrow Left/Right to move, Enter/Escape to commit/cancel)'}
            aria-keyshortcuts={reorderDisabled ? undefined : 'Space Shift+Space ArrowLeft ArrowRight Enter Escape'}
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
              // #4951 — narrate the pickup so SR users know the drag started.
              setReorderAnnouncement(
                `Picked up ${session.name}. Use Arrow Left or Arrow Right to move, Space or Enter to drop, Escape to cancel.`
              )
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
              if (dragOverId !== session.sessionId) {
                setDragOverId(session.sessionId)
                // #4951 — announce hover-over so SR users hear which tab
                // they're about to displace. We only announce on the FIRST
                // entry into a given target (not every dragover tick) by
                // guarding with the `dragOverId !== sessionId` check above.
                setReorderAnnouncement(`Over ${session.name}.`)
              }
            }}
            onDragLeave={e => {
              // #4946 — native dragleave fires when the cursor crosses into a
              // child element (status dot, cwd / model / provider chips, close
              // button), even though the user hasn't actually left the tab.
              // Without this guard the drop-target affordance flickers as the
              // cursor moves over inner chips. Skip the clear when relatedTarget
              // is still contained within this tab; only clear on a genuine
              // boundary exit (relatedTarget is null, the document, or another
              // tab / sibling element).
              const next = e.relatedTarget as Node | null
              if (next && e.currentTarget.contains(next)) return
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
              // Use the CR-aware `isActive`: while the Control Room is the
              // focused view, even the underlying-active session should fire
              // onSwitch so clicking it returns from the CR to that session.
              if (!isActive) onSwitch(session.sessionId)
            }}
            onKeyDown={e => {
              if (renamingId === session.sessionId) return
              // #4831 — keyboard reorder ladder. Both Space (matches the
              // #4831 acceptance criteria + WAI-ARIA grid pattern) and
              // Shift+Space toggle "lift" mode when reorder is wired.
              // While lifted, ArrowLeft / ArrowRight step the tab, and
              // Enter / Space / Escape commit / cancel the lift.
              // When reorder is NOT wired (or while not lifted), plain
              // Space falls through to the tab-activate handler below so
              // role="tab" semantics are preserved; Enter always activates.
              if (e.key === ' ' && !reorderDisabled) {
                e.preventDefault()
                // #4951 — announce the lift / commit transitions in the
                // live region. Plain Space toggles the lift state, so the
                // narration depends on whether we're entering or leaving
                // reorder mode for THIS tab. On commit (toggling lift off)
                // we deliberately do NOT overwrite the live region — each
                // prior ArrowLeft / ArrowRight already pushed a precise
                // "Dropped X at position N of M" via `stepKeyboard`, and
                // that's the settled narration we want SR users to hear
                // (#4963 follow-up: a bare "Dropped X." here would clobber
                // the position information).
                setKeyboardLiftId(prev => {
                  if (prev === session.sessionId) {
                    return null
                  }
                  setReorderAnnouncement(
                    `Picked up ${session.name}. Use Arrow Left or Arrow Right to move, Space or Enter to drop, Escape to cancel.`
                  )
                  return session.sessionId
                })
                return
              }
              if (keyboardLiftId === session.sessionId) {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setKeyboardLiftId(null)
                  // #4951 — narrate cancel so SR users know nothing moved.
                  setReorderAnnouncement(`Cancelled reorder of ${session.name}.`)
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  setKeyboardLiftId(null)
                  // #4951 — Enter is the "commit" alias. Each prior
                  // ArrowLeft / ArrowRight already announced the new
                  // position via `stepKeyboard`'s inline
                  // `setReorderAnnouncement`, so we don't re-narrate
                  // the resting state here (that would risk reading a
                  // stale position if the parent has not yet
                  // propagated the new order back through the
                  // `sessions` prop). Leaving the last
                  // "Dropped X at position N of M" announcement in
                  // the live region is the settled narration.
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
                if (!isActive) onSwitch(session.sessionId)
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

      {/* #4951 — visually-hidden hint referenced via `aria-describedby`
          on each draggable tab. Renders unconditionally so the id stays
          stable; tabs only point at it when `onReorder` is wired. */}
      <span id={reorderHintId} style={SR_ONLY_STYLE}>
        Press Space to pick up this tab for reorder, then use Arrow Left or
        Arrow Right to move it. Press Space or Enter to drop, Escape to
        cancel.
      </span>

      {/* #4951 — polite live region that narrates drag-state transitions
          (pickup, hover-over, drop, cancel). Replaces the deprecated
          `aria-grabbed` attribute. `aria-atomic="true"` so the entire
          message is re-read on each change, not just the diff. */}
      <div
        data-testid="session-bar-reorder-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={SR_ONLY_STYLE}
      >
        {reorderAnnouncement}
      </div>
    </div>
  )
}
