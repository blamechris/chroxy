/**
 * ContainerLostBanner — #7603
 *
 * The dashboard's in-view, per-session surface for a session whose Docker
 * container is no longer running. Before this there was NO in-view session
 * health banner on the dashboard at all: a vanish reached the operator only as
 * a transient red error bubble in the chat log, which scrolls away.
 *
 * Deliberately NOT the crash render path. `CONTAINER_VANISHED` (#7599) is a
 * RECOVERABLE condition — the daemon re-enters the container automatically once
 * it is running again (#7602) — so crash copy ("delete this session to free
 * resources") would push the operator to destroy a session that is about to
 * recover.
 *
 * Two variants, driven by whether the server has already tried and refused to
 * re-enter the container (`reattachError`, from
 * `error{code:'ENVIRONMENT_UNAVAILABLE'}`):
 *
 *   - absent  → "waiting": the container is gone, re-entry is still possible.
 *   - present → "refused": the recovery path ran and declined. The usual cause
 *     is a REBUILT container, which carries none of this session's in-container
 *     state — the daemon refuses rather than resume the conversation into a
 *     silently blank one, and the operator needs to know that retrying will not
 *     fix it by itself.
 *
 * Visual language follows SessionNotFoundChip (#4982), which the issue named as
 * the template. Its Dismiss button is NOT copied as-is: at `padding: 2px 10px`
 * it is well under the repo's 44x44pt floor (Apple HIG / WCAG 2.1 SC 2.5.5).
 * Both controls here carry an explicit 44px minimum.
 */
import type { CSSProperties } from 'react'

export interface ContainerLostBannerProps {
  /**
   * The server's refusal detail from `error{code:'ENVIRONMENT_UNAVAILABLE'}`,
   * or null while re-entry may still succeed. Selects the variant and, when
   * present, is rendered as the operator-facing reason.
   */
  reattachError?: string | null
  /**
   * Re-send the last user message, driving a fresh turn. A turn that succeeds
   * clears this banner (the `result` path); one that does not re-surfaces the
   * vanish. Undefined hides the button — there is nothing to resend on a
   * session with no user turn yet, and a dead control is worse than none
   * (matches StreamStallChip's `onRetry` contract).
   */
  onRetry?: () => void
  /** Dismiss handler — wires to the store's `dismissContainerLost` action. */
  onDismiss: () => void
}

/**
 * 44x44 is the floor, not the target: these sit in a single-line banner where
 * there is room for the visible control to BE the hit area, which the repo's
 * tap-target rule prefers over expanding an undersized box invisibly.
 */
const BUTTON_STYLE: CSSProperties = {
  marginLeft: 12,
  minHeight: 44,
  minWidth: 44,
  background: 'transparent',
  border: '1px solid currentColor',
  color: 'inherit',
  padding: '2px 14px',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.85em',
}

const DETAIL_STYLE: CSSProperties = {
  display: 'block',
  marginTop: 4,
  fontSize: '0.8em',
  opacity: 0.75,
}

export function ContainerLostBanner({
  reattachError,
  onRetry,
  onDismiss,
}: ContainerLostBannerProps) {
  // Same empty-string defense as SessionNotFoundChip / ResumeUnknownChip: a
  // blank detail must not render an explanatory line with nothing in it.
  const detail = typeof reattachError === 'string' ? reattachError.trim() : ''
  const refused = detail.length > 0

  return (
    <div
      className="stream-stall-chip"
      data-testid="container-lost-banner"
      data-variant={refused ? 'refused' : 'waiting'}
      role="status"
    >
      <span className="stream-stall-chip-text" data-testid="container-lost-banner-text">
        {refused
          ? "Container stopped — chroxy could not re-enter it, so this session needs attention."
          : "Container stopped — this session will re-enter it automatically once it's running again."}
      </span>
      {refused && (
        <span data-testid="container-lost-banner-detail" style={DETAIL_STYLE}>
          {detail}
        </span>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          data-testid="container-lost-banner-retry"
          aria-label="Retry the last message in this session"
          style={BUTTON_STYLE}
        >
          Retry
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        data-testid="container-lost-banner-dismiss"
        aria-label="Dismiss container-stopped notice"
        style={BUTTON_STYLE}
      >
        Dismiss
      </button>
    </div>
  )
}
