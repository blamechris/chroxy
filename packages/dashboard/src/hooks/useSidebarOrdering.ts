import { useState, useEffect, useCallback } from 'react'
import { useConnectionStore } from '../store/connection'
import {
  loadPersistedSidebarRepoOrder,
  loadPersistedSidebarSessionOrder,
  loadPersistedSessionTabOrder,
  loadPersistedSidebarRepoNames,
  persistSidebarRepoNames,
  persistSidebarRepoOrder,
  persistSidebarSessionOrder,
  persistSessionTabOrder,
} from '../store/persistence'

export interface SidebarOrdering {
  /** User-defined order for the SessionBar tab strip (#4831). */
  tabOrder: string[]
  /** User-defined order for the sidebar repo groups (#4832). */
  sidebarRepoOrder: string[]
  /** User-defined order for sessions within each sidebar repo group (#4832). */
  sidebarSessionOrder: Record<string, string[]>
  /** User-chosen sidebar repo-group labels keyed by group path (#7330). */
  sidebarRepoNames: Record<string, string>
  handleReorderTabs: (nextOrder: string[]) => void
  handleReorderRepos: (orderedPaths: string[]) => void
  handleReorderSidebarSessions: (repoPath: string, orderedIds: string[]) => void
  /**
   * Rename a sidebar repo group (#7330). A blank name removes the override so
   * the group shows its derived label again.
   */
  handleRenameRepo: (repoPath: string, name: string) => void
}

/**
 * Owns the three user-defined ordering overlays (#5560): the SessionBar tab
 * order (#4831) and the sidebar repo / per-repo session orders (#4832). Each is
 * layered on top of the server-supplied session list and persisted in
 * localStorage under the active server scope.
 *
 * Pure move out of App.tsx. The persistence layer is already server-scoped via
 * `scopedKey`/`scopedRead`, but the App-level state was initialised once on
 * mount and never re-read — so this hook keeps the two server-switch refresh
 * effects (#4831 / #4940) that re-load each order whenever `activeServerId`
 * changes. Setters/handlers and deps arrays are byte-identical to the inline
 * versions.
 */
export function useSidebarOrdering(): SidebarOrdering {
  // #4831 — user-defined SessionBar tab order (overlay on the server's
  // `sessions[]` membership). Loaded lazily from localStorage on mount and
  // re-persisted whenever the user drags / keyboard-reorders a tab.
  const [tabOrder, setTabOrder] = useState<string[]>(() => loadPersistedSessionTabOrder())
  // #4832 — user-defined order for the sidebar's repo groups and the sessions
  // inside each group. Both persisted in localStorage so they survive reload +
  // Tauri restart.
  const [sidebarRepoOrder, setSidebarRepoOrder] = useState<string[]>(() => loadPersistedSidebarRepoOrder())
  const [sidebarSessionOrder, setSidebarSessionOrder] = useState<Record<string, string[]>>(() => loadPersistedSidebarSessionOrder())

  // #7330 — user-chosen repo-group labels, persisted alongside the orders.
  const [sidebarRepoNames, setSidebarRepoNames] = useState<Record<string, string>>(() => loadPersistedSidebarRepoNames())

  // #4831 — `loadPersistedSessionTabOrder` reads under the *current* server
  // scope (set by `setServerScope` on server-switch). The initial `useState`
  // only fires once on mount, so without this effect a server switch in the
  // same browser tab would leave SessionBar showing the previous server's
  // tabOrder until a full page refresh. Re-load whenever the active server
  // changes so each server gets its own persisted order.
  const activeServerId = useConnectionStore(s => s.activeServerId)
  useEffect(() => {
    setTabOrder(loadPersistedSessionTabOrder())
  }, [activeServerId])
  // #4940 — same server-switch refresh for the sidebar repo / per-repo session
  // orders. The persistence layer is already server-scoped via
  // `scopedKey`/`scopedRead`, but the App-level state was initialised once and
  // never re-read. Without this effect, switching servers via the ServerPicker
  // left server A's drag-ordering applied to server B's sidebar until a full
  // page reload, silently bypassing the scoping.
  useEffect(() => {
    setSidebarRepoOrder(loadPersistedSidebarRepoOrder())
    setSidebarSessionOrder(loadPersistedSidebarSessionOrder())
    setSidebarRepoNames(loadPersistedSidebarRepoNames())
  }, [activeServerId])

  const handleReorderTabs = useCallback((nextOrder: string[]) => {
    setTabOrder(nextOrder)
    persistSessionTabOrder(nextOrder)
  }, [])

  // #4832 — reorder callbacks wired into the Sidebar component. Both persist
  // immediately so a reload (or Tauri restart) restores the order. We update
  // local state synchronously so the UI reflects the new order on the next
  // render without waiting for a round-trip.
  const handleReorderRepos = useCallback((orderedPaths: string[]) => {
    setSidebarRepoOrder(orderedPaths)
    persistSidebarRepoOrder(orderedPaths)
  }, [])

  const handleReorderSidebarSessions = useCallback((repoPath: string, orderedIds: string[]) => {
    setSidebarSessionOrder(prev => {
      const next = { ...prev, [repoPath]: orderedIds }
      persistSidebarSessionOrder(next)
      return next
    })
  }, [])

  const handleRenameRepo = useCallback((repoPath: string, name: string) => {
    const trimmed = name.trim()
    setSidebarRepoNames(prev => {
      if (trimmed === '') {
        if (!(repoPath in prev)) return prev
        const { [repoPath]: _dropped, ...rest } = prev
        persistSidebarRepoNames(rest)
        return rest
      }
      if (prev[repoPath] === trimmed) return prev
      const next = { ...prev, [repoPath]: trimmed }
      persistSidebarRepoNames(next)
      return next
    })
  }, [])

  return {
    tabOrder,
    sidebarRepoOrder,
    sidebarSessionOrder,
    sidebarRepoNames,
    handleReorderTabs,
    handleReorderRepos,
    handleReorderSidebarSessions,
    handleRenameRepo,
  }
}
