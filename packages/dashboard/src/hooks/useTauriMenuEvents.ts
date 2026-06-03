/**
 * useTauriMenuEvents — bridge macOS menu-bar items to dashboard handlers (#4695).
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
 *   2. A new callback prop on this hook, wired in App.tsx.
 *
 * Why a separate hook (vs folding into `useTauriEvents`):
 *   - `useTauriEvents` mutates the Zustand connection store directly
 *     (it has no caller-provided callbacks). The menu actions need
 *     App-local state (`setShowCreateSession`), so they have to flow
 *     through props. Mixing the two would dilute `useTauriEvents`'s
 *     "store-only side effects" contract.
 *
 * No-op outside Tauri (e.g. plain browser dashboard).
 */
import { useEffect } from 'react'
import { getTauriListen } from '../utils/tauri-bridge'

type UnlistenFn = () => void

export interface TauriMenuHandlers {
  /** Triggered by `File > New Session` (id `app_menu:new-session`). */
  onNewSession: () => void
}

export function useTauriMenuEvents(handlers: TauriMenuHandlers): void {
  const { onNewSession } = handlers
  useEffect(() => {
    const listen = getTauriListen()
    if (!listen) return

    const unlisteners: Promise<UnlistenFn>[] = []

    unlisteners.push(
      listen('menu://new-session', () => {
        onNewSession()
      }),
    )

    return () => {
      unlisteners.forEach(p => p.then(fn => fn()).catch(() => {}))
    }
  }, [onNewSession])
}
