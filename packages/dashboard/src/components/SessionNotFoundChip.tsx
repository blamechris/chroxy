/**
 * SessionNotFoundChip — #4982
 *
 * Surfaces `session_error{code:'SESSION_NOT_FOUND'}` from the server (added
 * in #4979). The server emits this code when the client addresses a stale
 * sessionId — almost always because the dashboard's persisted
 * `activeSessionId` in localStorage points at a pre-restart id that no
 * longer exists after the daemon's `session-manager.restoreState()`
 * regenerated all ids.
 *
 * The message-handler clears the stale `activeSessionId` so the next user
 * action doesn't loop the same toast, then sets the
 * `sessionNotFoundError` store field which this chip renders against.
 * Tapping a session in the sidebar (which calls `switchSession`)
 * automatically clears the chip; the Dismiss button is the manual escape
 * for operators who want to keep the empty pane open.
 *
 * Visual language follows ResumeUnknownChip (#4947) — calm amber chip with
 * the optional `attemptedSessionId` as mono-spaced subtext, so an operator
 * triaging a recurring SESSION_NOT_FOUND can correlate against their
 * persisted state file (`~/.chroxy/session-state.json`) without grepping
 * server logs.
 */
import type { CSSProperties } from 'react'

export interface SessionNotFoundChipProps {
  /**
   * Server-provided error text — preserved verbatim in the title attribute
   * for operator triage and as the chip's secondary line.
   */
  message: string
  /**
   * The id chroxy addressed before the server rejected it. May be null
   * (server omitted the field) — when missing, the subtext slot is omitted
   * entirely rather than rendered with no value (which would look like a
   * UI bug, same defensive rule as ResumeUnknownChip).
   */
  attemptedSessionId?: string | null
  /** Dismiss handler — wires to the store's dismissSessionNotFoundError action. */
  onDismiss: () => void
}

const ID_SUBTEXT_STYLE: CSSProperties = {
  display: 'block',
  marginTop: 4,
  fontSize: '0.8em',
  fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
  opacity: 0.75,
}

const DISMISS_BUTTON_STYLE: CSSProperties = {
  marginLeft: 12,
  background: 'transparent',
  border: '1px solid currentColor',
  color: 'inherit',
  padding: '2px 10px',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.85em',
}

export function SessionNotFoundChip({ message, attemptedSessionId, onDismiss }: SessionNotFoundChipProps) {
  // Same empty-string defense as ResumeUnknownChip — a stale or trimmed
  // empty value should not produce a broken-looking "Attempted id: " slot.
  const hasId = typeof attemptedSessionId === 'string' && attemptedSessionId.trim().length > 0

  return (
    <div
      className="stream-stall-chip"
      data-testid="session-not-found-chip"
      role="status"
      title={message}
    >
      <span className="stream-stall-chip-text">
        Session was restarted on the server — pick a session from the sidebar to continue.
      </span>
      {hasId && (
        <span data-testid="session-not-found-chip-id" style={ID_SUBTEXT_STYLE}>
          Attempted id: {attemptedSessionId}
        </span>
      )}
      <button
        type="button"
        onClick={onDismiss}
        data-testid="session-not-found-chip-dismiss"
        aria-label="Dismiss session-not-found notice"
        style={DISMISS_BUTTON_STYLE}
      >
        Dismiss
      </button>
    </div>
  )
}
