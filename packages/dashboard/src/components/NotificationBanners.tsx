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
 * #7466 — a permission banner's Allow/Deny is gated on `permissionStatus`.
 * The inline `PermissionPrompt` has always had three gates (answered / its own
 * countdown / connected); the banner had NONE, so a request that stopped being
 * pending without an inbound `permission_expired` kept live buttons forever
 * while the inline prompt for the SAME request had already gone inert.
 *
 * The banner now honours all three, and they are NOT two implementations of one
 * rule: the two shapes cannot share code, so they are cross-referenced instead.
 * `PermissionPrompt` answers "can I act?" from a monotonic `performance.now()`
 * countdown local to the mounted prompt (#3619) plus a `resolvedPermissions`
 * lookup; the banner has no countdown and no mount lifetime to anchor one to, so
 * it answers the same question from store state — `isLivePermissionPrompt` over
 * the prompt ChatMessage, which is the signal the tab badge and jump-to-pending
 * already use (#7390). Same three gates, two vantage points. If you change one,
 * change the other: `PermissionPrompt.tsx` `respond()` and `showButtons`.
 *
 * The prop is REQUIRED and has no default: defaulting to "actionable" is
 * precisely the hole being closed, and a default would let a future call site
 * reopen it silently.
 *
 * #7516 — the SESSION-NAME button gets the same treatment, for the same reason
 * and from the opposite direction. `sessionNotifications` is an append-only
 * record: nothing prunes it when a session leaves the roster (deliberately —
 * the row is the trace of what happened, #7353), so `n.sessionId` can name a
 * session that no longer exists. Since #7511 `switchSession` refuses such an id
 * and refuses it SILENTLY, which is right for its machine-driven callers and
 * wrong for a control an operator aimed at: the row kept a live-looking link
 * whose click did nothing at all. `isSessionListed` is the render-time reading
 * of the CHOKE POINT'S OWN predicate (`store/utils.ts`, the function
 * `switchSession` calls), so the button exists exactly when the jump would
 * work.
 *
 * The inert shape follows `not-pending`, not `disconnected`, and the criterion
 * is recoverability: a disconnected request becomes answerable again on
 * reconnect, so it keeps disabled buttons and a reason. A session that left the
 * roster does not come back under the same id, so — like an expired prompt —
 * the control goes away and a marker says why. Collapsing "gone" into "looks
 * clickable" is the state #7472 established must not exist.
 *
 * NO click-time re-check here, unlike `permissionStatus` above, and the
 * difference is not an oversight. A permission deadline passes with no event at
 * all, so nothing re-renders and the render gate goes stale silently (#6308's
 * TOCTOU) — that is what forced the re-check + `recheck()` pair. Roster
 * membership changes only by a store WRITE (`session_list`, `session_timeout`,
 * `auth_ok`), and this component's predicate is derived from `sessions`, so the
 * row re-renders into its inert form the moment the session leaves. And the
 * residual window is covered rather than ignored: `switchSession` still
 * membership-checks (#7511), so the worst case is a refusal the operator would
 * have got anyway — never a switch onto a dead id.
 */
import { useReducer } from 'react'
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
 * #7466 — the three states a permission banner's action area can be in.
 *
 * `disconnected` is deliberately NOT collapsed into `not-pending`: the request
 * is still live and becomes answerable again on reconnect, so the row must keep
 * its (disabled) buttons and say why — exactly what the inline prompt does with
 * `disabled={submitting || !connected}` + `perm-disconnected-hint`. Rendering it
 * as a dead record would be a lie, and silently leaving the buttons enabled is
 * the dead click `sendPermissionResponse`'s own contract comment
 * (`connection.ts:3718-3721`) exists to prevent.
 */
export type PermissionBannerStatus = 'actionable' | 'disconnected' | 'not-pending'

/**
 * #7466 — is this banner's permission still answerable, and if not, why not?
 *
 * Reuses `isLivePermissionPrompt` (@chroxy/store-core), the single shared signal
 * that already drives the per-tab pending badge and jump-to-pending, instead of
 * inventing a second client-side notion of "still pending" (#7390).
 *
 * CONSERVATIVE ON ABSENCE. A banner can exist before `sessionStates` holds the
 * prompt — that is exactly why `sendPermissionResponse` prefers the notification
 * lookup over a `sessionStates` scan — so "no prompt found" counts as pending and
 * the buttons stay. Only a prompt the store has SEEN and knows to be expired or
 * already-decided reports `not-pending`.
 *
 * The prompt is searched in the notification's own session first, then across
 * every session: the banner is cross-session by definition, and a prompt can be
 * filed under an id the notification does not name.
 */
export function permissionNotificationStatus(
  n: SessionNotification,
  sessionStates: Record<string, { messages: ChatMessage[] }>,
  now: number,
  connected: boolean,
): PermissionBannerStatus {
  if (n.eventType !== 'permission' || !n.requestId) return 'actionable'
  if (!isStillPending(n, sessionStates, now)) return 'not-pending'
  // Pending-ness is checked FIRST: a request that already expired is dead
  // whether or not the socket is up, and offering "reconnect to answer" for a
  // prompt nobody can answer any more would be the same overpromise in reverse.
  return connected ? 'actionable' : 'disconnected'
}

function isStillPending(
  n: SessionNotification,
  sessionStates: Record<string, { messages: ChatMessage[] }>,
  now: number,
): boolean {
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
  /**
   * #7466 — how an INERT permission row is retired. `onDismiss` REMOVES the row
   * from the store (`connection.ts` dismissSessionNotification), which is the
   * wrong verb for a row whose entire remaining purpose is to be a record: it
   * would erase the trace of the request the gate was added to preserve
   * (#7353). Mark-read stamps `readAt`, which drops the row from this banner
   * stack (it filters on `readAt === undefined`) while the #4890 notifications
   * widget keeps it in its durable history. Non-permission banners keep the
   * pre-existing `onDismiss` semantics — nothing about those changed.
   */
  onMarkRead: (notificationId: string) => void
  onSwitchSession: (sessionId: string) => void
  /**
   * #7466 — REQUIRED, deliberately without a default. Reports whether the
   * request is answerable right now, and when it is not, which of the two
   * reasons applies. A default of 'actionable' is precisely the hole being
   * closed, so there isn't one.
   */
  permissionStatus: (n: SessionNotification) => PermissionBannerStatus
  /**
   * #7516 — REQUIRED, deliberately without a default, for the same reason
   * `permissionStatus` has none: a default of "listed" is the hole being
   * closed, and it would let a future call site reopen it in silence.
   *
   * Supply the CHOKE POINT'S predicate (`isSessionListed` from
   * `store/utils.ts`, over the same `sessions` array `switchSession` reads) —
   * not a second `.some()` written here. Two copies of one rule is what #7475
   * removed.
   */
  isSessionListed: (sessionId: string) => boolean
}

export function NotificationBanners({
  notifications,
  onApprove,
  onDeny,
  onDismiss,
  onMarkRead,
  onSwitchSession,
  permissionStatus,
  isSessionListed,
}: NotificationBannersProps) {
  // #7474 — a refused click must be VISIBLE, not merely harmless.
  //
  // The click-time re-check below (added by #7466) correctly declines to act on
  // a request that stopped being answerable since the last render. But declining
  // wrote nothing: no store update, no local state, so React had no reason to
  // re-render and the row kept displaying the enabled Allow/Deny it was drawn
  // with. The operator clicks a live-looking button, nothing happens, and the
  // button still looks live — which is the same "a control that visibly does
  // nothing invites a second click" loop #7466 blames for the mis-aimed second
  // click, arrived at from the opposite direction.
  //
  // Nothing else can fix this from outside: the render gate holds the
  // `Date.now()` of the LAST render, and no store event fires on the mere
  // passage of a deadline (#6308's TOCTOU), so the parent has no reason to
  // re-render either. A local bump is the whole mechanism — it forces this
  // component through `permissionStatus` again, which recomputes with a fresh
  // `Date.now()` and the current connection phase, so the row lands in whichever
  // inert form is actually true (retired record, or disabled + "reconnect to
  // answer"). It deliberately does NOT decide that form itself: a bump that
  // hard-coded "not-pending" would tell a disconnected operator their live
  // request was gone.
  const [, recheck] = useReducer((n: number) => n + 1, 0)

  // #4890 — render unread only; read history lives in the widget.
  const unread = notifications.filter((n) => n.readAt === undefined)
  if (unread.length === 0) return null

  const visible = unread.slice(0, MAX_VISIBLE)
  const overflow = unread.length - MAX_VISIBLE

  return (
    <div className="notification-banners" role="log" aria-label="Background session notifications">
      {visible.map((n) => {
        const isPermission = n.eventType === 'permission' && !!n.requestId
        // Computed ONCE per row for the render branch; the click handlers call
        // `permissionStatus` again rather than closing over this value, because
        // the socket can drop (or the deadline pass) between the render and the
        // click and nothing re-renders on either — the #6308 TOCTOU.
        const status: PermissionBannerStatus = isPermission ? permissionStatus(n) : 'actionable'
        return (
        <div
          key={n.id}
          className={`notification-banner notification-banner--${n.eventType}`}
        >
          <div className="notification-banner-content">
            <span className="notification-banner-type">
              {EVENT_LABELS[n.eventType]}
            </span>
            {isSessionListed(n.sessionId) ? (
              <button
                type="button"
                className="notification-banner-session"
                onClick={() => onSwitchSession(n.sessionId)}
              >
                {n.sessionName}
              </button>
            ) : (
              <>
                {/* #7516 — the NAME survives (the row is a record, #7353); only
                    the affordance goes. Rendering it as a non-interactive span
                    is the issue's first-choice remedy: there is nothing left to
                    aim at, so the dead click is impossible rather than merely
                    harmless. A disabled <button> would still be a target the
                    operator reaches for, and "gone" is not recoverable the way
                    `disconnected` is. */}
                <span
                  className="notification-banner-session-name"
                  data-testid="notification-banner-session-name"
                >
                  {n.sessionName}
                </span>
                {/* Says WHY, in the vocabulary the row already uses for its
                    other retired control ("No longer pending"). role="status"
                    for the same reason that one has it: this marker can appear
                    while the banner is on screen — the roster snapshot that
                    removes the session re-renders the row under the cursor —
                    and without it a screen-reader user gets the silent
                    disappearance instead of the dead click. */}
                <span
                  className="notification-banner-session-gone"
                  data-testid="notification-banner-session-gone"
                  role="status"
                >
                  No longer open
                </span>
              </>
            )}
            <span className="notification-banner-message">{n.message}</span>
          </div>
          <div className="notification-banner-actions">
            {!isPermission ? (
              <button
                type="button"
                className="notification-banner-btn notification-banner-btn--dismiss"
                aria-label="Dismiss"
                onClick={() => onDismiss(n.id)}
              >
                Dismiss
              </button>
            ) : status === 'not-pending' ? (
              <>
                {/* #7466 — say WHY the buttons are gone. A silently button-less
                    permission banner reads as a rendering bug; this reads as the
                    record it now is. */}
                <span
                  className="notification-banner-stale"
                  data-testid="notification-banner-stale"
                  // #7474 — a live region for the same reason the disconnected
                  // hint below is one: since the click-time re-check, this
                  // marker can APPEAR in direct response to a click, replacing
                  // the buttons the operator just pressed. A sighted user sees
                  // that; without role="status" a screen-reader user gets the
                  // silent dead click this issue is about.
                  role="status"
                >
                  No longer pending
                </span>
                <button
                  type="button"
                  className="notification-banner-btn notification-banner-btn--dismiss"
                  aria-label="Dismiss"
                  // #7466 — mark-read, NOT remove. See `onMarkRead` above: this
                  // row exists only as a record now, and `onDismiss` would
                  // delete the very trace the gate was added to keep (#7353).
                  onClick={() => onMarkRead(n.id)}
                >
                  Dismiss
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="notification-banner-btn notification-banner-btn--allow"
                  aria-label="Allow"
                  // #7466 — disabled while the socket is down, mirroring the
                  // inline prompt. `sendPermissionResponse` refuses to send when
                  // disconnected and returns false, and the banner handlers now
                  // correctly decline to dismiss on that false — which, without
                  // this, makes a disconnected click produce NO observable change
                  // at all. A disabled button with a reason is the feedback
                  // `connection.ts:3718-3721` promises.
                  disabled={status === 'disconnected'}
                  // Re-check at CLICK time. The render gate is evaluated with the
                  // `Date.now()` and connection phase of the LAST render, and
                  // nothing re-renders on the mere passage of a deadline, so a
                  // prompt can cross its expiry with the buttons still on screen.
                  // A dead click that fires `permission_response` into the void is
                  // the "the click ACTS" half of #7466.
                  // #7474 — on refusal, `recheck()` re-renders this row through
                  // `permissionStatus` so it redraws in its true inert form.
                  // Without the else branch the refusal is invisible.
                  onClick={() => {
                    if (permissionStatus(n) === 'actionable') onApprove(n.requestId!, n.id)
                    else recheck()
                  }}
                >
                  Allow
                </button>
                <button
                  type="button"
                  className="notification-banner-btn notification-banner-btn--deny"
                  aria-label="Deny"
                  disabled={status === 'disconnected'}
                  onClick={() => {
                    if (permissionStatus(n) === 'actionable') onDeny(n.requestId!, n.id)
                    else recheck()
                  }}
                >
                  Deny
                </button>
                {status === 'disconnected' && (
                  // Same words as the inline prompt's `perm-disconnected-hint`
                  // (PermissionPrompt.tsx) on purpose — one vocabulary for one
                  // condition, whichever surface the operator is looking at.
                  <span
                    className="notification-banner-hint"
                    data-testid="notification-banner-disconnected-hint"
                    role="status"
                  >
                    Disconnected — reconnect to answer.
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        )
      })}
      {overflow > 0 && (
        <div className="notification-banner-overflow">
          +{overflow} more
        </div>
      )}
    </div>
  )
}
