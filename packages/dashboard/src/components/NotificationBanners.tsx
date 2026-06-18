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
 */
import type { SessionNotification } from '../store/types'

const MAX_VISIBLE = 3

const EVENT_LABELS: Record<SessionNotification['eventType'], string> = {
  permission: 'Permission',
  question: 'Question',
  completed: 'Completed',
  error: 'Error',
}

export interface NotificationBannersProps {
  notifications: SessionNotification[]
  onApprove: (requestId: string, notificationId: string) => void
  onDeny: (requestId: string, notificationId: string) => void
  onDismiss: (notificationId: string) => void
  onSwitchSession: (sessionId: string) => void
}

export function NotificationBanners({
  notifications,
  onApprove,
  onDeny,
  onDismiss,
  onSwitchSession,
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
            {n.eventType === 'permission' && n.requestId ? (
              <>
                <button
                  type="button"
                  className="notification-banner-btn notification-banner-btn--allow"
                  aria-label="Allow"
                  onClick={() => onApprove(n.requestId!, n.id)}
                >
                  Allow
                </button>
                <button
                  type="button"
                  className="notification-banner-btn notification-banner-btn--deny"
                  aria-label="Deny"
                  onClick={() => onDeny(n.requestId!, n.id)}
                >
                  Deny
                </button>
              </>
            ) : (
              <button
                type="button"
                className="notification-banner-btn notification-banner-btn--dismiss"
                aria-label="Dismiss"
                onClick={() => onDismiss(n.id)}
              >
                Dismiss
              </button>
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
