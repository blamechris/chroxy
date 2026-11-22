/**
 * useTurnCompleteNotification (#7347) — fire a native notification when a
 * session finishes its turn and is left waiting on the user, while the chroxy
 * window is not focused.
 *
 * ## The gap this closes
 *
 * Before this, `usePermissionNotification` was the dashboard's ONLY native
 * notification trigger. A permission request notified; a completed turn did
 * not. That is backwards: a pending permission leaves the session *visibly*
 * blocked (the ⚠ badge, the Allow/Deny card), whereas a finished turn awaiting
 * a decision is visually indistinguishable from a session that was idle all
 * along (#7340). The silent case is precisely the one that needs an
 * out-of-app signal, and a long autonomous run finishing and sitting unnoticed
 * is what filed the issue.
 *
 * (Note the trigger only became reachable at all with #7351, which added the
 * `Notification.requestPermission()` call chroxy had never made. A trigger
 * added before that would have been just as dead as the permission one.)
 *
 * ## Why the EDGE, not the state
 *
 * The hook fires on the busy → not-busy **transition**, never on "is idle".
 * A session that is merely idle is not awaiting anybody — it is a session
 * nobody has asked to do anything. Keying on the state instead of the edge
 * would notify for every session on the list the moment the window blurred,
 * which is both wrong and unmutable-in-practice.
 *
 * `busy` is fed from the server-authoritative per-session `isIdle` flag
 * (#4639), which `session_activity` maintains for EVERY session — the server
 * broadcasts it on `stream_start` (busy) and on `result` (idle), so a
 * background session's turn boundary reaches us without the session being
 * active. The optimistic `streamingMessageId` sentinel is deliberately NOT
 * folded in: it only ever covers the active session's own sends, and
 * `handleDisconnected` clears it, which would manufacture a busy → idle edge
 * out of a dropped socket.
 *
 * ## Why a dropped socket resets everything
 *
 * A disconnect is not a completed turn. `handleDisconnected` clears transient
 * per-session state, and a reconnect re-seeds `isIdle` from the `session_list`
 * snapshot — either of which can look exactly like busy → idle for a turn that
 * is in fact still running on the server. So `connected === false` drops all
 * tracking, and the first observation after the socket returns only re-seeds.
 *
 * ## Gates
 *
 * - **Window focus** — same rule as `usePermissionNotification`. If the user
 *   is looking at chroxy they do not need to be told. Skipping this is how the
 *   feature becomes noise on every turn, and the way users answer noise is by
 *   switching OS notifications off wholesale — which takes the permission
 *   notifications with it.
 * - **Already-pending prompt** — a session that stopped ON a permission
 *   request is already covered by `usePermissionNotification`. Firing here too
 *   is a duplicate alert for one moment.
 * - **Operator mute** — Settings → Dashboard, persisted per-device.
 * - **OS permission** — NOT checked here. `sendNativeNotification` owns that
 *   decision; see its contract. Pre-checking is what let the pre-#7351 code
 *   scatter a guard nothing satisfied.
 *
 * - **Ended by a Stop (#9272)** — a turn a Stop ended is not "finished". The
 *   session carries `endedByStop` (a `session_stopped`, or a `result` whose
 *   outcome is `stopped` / `stopped_before_output` / `interrupted`), so a Stop
 *   sent from the phone or an agent does not announce itself on the desktop.
 *   ORDERING: for most Stops the signal is already recorded when the session
 *   idles, but a Stop answered by a plain `result` (claude-sdk / claude-cli
 *   after output, #8461) idles the session FIRST and `session_stopped` follows
 *   as the next frame, so the edge alone cannot tell. The dispatch is therefore
 *   held for {@link STOP_SIGNAL_GRACE_MS} and `endedByStop` re-read from the
 *   latest sessions when it elapses.
 *
 * The gates suppress the *dispatch* only. Busy-state bookkeeping runs
 * unconditionally on every pass (short of a disconnect), so a mute toggled
 * mid-turn, or a window focused mid-turn, does not leave stale state that
 * fires a phantom notification later.
 */
import { useEffect, useRef } from 'react'
import { sendNativeNotification } from '../utils/native-notifications'

/**
 * How long a completed-turn notification is held so a `session_stopped` that
 * trails the idling `result` by one frame can still suppress it (#9272). The
 * server emits both in the same tick, so this only has to outlast a frame or
 * two of delivery; it is invisible to a person.
 */
export const STOP_SIGNAL_GRACE_MS = 300

export interface TurnCompleteSession {
  sessionId: string
  /** Display name, used verbatim in the notification title. */
  name: string
  /**
   * Whether a turn is currently in flight. Derived from the session's
   * server-authoritative `isIdle` flag — see the header.
   */
  busy: boolean
  /**
   * Whether this session currently has a live, unanswered permission prompt.
   * When true the turn-complete notification is suppressed because
   * `usePermissionNotification` already covers that moment.
   */
  awaitingPermission: boolean
  /**
   * Whether the session's most recent turn ended because it was stopped
   * (#9272) rather than finished. Suppresses the dispatch like
   * `awaitingPermission`; bookkeeping still runs.
   */
  endedByStop: boolean
}

export interface UseTurnCompleteNotificationOptions {
  /** Operator toggle (Settings → Dashboard). False mutes dispatch only. */
  enabled: boolean
  /** Whether the WebSocket is currently connected — see the header. */
  connected: boolean
  /**
   * Called when the user clicks the notification, so the app can bring the
   * finished session to the front. Works on the web backend and on bundled
   * macOS desktop builds; a notification shown on Windows / Linux cannot report
   * a click (see `NativeNotificationOptions.onClick`, #7367).
   */
  onNotificationClick?: (sessionId: string) => void
}

export function useTurnCompleteNotification(
  sessions: TurnCompleteSession[],
  { enabled, connected, onNotificationClick }: UseTurnCompleteNotificationOptions,
): void {
  /** Session ids observed busy on the previous pass. */
  const busyRef = useRef(new Set<string>())

  // Held in a ref so a fresh click handler from the parent's render does not
  // re-run the effect. Re-running is not merely wasteful here: the effect is
  // edge-triggered off `busyRef`, and an extra pass with unchanged sessions is
  // a no-op, but keeping the dep array to genuine state keeps that guarantee
  // obvious rather than incidental.
  const clickRef = useRef(onNotificationClick)
  useEffect(() => {
    clickRef.current = onNotificationClick
  }, [onNotificationClick])

  // The latest sessions, for the deferred stop re-check below, and the pending
  // grace timers (cleared on disconnect and unmount so none outlives the hook).
  const latestRef = useRef(sessions)
  latestRef.current = sessions
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }
  }, [])

  useEffect(() => {
    const wasBusy = busyRef.current

    if (!connected) {
      wasBusy.clear()
      for (const t of timersRef.current) clearTimeout(t)
      timersRef.current.clear()
      return
    }

    const liveIds = new Set<string>()
    const finished: TurnCompleteSession[] = []

    for (const session of sessions) {
      liveIds.add(session.sessionId)
      const observedBusy = wasBusy.has(session.sessionId)
      if (session.busy) wasBusy.add(session.sessionId)
      else wasBusy.delete(session.sessionId)
      if (observedBusy && !session.busy) finished.push(session)
    }

    // Drop sessions the server no longer lists, so the set stays bounded and a
    // reused id starts from "never observed busy" rather than inheriting a
    // stale edge from a destroyed session.
    for (const id of wasBusy) {
      if (!liveIds.has(id)) wasBusy.delete(id)
    }

    if (finished.length === 0) return
    if (!enabled) return
    if (document.hasFocus()) return

    const send = (session: TurnCompleteSession) => {
      sendNativeNotification(`Chroxy: ${session.name}`, {
        body: 'Finished — awaiting your input.',
        // Collapse repeat completions of the same session into one card
        // instead of stacking one per turn.
        tag: `chroxy-turn-${session.sessionId}`,
        // The Tauri backend reports a click by session id (#7367), not through
        // the closure below, so it needs the id as well as the callback.
        sessionId: session.sessionId,
        onClick: () => clickRef.current?.(session.sessionId),
      })
    }

    for (const session of finished) {
      if (session.awaitingPermission) continue
      if (session.endedByStop) continue
      // Hold the dispatch so a trailing `session_stopped` can still suppress it
      // (#9272, see the header). The latest sessions decide when it elapses.
      const timer = setTimeout(() => {
        timersRef.current.delete(timer)
        const latest = latestRef.current.find(s => s.sessionId === session.sessionId)
        if (latest?.endedByStop) return
        send(session)
      }, STOP_SIGNAL_GRACE_MS)
      timersRef.current.add(timer)
    }
  }, [sessions, enabled, connected])
}
