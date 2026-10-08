/**
 * native-notifications — the dashboard's single backend for OS-level
 * notifications (#7351).
 *
 * ## Why this module exists
 *
 * Before #7351 the dashboard called `new Notification(...)` directly from
 * `usePermissionNotification`, behind a `Notification.permission !== 'granted'`
 * guard — and **nothing in chroxy ever called `Notification.requestPermission()`**.
 * `Notification.permission` therefore stayed `'default'` forever, the guard
 * returned on every invocation, and the single `new Notification` call site was
 * unreachable in production. The feature was dead code that passed its tests,
 * because the suite hand-granted the permission the app never requested.
 *
 * That is the `docs/false-safety-guards.md` shape — *"a precondition that is
 * false, so the body never runs and the job is green"*. The fix is not just to
 * add a `requestPermission()` call; it is to put every native-notification
 * concern (support detection, permission state, requesting, sending) behind one
 * module so a future call site cannot reintroduce the same gap by reaching for
 * the raw Web API again.
 *
 * ## Two backends, and why the Tauri one is preferred
 *
 * - **`tauri`** — `window.__TAURI__.notification`, exposed because
 *   `tauri.conf.json` sets `withGlobalTauri: true` and `capabilities/default.json`
 *   already grants `notification:default` (which covers
 *   `is-permission-granted` / `request-permission` / `notify`). The Rust side
 *   has used this plugin for server-lifecycle notifications since long before
 *   this change; the dashboard simply never reached it from JS.
 * - **`web`** — the standard Web Notification API, for the dashboard opened in
 *   a real browser.
 *
 * Tauri is preferred whenever present. The old code's header claimed the Web
 * API is *"supported in both browsers and Tauri WKWebView"*; that is not
 * something we should rely on — macOS WKWebView does not reliably expose
 * `window.Notification`, and if it does not, the web path is permanently dead
 * in exactly the surface (the desktop app) where turn-complete notifications
 * matter most. Preferring the plugin makes the desktop app correct regardless
 * of what WKWebView happens to expose.
 *
 * ## Secure-context caveat (do not "fix" this by falling back)
 *
 * The Web Notification API is gated on a secure context. `http://127.0.0.1` and
 * `http://localhost` qualify, so the locally-served dashboard is fine — but the
 * dashboard reached over the LAN at `http://192.168.x.x:8765` is **not** a
 * secure context and `Notification` is simply `undefined` there. That is a
 * browser rule we cannot work around, which is why `'unsupported'` is a
 * first-class permission state that the UI surfaces honestly rather than a case
 * we silently swallow.
 */

import { getTauriInvoke, getTauriListen } from './tauri-bridge'

/**
 * Permission state, unified across both backends.
 *
 * `'unsupported'` means no backend is available at all (non-secure-context
 * browser, or a runtime with neither the plugin nor the Web API) — distinct
 * from `'denied'`, which means a backend exists and the user said no.
 */
export type NativeNotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export type NativeNotificationBackend = 'tauri' | 'web' | 'unsupported'

interface TauriNotificationApi {
  isPermissionGranted: () => Promise<boolean>
  requestPermission: () => Promise<string>
  sendNotification: (options: { title: string; body?: string }) => void
}

/**
 * Resolve `window.__TAURI__.notification`, or null when it is absent or
 * incomplete.
 *
 * Every method is checked individually rather than trusting the namespace to
 * exist: a partially-injected plugin API would otherwise throw at the call
 * site, inside an effect, where the failure is invisible.
 */
function getTauriNotificationApi(): TauriNotificationApi | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  const tauri = w.__TAURI__ as Record<string, unknown> | undefined
  const api = tauri?.notification as Partial<TauriNotificationApi> | undefined
  if (
    !api ||
    typeof api.isPermissionGranted !== 'function' ||
    typeof api.requestPermission !== 'function' ||
    typeof api.sendNotification !== 'function'
  ) {
    return null
  }
  return api as TauriNotificationApi
}

function getWebNotificationApi(): typeof Notification | null {
  if (typeof Notification === 'undefined') return null
  if (typeof Notification.requestPermission !== 'function') return null
  return Notification
}

export function getNotificationBackend(): NativeNotificationBackend {
  if (getTauriNotificationApi()) return 'tauri'
  if (getWebNotificationApi()) return 'web'
  return 'unsupported'
}

/**
 * Last known Tauri permission state.
 *
 * The plugin's `isPermissionGranted()` is **async**, but the notification
 * guard in `usePermissionNotification` runs inside a synchronous effect body.
 * So the async answer is cached here and read synchronously by
 * `getNotificationPermission()`. `useNotificationPermission` primes it on
 * mount via `refreshNotificationPermission()`.
 *
 * `null` means "not yet probed". It is deliberately NOT initialised to
 * `'default'`: `null` lets `getNotificationPermission()` report `'default'`
 * (nothing granted yet, correctly refusing to send) while
 * `refreshNotificationPermission()` can still tell "never asked" from "asked
 * and got a real answer".
 */
let tauriPermission: NativeNotificationPermission | null = null

/** Test seam — clears the cached Tauri permission between cases. */
export function resetNativeNotificationStateForTests(): void {
  tauriPermission = null
}

/**
 * Synchronous permission read, safe to call from an effect body.
 *
 * For the Tauri backend this returns the cached value from the last
 * `refreshNotificationPermission()` / `requestNativeNotificationPermission()`,
 * defaulting to `'default'` before the first probe resolves — i.e. it fails
 * *closed* (no notification sent) rather than optimistically assuming a grant.
 */
export function getNotificationPermission(): NativeNotificationPermission {
  const backend = getNotificationBackend()
  if (backend === 'tauri') return tauriPermission ?? 'default'
  if (backend === 'web') {
    const api = getWebNotificationApi()!
    return api.permission as NativeNotificationPermission
  }
  return 'unsupported'
}

/**
 * Probe the current permission without prompting the user.
 *
 * Note the asymmetry: the Tauri plugin's `isPermissionGranted()` returns a
 * *boolean*, so it cannot distinguish `'default'` (never asked) from
 * `'denied'` (asked and refused). A previously-recorded `'denied'` is
 * therefore preserved rather than being downgraded back to `'default'` — which
 * would otherwise make the app re-prompt a user who already said no on every
 * probe. Across reloads, the "have we asked?" flag in `persistence.ts` is what
 * keeps that promise; this cache only covers the current page lifetime.
 */
export async function refreshNotificationPermission(): Promise<NativeNotificationPermission> {
  const tauriApi = getTauriNotificationApi()
  if (tauriApi) {
    try {
      const granted = await tauriApi.isPermissionGranted()
      if (granted) tauriPermission = 'granted'
      else if (tauriPermission !== 'denied') tauriPermission = 'default'
    } catch {
      // A throwing plugin call means we genuinely do not know. Leave any
      // previously-recorded answer intact rather than inventing one.
      if (tauriPermission === null) tauriPermission = 'default'
    }
    return tauriPermission
  }
  return getNotificationPermission()
}

/**
 * Normalise whatever a backend returns into our four-state union.
 *
 * Both backends are specified to resolve with `'granted' | 'denied' |
 * 'default'`, but a shimmed or older implementation can resolve with something
 * else entirely (or `undefined`). Anything unrecognised is treated as
 * `'default'` — not as a grant.
 */
function normalisePermissionResult(value: unknown): NativeNotificationPermission {
  if (value === 'granted' || value === 'denied' || value === 'default') return value
  return 'default'
}

/**
 * Prompt the user for notification permission.
 *
 * **Caller responsibility — user gesture.** On the `web` backend every current
 * browser requires transient activation for this call: Chrome rejects the
 * promise outright ("Notification prompting can only be done from a user
 * gesture") when it is made on page load. So the automatic first-run request
 * is restricted to the `tauri` backend (where the prompt is an OS dialog with
 * no such rule), and in a browser the request is only ever made from a click —
 * the "Enable notifications" button in Settings. See
 * `useNotificationPermission`.
 */
export async function requestNativeNotificationPermission(): Promise<NativeNotificationPermission> {
  const tauriApi = getTauriNotificationApi()
  if (tauriApi) {
    try {
      tauriPermission = normalisePermissionResult(await tauriApi.requestPermission())
    } catch {
      tauriPermission = 'default'
    }
    return tauriPermission
  }

  const webApi = getWebNotificationApi()
  if (!webApi) return 'unsupported'
  try {
    return normalisePermissionResult(await webApi.requestPermission())
  } catch {
    // Chrome rejects rather than resolving when there is no user gesture.
    // Report the state we can still observe instead of crashing the caller.
    return webApi.permission as NativeNotificationPermission
  }
}

export interface NativeNotificationOptions {
  body?: string
  /** Collapse key — replaces an earlier notification with the same tag. */
  tag?: string
  /**
   * The session this notification is about. Required for `onClick` to work on
   * the Tauri backend: the click comes back from the OS as an event carrying
   * this id (there is no per-notification closure to call), and `onClick` is
   * looked up by it. Ignored by the web backend, which has a real
   * `Notification.onclick`.
   */
  sessionId?: string
  /**
   * Invoked when the user clicks the notification, **after** the backend has
   * done whatever raising the window means for it. Use it for what happens
   * *inside* the app (select a session, open a view) — never for the window
   * itself, which differs per backend and is handled below.
   *
   * ## Per backend (#7367)
   *
   * - **web** — `Notification.onclick`: reliable. Raises the window, closes the
   *   card, then calls back.
   * - **tauri on macOS (bundled build)** — works. `tauri-plugin-notification`
   *   has no click callback on desktop, so the notification is delivered by the
   *   app's own `send_session_notification` command, which owns the
   *   `NSUserNotificationCenter` delegate. A click raises the window in Rust and
   *   emits `notification_clicked` with the `sessionId`, which calls back here.
   *   Requires `sessionId`.
   * - **tauri on Windows / Linux, and an unbundled macOS dev binary** — the
   *   notification is shown but **a click does nothing**. There is no callback
   *   to hook and no honest substitute (a "window gained focus soon after a
   *   notification" guess cannot tell a click from a Cmd-Tab), so the gap is left
   *   visible rather than faked. Tracked in #7367.
   */
  onClick?: () => void
}

/** Tauri event the desktop app emits when a notification is clicked (#7367). */
export const NOTIFICATION_CLICKED_EVENT = 'notification_clicked'

/**
 * Click handlers by session id, for the Tauri backend. The OS reports a click as
 * an event naming the session, not as a call on the notification object, so the
 * handler has to be findable by that id. A later notification for the same
 * session replaces the earlier handler; the map is bounded by the number of
 * sessions.
 */
const clickHandlers = new Map<string, () => void>()
let clickListener: Promise<void> | null = null

/** Test seam — forgets handlers and the listener between cases. */
export function resetNativeNotificationClickStateForTests(): void {
  clickHandlers.clear()
  clickListener = null
}

/**
 * Subscribe (once) to the desktop's click event. Never rejects: a missing or
 * failing listener only costs the click, never the notification itself, and a
 * failed attempt is retried by the next send.
 */
function ensureClickListener(): Promise<void> {
  if (clickListener) return clickListener
  const listen = getTauriListen()
  if (!listen) return Promise.resolve()
  try {
    clickListener = listen<{ session_id?: unknown }>(NOTIFICATION_CLICKED_EVENT, (event) => {
      const id = event?.payload?.session_id
      if (typeof id !== 'string') return
      clickHandlers.get(id)?.()
    }).then(
      () => undefined,
      () => {
        clickListener = null
      },
    )
  } catch {
    // A synchronously throwing `listen` is the same outcome: no click routing.
    clickListener = null
    return Promise.resolve()
  }
  return clickListener
}

/**
 * Send a native notification. Returns whether it was actually dispatched.
 *
 * Callers must not pre-check the permission themselves; this is the one place
 * that decides, so a new call site cannot forget the guard the way the
 * pre-#7351 code did. A `false` return means "not sent" for any reason
 * (unsupported, not granted, backend threw).
 */
export function sendNativeNotification(title: string, options: NativeNotificationOptions = {}): boolean {
  if (getNotificationPermission() !== 'granted') return false

  const tauriApi = getTauriNotificationApi()
  if (tauriApi) {
    // Preferred route (#7367): the app's own command, which can report a click.
    // Used for EVERY Tauri notification, not just the ones with a click handler:
    // on macOS the notification centre has a single delegate, and the plugin
    // installs its own on each send, which would orphan the click handler of a
    // turn-complete card delivered earlier.
    const invoke = getTauriInvoke()
    if (invoke) {
      if (options.sessionId && options.onClick) {
        clickHandlers.set(options.sessionId, options.onClick)
      }
      const plugin = tauriApi
      const fallBackToPlugin = () => {
        // An older desktop binary has no such command (the dashboard is served
        // by the daemon and can be newer than the app that hosts it), or the ACL
        // refused it. The notification is still worth showing, without the click.
        try {
          plugin.sendNotification({ title, body: options.body })
        } catch {
          // Nothing left to try.
        }
      }
      // Subscribe to clicks, but do NOT wait for it: the notification goes out
      // now. A `listen` that never settles must cost a click at worst, never the
      // notification (the click takes a human far longer than the registration).
      void ensureClickListener()
      try {
        // No `tag`: the native card deliberately does not collapse (see the Rust
        // side), so there is nothing for it to key on.
        invoke('send_session_notification', {
          title,
          body: options.body,
          sessionId: options.sessionId,
        }).catch(fallBackToPlugin)
      } catch {
        fallBackToPlugin()
      }
      return true
    }
    try {
      // No invoke bridge (e.g. only the plugin namespace was injected): plain
      // plugin delivery, no click and no `tag` — collapsing is the OS's business.
      tauriApi.sendNotification({ title, body: options.body })
      return true
    } catch {
      return false
    }
  }

  const webApi = getWebNotificationApi()
  if (!webApi) return false
  try {
    const notification = new webApi(title, { body: options.body, tag: options.tag })
    const onClick = options.onClick
    if (onClick) {
      notification.onclick = () => {
        // Raising the window is the backend's job, not the caller's: a click
        // on a notification means "take me there", and what "there" is
        // depends on which backend sent it. Best-effort — popup blockers and
        // some window-management policies reject `focus()`, and the in-app
        // navigation below is still worth doing when they do.
        try {
          window.focus()
        } catch {
          // Not focusable — fall through and navigate anyway.
        }
        // Chrome leaves a clicked notification on screen until it is closed
        // explicitly; without this the tray keeps a stale "awaiting you" card
        // for a session the user has already come back to.
        try {
          notification.close()
        } catch {
          // Already dismissed.
        }
        onClick()
      }
    }
    return true
  } catch {
    return false
  }
}
