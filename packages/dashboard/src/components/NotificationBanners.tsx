/**
 * NotificationBanners — cross-session notification banners with quick-approve.
 *
 * Renders stacked banners above the content area for background session events.
 * Permission notifications get inline Approve/Deny buttons for quick action
 * without switching sessions. Max 3 visible + overflow count.
 *
 * #4890 — Banners now only render notifications with `readAt === undefined`.
 * The NotificationsWidget owns the full read+unread history list; once the
 * operator acknowledges an alert (via the widget, via switchSession, or via
 * "Mark all read"), the banner stack drops it but the widget retains the
 * entry as part of the durable history. Pre-#4890 the banners filtered the
 * target session out on switch; the new model achieves the same visual
 * outcome — banners vanish for the active session — while keeping the
 * widget's history populated.
 *
 * #7466 — a permission banner's Allow/Deny is gated on `isPermissionActionable`.
 * The inline `PermissionPrompt` has always had three gates (answered / its own
 * countdown / connected); the banner had none, so a request that stopped being
 * pending without an inbound `permission_expired` kept live buttons forever
 * while the inline prompt for the SAME request had already gone inert. The prop
 * is REQUIRED and has no default: defaulting to "actionable" is precisely the
 * hole being closed, and a default would let a future call site reopen it
 * silently.
 */
import { isLivePermissionPrompt } from '@chroxy/store-core'
import type { ChatMessage, SessionNotification } from '../store/types'

const MAX_VISIBLE = 3

const EVENT_LABELS: Record<SessionNotification['eventType'], string> = {
  permission: 'Permission',
  question: 'Question',
  completed: 'Completed',
  error: 'Error',
}

/**
 * #7466 — is this banner's permission still answerable?
 *
 * Reuses `isLivePermissionPrompt` (@chroxy/store-core), the single shared signal
 * that already drives the per-tab pending badge and jump-to-pending, instead of
 * inventing a second client-side notion of "still pending" (#7390).
 *
 * CONSERVATIVE ON ABSENCE. A banner can exist before `sessionStates` holds the
 * prompt — that is exactly why `sendPermissionResponse` prefers the notification
 * lookup over a `sessionStates` scan — so "no prompt found" returns true and the
 * buttons stay. Only a prompt the store has SEEN and knows to be expired or
 * already-decided disarms the row.
 *
 * The prompt is searched in the notification's own session first, then across
 * every session: the banner is cross-session by definition, and a prompt can be
 * filed under an id the notification does not name.
 */
export function isPermissionNotificationActionable(
  n: SessionNotification,
  sessionStates: Record<string, { messages: ChatMessage[] }>,
  now: number,
): boolean {
  if (n.eventType !== 'permission' || !n.requestId) return true
  const requestId = n.requestId
  const match = (messages: ChatMessage[] | undefined) =>
    messages?.find((m) => m.requestId === requestId && m.type === 'prompt')
  const own = match(sessionStates[n.sessionId]?.messages)
  if (own) return isLivePermissionPrompt(own, now)
  for (const sid in sessionStates) {
    if (sid === n.sessionId) continue
    const found = match(sessionStates[sid]?.messages)
    if (found) return isLivePermissionPrompt(found, now)
  }
  return true
}

export interface NotificationBannersProps {
  notifications: SessionNotification[]
  onApprove: (requestId: string, notificationId: string) => void
  onDeny: (requestId: string, notificationId: string) => void
  onDismiss: (notificationId: string) => void
  onSwitchSession: (sessionId: string) => void
  /**
   * #7466 — REQUIRED, deliberately without a default. Returns false once the
   * store knows the request is no longer pending; the row then renders as an
   * inert record (never as live buttons) with a Dismiss, so the trace of the
   * request survives the way #7353 asks.
   */
  isPermissionActionable: (n: SessionNotification) => boolean
}

export function NotificationBanners({
  notifications,
  onApprove,
  onDeny,
  onDismiss,
  onSwitchSession,
  isPermissionActionable,
}: NotificationBannersProps) {
  // #4890 — render unread only; read history lives in the widget.
  const unread = notifications.filter((n) => n.readAt === undefined)
  if (unread.length === 0) return null

  const visible = unread.slice(0, MAX_VISIBLE)
  const overflow = unread.length - MAX_VISIBLE

  return (
    <div className="notification-banners" role="log" aria-label="Background session notifications">
      {visible.map((n) => (
        <div
          key={n.id}
          className={`notification-banner notification-banner--${n.eventType}`}
        >
          <div className="notification-banner-content">
            <span className="notification-banner-type">
              {EVENT_LABELS[n.eventType]}
            </span>
            <button
              type="button"
              className="notification-banner-session"
              onClick={() => onSwitchSession(n.sessionId)}
            >
              {n.sessionName}
            </button>
            <span className="notification-banner-message">{n.message}</span>
          </div>
          <div className="notification-banner-actions">
            {n.eventType === 'permission' && n.requestId && isPermissionActionable(n) ? (
              <>
                <button
                  type="button"
                  className="notification-banner-btn notification-banner-btn--allow"
                  aria-label="Allow"
                  // #7466 — re-check at CLICK time. The render gate is
                  // evaluated with the `Date.now()` of the LAST render, and
                  // nothing re-renders on the mere passage of a deadline, so a
                  // prompt can cross its expiry with the buttons still on
                  // screen. A dead click that fires `permission_response` into
                  // the void is the "the click ACTS" half of #7466.
                  onClick={() => { if (isPermissionActionable(n)) onApprove(n.requestId!, n.id) }}
                >
                  Allow
                </button>
                <button
                  type="button"
                  className="notification-banner-btn notification-banner-btn--deny"
                  aria-label="Deny"
                  onClick={() => { if (isPermissionActionable(n)) onDeny(n.requestId!, n.id) }}
                >
                  Deny
                </button>
              </>
            ) : (
              <>
                {/* #7466 — say WHY the buttons are gone. A silently button-less
                    permission banner reads as a rendering bug; this reads as the
                    record it now is. */}
                {n.eventType === 'permission' && n.requestId && (
                  <span
                    className="notification-banner-stale"
                    data-testid="notification-banner-stale"
                  >
                    No longer pending
                  </span>
                )}
                <button
                  type="button"
                  className="notification-banner-btn notification-banner-btn--dismiss"
                  aria-label="Dismiss"
                  onClick={() => onDismiss(n.id)}
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {overflow > 0 && (
        <div className="notification-banner-overflow">
          +{overflow} more
        </div>
      )}
    </div>
  )
}
