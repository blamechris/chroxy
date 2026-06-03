/**
 * NotificationsWidget (#4890) — Slack-style intervention notifications
 * inbox. Bell-icon trigger in the header with an unread count badge;
 * clicking opens a dropdown listing every session notification (read +
 * unread) so the operator gets a durable "do I have outstanding
 * interventions to deal with?" signal instead of toasts that vanish.
 *
 * Read/unread model — handled by the connection store actions
 * `markSessionNotificationRead(id)` and `markAllSessionNotificationsRead()`
 * (see store/connection.ts). The widget is a pure consumer:
 *
 *   - Items render with a bolder weight / `notifications-widget-item--unread`
 *     class while `readAt === undefined`; once stamped they fade to a
 *     muted "read" treatment but stay in the list.
 *   - Clicking a row body marks the alert as read AND switches to its
 *     session (the most common operator intent). Two per-row affordances
 *     decompose the intent: the eyeball button marks-read without
 *     switching (only rendered on unread rows), and the "×" button
 *     dismisses (removes) the alert outright.
 *   - "Mark all read" stamps every currently-unread alert in one batch.
 *
 * Scope — in-memory only. `sessionNotifications` is transient and resets
 * on reload/reconnect, so read state can't outlive a session anyway. The
 * "should read state persist across reload?" decision in the AC is
 * documented as "no, for v1" — server-side persistence is deferred to a
 * follow-up issue.
 *
 * Dismiss pattern mirrors HeaderOverflowMenu (#4974/#4980): capturing
 * mousedown for outside click, Escape, window blur. Focus is NOT trapped
 * inside the panel because the list can be long and operators may want
 * to Tab into the surrounding header — assistive tech still gets the
 * `role="dialog"` + `aria-label` wire-up, and the trigger's
 * `aria-expanded` advertises the open state.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionNotification } from '../store/types'

const EVENT_LABELS: Record<SessionNotification['eventType'], string> = {
  permission: 'Permission',
  question: 'Question',
  completed: 'Completed',
  error: 'Error',
}

/**
 * Soft cap on the widget's unread badge — once we cross 99 the badge
 * shows "99+" so a runaway broadcasting session can't blow up the
 * fixed-width header chrome. The full list (rendered in the dropdown)
 * is not truncated; the operator still gets to triage every entry.
 */
const UNREAD_BADGE_CAP = 99

export interface NotificationsWidgetProps {
  notifications: SessionNotification[]
  onSwitchSession: (sessionId: string) => void
  onMarkRead: (notificationId: string) => void
  onMarkAllRead: () => void
  onDismiss: (notificationId: string) => void
}

function formatRelative(ts: number, now: number): string {
  const delta = Math.max(0, now - ts)
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

export function NotificationsWidget({
  notifications,
  onSwitchSession,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
}: NotificationsWidgetProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Newest first — sorted by timestamp descending. Memoised so the array
  // reference is stable across re-renders for downstream useEffect deps.
  const sorted = useMemo(() => {
    return [...notifications].sort((a, b) => b.timestamp - a.timestamp)
  }, [notifications])

  const unreadCount = useMemo(
    () => notifications.reduce((acc, n) => (n.readAt === undefined ? acc + 1 : acc), 0),
    [notifications],
  )

  // Stamp `now` once per render so each row's relative timestamp doesn't
  // race against a re-render mid-frame. A fresh `now` on every render is
  // fine — the helper is pure.
  const now = Date.now()

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current && panelRef.current.contains(target)) return
      if (triggerRef.current && triggerRef.current.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onBlur = () => setOpen(false)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const badgeText =
    unreadCount === 0
      ? null
      : unreadCount > UNREAD_BADGE_CAP
        ? `${UNREAD_BADGE_CAP}+`
        : String(unreadCount)

  const triggerLabel =
    unreadCount === 0
      ? 'Notifications'
      : `Notifications, ${unreadCount} unread`

  return (
    <div className="notifications-widget">
      <button
        ref={triggerRef}
        type="button"
        className="header-icon-btn notifications-widget-trigger"
        data-testid="notifications-widget-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={triggerLabel}
      >
        {/* Inline bell glyph — avoids pulling an icon font for one symbol. */}
        <span className="notifications-widget-icon" aria-hidden="true">
          {'\u{1F514}'}
        </span>
        {badgeText !== null && (
          <span
            className="notifications-widget-badge"
            data-testid="notifications-widget-badge"
            aria-hidden="true"
          >
            {badgeText}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          className="notifications-widget-panel"
          data-testid="notifications-widget-panel"
          role="dialog"
          aria-label="Intervention notifications"
        >
          <div className="notifications-widget-header">
            <span className="notifications-widget-title">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                className="notifications-widget-mark-all"
                data-testid="notifications-widget-mark-all-read"
                onClick={onMarkAllRead}
              >
                Mark all read
              </button>
            )}
          </div>
          {sorted.length === 0 ? (
            <div
              className="notifications-widget-empty"
              data-testid="notifications-widget-empty"
            >
              No notifications.
            </div>
          ) : (
            <ul
              className="notifications-widget-list"
              data-testid="notifications-widget-list"
            >
              {sorted.map((n) => {
                const isUnread = n.readAt === undefined
                const rowClass = [
                  'notifications-widget-item',
                  isUnread
                    ? 'notifications-widget-item--unread'
                    : 'notifications-widget-item--read',
                  `notifications-widget-item--${n.eventType}`,
                ].join(' ')
                return (
                  <li
                    key={n.id}
                    className={rowClass}
                    data-testid={`notifications-widget-item-${n.id}`}
                    data-read={isUnread ? 'false' : 'true'}
                  >
                    <button
                      type="button"
                      className="notifications-widget-item-body"
                      data-testid={`notifications-widget-item-body-${n.id}`}
                      onClick={() => {
                        onMarkRead(n.id)
                        onSwitchSession(n.sessionId)
                        setOpen(false)
                      }}
                    >
                      <span className="notifications-widget-item-type">
                        {EVENT_LABELS[n.eventType]}
                      </span>
                      <span className="notifications-widget-item-session">
                        {n.sessionName}
                      </span>
                      <span className="notifications-widget-item-message">
                        {n.message}
                      </span>
                      <span className="notifications-widget-item-time">
                        {formatRelative(n.timestamp, now)}
                      </span>
                    </button>
                    <div className="notifications-widget-item-actions">
                      {isUnread && (
                        <button
                          type="button"
                          className="notifications-widget-item-mark-read"
                          data-testid={`notifications-widget-item-mark-read-${n.id}`}
                          aria-label="Mark as read"
                          title="Mark as read"
                          onClick={(e) => {
                            e.stopPropagation()
                            onMarkRead(n.id)
                          }}
                        >
                          {/* eye glyph */}
                          {'\u{1F441}'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="notifications-widget-item-dismiss"
                        data-testid={`notifications-widget-item-dismiss-${n.id}`}
                        aria-label="Dismiss"
                        title="Dismiss"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDismiss(n.id)
                        }}
                      >
                        &times;
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
