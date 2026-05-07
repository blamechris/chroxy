/**
 * StdinDisabledBanner — surfaces the latched `stdinForwardingDisabled` flag
 * from `session_list` metadata (#3540 / #3564 / #3567).
 *
 * Once a SidecarProcess emits `stdin_disabled` (#3402, #3501) the sidecar's
 * stdin pipe is permanently broken. The server latches the flag onto the
 * session, persists it across restarts, and surfaces it via `session_list`
 * so reconnecting clients can render this banner without waiting for a fresh
 * `error{code:'stdin_disabled'}` event (which only fires once on the original
 * process). Restarting the session is the only recovery path — clicking
 * "Restart Session" invokes the parent's `onRestart` handler which creates a
 * replacement session first (same cwd / name / provider / model /
 * permissionMode) and then destroys the wedged one (#3602). Create-then-
 * destroy avoids the server's "Cannot destroy the last session" rejection in
 * the common single-session case. No confirm dialog — destruction is implicit
 * in "restart".
 */

export interface StdinDisabledBannerProps {
  visible: boolean
  sessionId: string | null
  onRestart: (sessionId: string) => void
}

export function StdinDisabledBanner({
  visible,
  sessionId,
  onRestart,
}: StdinDisabledBannerProps) {
  if (!visible || !sessionId) return null

  return (
    // role="status" pairs with aria-live="polite" per the dashboard's
    // ARIA convention (see Toast.tsx — `role="alert"` is paired with
    // `aria-live="assertive"`). The disabled state is a recovery hint,
    // not an emergency interruption, so polite is the correct urgency.
    <div
      className="stdin-disabled-banner"
      data-testid="stdin-disabled-banner"
      role="status"
      aria-live="polite"
    >
      <span className="stdin-disabled-banner-icon" aria-hidden="true">
        !
      </span>
      <span className="stdin-disabled-banner-message">
        Stdin forwarding lost — restart this session to continue.
      </span>
      <button
        className="btn-retry"
        data-testid="stdin-disabled-restart-button"
        onClick={() => onRestart(sessionId)}
        type="button"
      >
        Restart Session
      </button>
    </div>
  )
}
