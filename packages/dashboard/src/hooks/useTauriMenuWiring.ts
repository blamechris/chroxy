import { useCallback } from 'react'
import { useConnectionStore } from '../store/connection'
import { useTauriMenuEvents } from './useTauriMenuEvents'

export interface UseTauriMenuWiringArgs {
  /** File > New Session — same callback the chrome "New Session" button uses. */
  onNewSession: () => void
  /** View > Show QR Code — same fetch the chrome "Show QR" affordance triggers. */
  onShowQr: () => void
  /** Opens the converged Settings surface (Control Room Settings tab, #5544). */
  openSettings: () => void
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>
  setPermissionMode: (mode: string) => void
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
 */
export function useTauriMenuWiring({
  onNewSession,
  onShowQr,
  openSettings,
  setSidebarOpen,
  setPermissionMode,
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
    if (state.permissionMode === 'plan') {
      setPermissionMode(state.previousPermissionMode || 'approve')
    } else {
      setPermissionMode('plan')
    }
  }, [setPermissionMode])
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
