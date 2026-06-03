/**
 * useTauriMenuEvents — bridge macOS menu-bar items to dashboard handlers
 * (#4695 / #4942).
 *
 * The Rust side (packages/desktop/src-tauri/src/lib.rs) emits
 * `menu://<action>` events when the user picks an item from the
 * application menu bar. This hook subscribes to those events and
 * dispatches each one to the matching React-side callback passed in
 * via props. The hook itself only guarantees that menu-bar clicks
 * reach the provided callback — whether a given action's callback is
 * the same function used by a dashboard button or palette command is
 * the caller's choice (e.g. App.tsx currently reuses `handleNewSession`
 * for both the menu bar and the chrome "New Session" button, but the
 * sidebar's per-project row and the command-palette entry have their
 * own inline handlers). Adding a new menu item requires:
 *
 *   1. A new `MenuItemBuilder::with_id("app_menu:<action>", …)` entry
 *      in lib.rs's app-menu builder.
 *   2. A new optional callback prop on this hook, wired in App.tsx.
 *
 * Why a separate hook (vs folding into `useTauriEvents`):
 *   - `useTauriEvents` mutates the Zustand connection store directly
 *     (it has no caller-provided callbacks). The menu actions need
 *     App-local state (`setShowCreateSession`, etc.), so they have to
 *     flow through props. Mixing the two would dilute `useTauriEvents`'s
 *     "store-only side effects" contract.
 *
 * Why every handler beyond onNewSession is optional (#4942):
 *   - The Rust side dispatches some menu items directly without a
 *     dashboard round-trip (Shell > Start, Tunnel > Quick, Help >
 *     Documentation, etc.). The ones that DO flow through this hook
 *     are all dashboard-state toggles.
 *   - Optional props mean callers can wire one new handler at a time
 *     as the matching React surface lands, instead of having to land
 *     all of #4942 atomically.
 *
 * No-op outside Tauri (e.g. plain browser dashboard).
 */
import { useEffect } from 'react'
import { getTauriListen } from '../utils/tauri-bridge'

type UnlistenFn = () => void

export interface TauriMenuHandlers {
  /** Triggered by `File > New Session` (id `app_menu:new-session`). */
  onNewSession: () => void
  /** Triggered by `File > Connect to Server…` (id `app_menu:connect-to-server`). */
  onConnectToServer?: () => void
  /** Triggered by `File > Disconnect` (id `app_menu:disconnect`). */
  onDisconnect?: () => void
  /** Triggered by `View > Toggle Sidebar` (id `app_menu:view-toggle-sidebar`). */
  onToggleSidebar?: () => void
  /** Triggered by `View > Toggle Plan Mode` (id `app_menu:view-toggle-plan-mode`). */
  onTogglePlanMode?: () => void
  /** Triggered by `View > Show QR Code` (id `app_menu:view-show-qr`). */
  onShowQr?: () => void
  /** Triggered by `View > Reload` (id `app_menu:view-reload`). */
  onReload?: () => void
  /** Triggered by `Tunnel > Tunnel Settings…` (id `app_menu:tunnel-settings`). */
  onTunnelSettings?: () => void
  /** Triggered by `Chroxy > Preferences…` (id `app_menu:preferences`). */
  onPreferences?: () => void
  // NOTE: `Window > Bring All to Front` is handled entirely Rust-side
  // (`handle_bring_all_to_front` iterates every webview window). The
  // dashboard has no state to mutate — and `window::show_window` alone
  // only targets the `main` webview, missing secondary windows like
  // `qr_popup`. No hook prop for it.
}

// Concrete contract pinned by the Rust side: each `app_menu:<id>`
// strips its prefix and emits `menu://<id>`. The map below mirrors the
// id schema so a rename on either side breaks tests, not silently in
// production. Keep this grouped by submenu so reviewers can diff
// additions cleanly.
const MENU_EVENT_HANDLERS: Array<{
  event: string
  prop: keyof TauriMenuHandlers
}> = [
  // File submenu
  { event: 'menu://new-session', prop: 'onNewSession' },
  { event: 'menu://connect-to-server', prop: 'onConnectToServer' },
  { event: 'menu://disconnect', prop: 'onDisconnect' },
  // View submenu
  { event: 'menu://view-toggle-sidebar', prop: 'onToggleSidebar' },
  { event: 'menu://view-toggle-plan-mode', prop: 'onTogglePlanMode' },
  { event: 'menu://view-show-qr', prop: 'onShowQr' },
  { event: 'menu://view-reload', prop: 'onReload' },
  // Tunnel submenu (radios go Rust-side; only Settings… reaches us)
  { event: 'menu://tunnel-settings', prop: 'onTunnelSettings' },
  // Chroxy submenu
  { event: 'menu://preferences', prop: 'onPreferences' },
  // Window submenu — `Bring All to Front` is handled Rust-side directly
  // (see `handle_bring_all_to_front`), so it has no entry here.
]

export function useTauriMenuEvents(handlers: TauriMenuHandlers): void {
  const {
    onNewSession,
    onConnectToServer,
    onDisconnect,
    onToggleSidebar,
    onTogglePlanMode,
    onShowQr,
    onReload,
    onTunnelSettings,
    onPreferences,
  } = handlers
  useEffect(() => {
    const listen = getTauriListen()
    if (!listen) return

    const unlisteners: Promise<UnlistenFn>[] = []
    // Resolve each prop to its current callback inside the effect so
    // the listener closure captures the latest function ref (the
    // dependency array below re-runs the effect on any prop change).
    const resolved: Record<string, (() => void) | undefined> = {
      onNewSession,
      onConnectToServer,
      onDisconnect,
      onToggleSidebar,
      onTogglePlanMode,
      onShowQr,
      onReload,
      onTunnelSettings,
      onPreferences,
    }

    for (const { event, prop } of MENU_EVENT_HANDLERS) {
      const cb = resolved[prop as string]
      // Always subscribe, even if the prop is undefined — that way
      // the Rust side can emit a `menu://<id>` for a known menu item
      // without crashing the listener registry, and we just no-op.
      // (Tests pin the subscription contract per id.)
      unlisteners.push(
        listen(event, () => {
          cb?.()
        }),
      )
    }

    return () => {
      unlisteners.forEach(p => p.then(fn => fn()).catch(() => {}))
    }
  }, [
    onNewSession,
    onConnectToServer,
    onDisconnect,
    onToggleSidebar,
    onTogglePlanMode,
    onShowQr,
    onReload,
    onTunnelSettings,
    onPreferences,
  ])
}
