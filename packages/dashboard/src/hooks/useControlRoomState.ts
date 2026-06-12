import { useState, useEffect, useCallback } from 'react'
import type { ControlRoomTab } from '../components/ControlRoomView'
import type { SplitDirection } from '../components/SplitPane'
import { persistSplitMode, loadPersistedSplitMode } from '../store/persistence'

export interface ControlRoomState {
  /** Whether the pinned Control Room tab exists in the SessionBar strip. */
  controlRoomOpen: boolean
  /** Whether the Control Room is the focused view. */
  controlRoomActive: boolean
  setControlRoomActive: (active: boolean) => void
  /** Bumped to redirect an already-open Control Room to its Settings tab. */
  settingsRedirectNonce: number
  /** One-shot initial tab seed for a fresh Control Room mount. */
  controlRoomInitialTab: ControlRoomTab | undefined
  /** Legacy slide-out settings modal open flag (?settings=1 deep-link). */
  settingsOpen: boolean
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** Keyboard-shortcut cheat-sheet open flag. */
  shortcutHelpOpen: boolean
  setShortcutHelpOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** Split-view direction (persisted), or null when not split. */
  splitMode: SplitDirection | null
  setSplitMode: React.Dispatch<React.SetStateAction<SplitDirection | null>>
  openControlRoom: () => void
  openSettings: () => void
  closeControlRoom: () => void
}

/**
 * Owns the Control Room top-level tab (#5204), the converged Settings redirect
 * (#5544), the legacy settings modal + shortcut-help flags, and the split-view
 * mode (#5560). Split-view lives here because `openControlRoom` clears it.
 *
 * Pure move out of App.tsx — the open/close/settings callbacks, the one-shot
 * initial-tab clear effect (#5544), and every deps array are byte-identical to
 * the inline versions. `persistSplitMode`/`loadPersistedSplitMode` are imported
 * directly so App no longer wires them for this state.
 */
export function useControlRoomState(): ControlRoomState {
  const [settingsOpen, setSettingsOpen] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('settings') === '1'
  })
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  const [splitMode, setSplitMode] = useState<SplitDirection | null>(() => loadPersistedSplitMode())
  // #5204 — Control Room top-level tab. `controlRoomOpen` is whether the
  // pinned tab exists in the SessionBar strip; `controlRoomActive` is whether
  // it's the focused view. Both are local (not persisted) — opening the CR is
  // cheap (the host/repo snapshot lives in the store, so closing/reopening
  // doesn't wipe it) and it should not survive a reload. Switching to a
  // session deactivates it; switching back re-activates without re-fetching.
  const [controlRoomOpen, setControlRoomOpen] = useState(false)
  const [controlRoomActive, setControlRoomActive] = useState(false)
  const openControlRoom = useCallback(() => {
    setControlRoomOpen(true)
    setControlRoomActive(true)
    setSplitMode(null)
    persistSplitMode(null)
  }, [])
  // #5544 — the Control Room Settings tab is now the single home for the
  // preference surfaces that used to live in the slide-out SettingsPanel
  // modal. Two redirect paths converge on the Settings tab:
  //   - Control Room already open: bump `settingsRedirectNonce`, which
  //     ControlRoomView watches to switch tabs (even from another tab).
  //   - Control Room closed: mount ControlRoomView with `initialTab='settings'`
  //     so it opens straight onto Settings without a flash of another tab.
  // `controlRoomInitialTab` is a one-shot: cleared back to undefined right
  // after the open so a later sidebar "Control Room" click lands on the
  // operator's persisted tab, not Settings.
  const [settingsRedirectNonce, setSettingsRedirectNonce] = useState(0)
  const [controlRoomInitialTab, setControlRoomInitialTab] = useState<ControlRoomTab | undefined>(undefined)
  const openSettings = useCallback(() => {
    // The redirect must also dismiss the legacy modal (the `?settings=1`
    // deep-link can leave it open) — otherwise the tab switch happens behind
    // the overlay and the shortcut appears dead.
    setSettingsOpen(false)
    if (controlRoomActive) {
      // CR already visible — drive the redirect via the nonce instead.
      setSettingsRedirectNonce((n) => n + 1)
    } else {
      // CR is opening fresh — seed the initial tab so the mount lands on
      // Settings without a flash of another tab.
      setControlRoomInitialTab('settings')
    }
    openControlRoom()
  }, [controlRoomActive, openControlRoom])
  // #5544 — clear the one-shot initial-tab seed after the Control Room has
  // mounted with it. ControlRoomView only reads `initialTab` in its mount
  // initializer, so clearing it now is invisible to the live view but ensures
  // a later reopen (e.g. sidebar "Control Room") starts on the persisted tab.
  useEffect(() => {
    if (controlRoomActive && controlRoomInitialTab !== undefined) {
      setControlRoomInitialTab(undefined)
    }
  }, [controlRoomActive, controlRoomInitialTab])
  const closeControlRoom = useCallback(() => {
    // Closing is non-destructive: the tab disappears and we fall back to the
    // prior session (activeSessionId is untouched). The store-held snapshot
    // survives, so reopening re-renders from cache.
    setControlRoomOpen(false)
    setControlRoomActive(false)
  }, [])

  return {
    controlRoomOpen,
    controlRoomActive,
    setControlRoomActive,
    settingsRedirectNonce,
    controlRoomInitialTab,
    settingsOpen,
    setSettingsOpen,
    shortcutHelpOpen,
    setShortcutHelpOpen,
    splitMode,
    setSplitMode,
    openControlRoom,
    openSettings,
    closeControlRoom,
  }
}
