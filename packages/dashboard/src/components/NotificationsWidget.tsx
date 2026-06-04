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
 * mousedown for outside click, Escape, window blur.
 *
 * #5009 — a11y + theme polish (follow-up to #5005):
 *   - Full WAI-ARIA Authoring Practices menu pattern (matches
 *     HeaderOverflowMenu #4980): role="menu" on the <ul> (so its only
 *     children are role="menuitem" rows — the surrounding header /
 *     "Mark all read" / per-row action buttons stay outside the menu
 *     sub-tree), roving tabindex, ArrowDown/Up wrap-around, Home/End
 *     jumps, Enter/Space activate focused row.
 *   - Focus moves into the first item when the panel opens and returns
 *     to the trigger on every dismiss path (Escape, outside-click,
 *     window blur, item activation).
 *   - `aria-controls` wires the trigger to the panel id via `useId()`.
 *     The panel is the popover container; the menu (the <ul>) is one
 *     of its children. AT announces the panel as a labelled region and
 *     the menu as the keyboard-navigable list inside it.
 *   - Bell + eye glyphs are inline SVG (consistent with other header
 *     icons that render via CSS / plain unicode, not platform color
 *     emoji fonts — important inside stripped-down Tauri webviews).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
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

/**
 * Inline bell glyph (#5009). Replaces the U+1F514 emoji code-point so
 * the trigger renders consistently in webviews without color-emoji
 * fonts (e.g. stripped-down Tauri WKWebView profiles) — matches the
 * approach taken by the surrounding header icons (`+`, `⋯`).
 */
function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

/** Inline eye glyph (#5009). Same rationale as BellIcon. */
function EyeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function NotificationsWidget({
  notifications,
  onSwitchSession,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
}: NotificationsWidgetProps) {
  const [open, setOpen] = useState(false)
  // #5009 — roving tabindex: tracks which row is currently in the Tab
  // order. Reset to 0 on open so re-opens always land on the first row.
  const [focusedIndex, setFocusedIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // #5009 — item refs for imperative focus on arrow-key nav. A ref array
  // keeps the API independent of the data-testid contract and avoids
  // DOM lookups on every focus shift. Mirrors HeaderOverflowMenu.
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // #5009 — stable id for `aria-controls` wire-up between trigger and
  // panel. `useId` is React 18+ SSR-safe; matches HeaderOverflowMenu.
  const panelId = useId()

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
      // #5009 — focus restoration is handled centrally by the cleanup
      // effect below; just flip `open` and let every dismiss path
      // converge through the same restore branch.
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
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

  // #5009 — on open, reset focused index AND imperatively move focus to
  // the first row. Mirrors HeaderOverflowMenu's open-focus effect. The
  // tabIndex={0} alone only governs Tab traversal; programmatic focus is
  // required to land the cursor inside the panel for keyboard users.
  useEffect(() => {
    if (!open) return
    setFocusedIndex(0)
    const first = itemRefs.current[0]
    if (first) first.focus()
  }, [open])

  // #5009 — single focus-restore cleanup runs on every open → close
  // transition so every dismiss path (Escape, outside-click, window
  // blur, item activation) reliably returns focus to the trigger.
  // Matches the pattern landed for HeaderOverflowMenu in #4996.
  useEffect(() => {
    if (!open) return
    const active = document.activeElement as HTMLElement | null
    const previouslyFocused =
      active && active !== document.body && !panelRef.current?.contains(active)
        ? active
        : triggerRef.current
    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus()
      }
    }
  }, [open])

  // #5009 — when focusedIndex changes (via arrow keys / Home / End),
  // imperatively move focus to the matching row.
  useEffect(() => {
    if (!open) return
    const target = itemRefs.current[focusedIndex]
    if (target && document.activeElement !== target) {
      target.focus()
    }
  }, [focusedIndex, open])

  // #5009 — clamp focusedIndex when the visible row set shrinks while
  // the panel is open (e.g. an alert is dismissed mid-interaction). If
  // we don't clamp, no row holds tabIndex={0} and the focus-sync effect
  // reads a null ref — arrow nav silently stops working.
  useEffect(() => {
    if (!open) return
    if (focusedIndex >= sorted.length && sorted.length > 0) {
      setFocusedIndex(sorted.length - 1)
    }
  }, [sorted.length, focusedIndex, open])

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
        aria-haspopup="menu"
        aria-expanded={open}
        // #5009 — aria-controls links the trigger to the panel's id so
        // assistive tech announces the relationship. Per WAI-ARIA the
        // attribute is allowed regardless of open state.
        aria-controls={panelId}
        title={triggerLabel}
      >
        <span className="notifications-widget-icon">
          <BellIcon />
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
          id={panelId}
          className="notifications-widget-panel"
          data-testid="notifications-widget-panel"
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
            // #5009 — role="menu" sits on the <ul> so its only
            // descendants are role="menuitem" rows. The surrounding
            // header / "Mark all read" / per-row eye / × buttons stay
            // outside the menu sub-tree (placing them inside would
            // violate the WAI-ARIA menu pattern and undermine roving
            // tabindex). Mirrors HeaderOverflowMenu / SessionContextMenu.
            <ul
              className="notifications-widget-list"
              data-testid="notifications-widget-list"
              role="menu"
              aria-label="Intervention notifications"
              aria-orientation="vertical"
            >
              {sorted.map((n, index) => {
                const isUnread = n.readAt === undefined
                const rowClass = [
                  'notifications-widget-item',
                  isUnread
                    ? 'notifications-widget-item--unread'
                    : 'notifications-widget-item--read',
                  `notifications-widget-item--${n.eventType}`,
                ].join(' ')
                const isFocused = focusedIndex === index
                const handleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
                  switch (e.key) {
                    case 'ArrowDown': {
                      e.preventDefault()
                      e.stopPropagation()
                      setFocusedIndex((i) => (i + 1) % sorted.length)
                      break
                    }
                    case 'ArrowUp': {
                      e.preventDefault()
                      e.stopPropagation()
                      setFocusedIndex((i) => (i - 1 + sorted.length) % sorted.length)
                      break
                    }
                    case 'Home': {
                      e.preventDefault()
                      e.stopPropagation()
                      setFocusedIndex(0)
                      break
                    }
                    case 'End': {
                      e.preventDefault()
                      e.stopPropagation()
                      setFocusedIndex(sorted.length - 1)
                      break
                    }
                    case 'Enter':
                    case ' ': {
                      // #5009 — Enter activates the row natively on a
                      // <button>, but Space scrolls the overflow-y
                      // container in some browsers when focus is on a
                      // button inside it. preventDefault + explicit
                      // activation matches HeaderOverflowMenu's handler
                      // and keeps Space behavior consistent across
                      // browsers.
                      e.preventDefault()
                      e.stopPropagation()
                      onMarkRead(n.id)
                      onSwitchSession(n.sessionId)
                      setOpen(false)
                      break
                    }
                    // Escape is handled at the document level so it
                    // still fires when focus has drifted away from the
                    // panel.
                    default:
                      break
                  }
                }
                return (
                  <li
                    key={n.id}
                    className={rowClass}
                    data-testid={`notifications-widget-item-${n.id}`}
                    data-read={isUnread ? 'false' : 'true'}
                  >
                    <button
                      ref={(node) => {
                        itemRefs.current[index] = node
                      }}
                      type="button"
                      role="menuitem"
                      // #5009 — roving tabindex: only the focused row
                      // is in the Tab order. The rest stay
                      // programmatically focusable (arrow-key handler
                      // calls .focus()) without polluting the outer
                      // header's Tab order.
                      tabIndex={isFocused ? 0 : -1}
                      className="notifications-widget-item-body"
                      data-testid={`notifications-widget-item-body-${n.id}`}
                      onClick={() => {
                        onMarkRead(n.id)
                        onSwitchSession(n.sessionId)
                        setOpen(false)
                      }}
                      onKeyDown={handleKeyDown}
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
                    {/* #5009 — per-row action buttons sit inside the
                        <li> for visual alignment, but tabIndex={-1}
                        keeps them out of the Tab order while the menu
                        is open. Keyboard activation uses the menuitem
                        button's Enter/Space (which marks read + switches
                        session) or the dedicated "Mark all read" button
                        in the header. Mouse users still get per-row
                        affordances. */}
                    <div className="notifications-widget-item-actions">
                      {isUnread && (
                        <button
                          type="button"
                          tabIndex={-1}
                          className="notifications-widget-item-mark-read"
                          data-testid={`notifications-widget-item-mark-read-${n.id}`}
                          aria-label="Mark as read"
                          title="Mark as read"
                          onClick={(e) => {
                            e.stopPropagation()
                            onMarkRead(n.id)
                          }}
                        >
                          <EyeIcon />
                        </button>
                      )}
                      <button
                        type="button"
                        tabIndex={-1}
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
