import { useCallback } from 'react'
import { useConnectionStore } from '../store/connection'
import { useTauriMenuEvents } from './useTauriMenuEvents'
import { resolveTogglePlanModeTarget } from '../lib/plan-mode-toggle'

export interface UseTauriMenuWiringArgs {
  /** File > New Session — same callback the chrome "New Session" button uses. */
  onNewSession: () => void
  /** View > Show QR Code — same fetch the chrome "Show QR" affordance triggers. */
  onShowQr: () => void
  /** Opens the converged Settings surface (Control Room Settings tab, #5544). */
  openSettings: () => void
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>
  setPermissionMode: (mode: string) => void
  /**
   * #8084 / #8087 review (Critical #2) — whether the active session's
   * provider capability allows ENTERING plan mode (claude-tui reports
   * `planMode: false`). Mirrors `useShortcutDispatch.ts`'s prop of the same
   * name; both flow from `App.tsx`'s `dropdownFlags.showPlanMode`. Defaults
   * to `true` when omitted so existing call sites keep working. Leaving
   * plan mode is never gated on this — see `resolveTogglePlanModeTarget`.
   */
  planModeSupported?: boolean
}

/**
 * Bridge the macOS menu-bar items to App-state handlers (#4695 / #4942, #5560).
 * No-op outside Tauri (web dashboard).
 *
 * Pure move out of App.tsx — the six menu callbacks and the `useTauriMenuEvents`
 * binding are byte-identical to the inline versions. The sidebar's per-project
 * "+" row and command-palette entries open their dialogs through their own
 * inline handlers, so they are intentionally NOT routed through this hook.
 *
 * Window > Bring All to Front is handled entirely Rust-side
 * (`handle_bring_all_to_front`) — the dashboard has no state to mutate, so it
 * doesn't appear in the hook surface.
 *
 * `menuTogglePlanMode` used to carry its own copy of the enter/leave logic
 * `useShortcutDispatch.ts`'s `session.togglePlanMode` case has — the two
 * copies drifted (#8087 review, Critical #2): the shortcut got gated on the
 * active provider's `planMode` capability in #8084, and this menu handler
 * did not, so the native menu bar could still force a `claude-tui` session
 * into plan mode. Both now call the shared `resolveTogglePlanModeTarget`.
 */
export function useTauriMenuWiring({
  onNewSession,
  onShowQr,
  openSettings,
  setSidebarOpen,
  setPermissionMode,
  planModeSupported,
}: UseTauriMenuWiringArgs): void {
  const menuConnectToServer = useCallback(() => {
    // The dashboard's existing "connect to a different server" surface
    // is the Settings panel's Server Registry section. The menu item
    // opens Settings; the user picks a registry entry there.
    // #5544 — Settings now lives in the Control Room Settings tab.
    openSettings()
  }, [openSettings])
  const menuDisconnect = useCallback(() => {
    useConnectionStore.getState().disconnect()
  }, [])
  const menuToggleSidebar = useCallback(() => {
    setSidebarOpen(prev => !prev)
  }, [setSidebarOpen])
  const menuTogglePlanMode = useCallback(() => {
    const state = useConnectionStore.getState()
    const target = resolveTogglePlanModeTarget(
      state.permissionMode,
      state.previousPermissionMode,
      planModeSupported,
    )
    if (target !== null) setPermissionMode(target)
  }, [setPermissionMode, planModeSupported])
  const menuReload = useCallback(() => {
    window.location.reload()
  }, [])
  const menuOpenSettings = useCallback(() => {
    // #5544 — redirect to the Control Room Settings tab (the single home).
    openSettings()
  }, [openSettings])
  useTauriMenuEvents({
    onNewSession,
    onConnectToServer: menuConnectToServer,
    onDisconnect: menuDisconnect,
    onToggleSidebar: menuToggleSidebar,
    onTogglePlanMode: menuTogglePlanMode,
    onShowQr,
    onReload: menuReload,
    onTunnelSettings: menuOpenSettings,
    onPreferences: menuOpenSettings,
  })
}
