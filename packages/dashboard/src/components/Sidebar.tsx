/**
 * Sidebar — primary navigation for the desktop IDE.
 *
 * Shows repos with active/resumable sessions, filter, status footer.
 * Collapsible with Cmd+B toggle.
 */
import { useState, useCallback, useRef, useMemo } from 'react'
import type { CumulativeUsage, McpServer, SessionInfo, SessionVisualStatus, SessionRole, ChatActivityState } from '@chroxy/store-core'
import { formatCostBadge, formatCostBreakdown } from '@chroxy/store-core'
import { DEFAULT_PROVIDER } from '@chroxy/protocol'
import { useConnectionStore } from '../store/connection'
import { ConversationSearch } from './ConversationSearch'
import { ServerPicker } from './ServerPicker'
import { ViewersIndicator } from './ViewersIndicator'
import { SidebarPanelSlot, type SidebarPanelView, type SidebarPanelLauncher } from './SidebarPanelSlot'
import { SidebarTokenView, tokenViewCollapsedMetric } from './SidebarTokenView'
import { SidebarMcpView, mcpViewCollapsedMetric } from './SidebarMcpView'
import type { SearchResult, ConnectedClient, MonthlyBudgetState } from '../store/types'
import {
  persistSidebarPanelHeight,
  persistSidebarPanelView,
  persistSidebarPanelCollapsed,
} from '../store/persistence'
import { moveItem, orderToIds } from '../utils/reorderById'
import { useShortcutRegistry } from '../shortcuts/useShortcutRegistry'
import { formatBindingForAria } from '../shortcuts/registry'

export interface ActiveSessionNode {
  sessionId: string
  name: string
  isBusy: boolean
  status?: SessionVisualStatus
  provider?: string
  worktree?: boolean
  // #3567: latched stdin-forwarding-disabled flag from session_list
  // metadata. Surfaces a small badge on the sidebar row so the user
  // can spot disabled sessions without switching to them.
  stdinForwardingDisabled?: boolean
  // #4073: per-session running token + cost totals. The badge renders
  // only when `costUsd > 0` to avoid decoration on subscription-billed
  // sessions (where cost stays at 0 because result events emit null).
  cumulativeUsage?: CumulativeUsage | null
}

export interface ResumableSessionNode {
  conversationId: string
  preview: string | null
  modifiedAt: string
}

export interface RepoNode {
  path: string
  name: string
  source: 'auto' | 'manual'
  exists: boolean
  activeSessions: ActiveSessionNode[]
  resumableSessions: ResumableSessionNode[]
}

export interface ContextMenuTarget {
  type: 'repo' | 'session' | 'resumable'
  path?: string
  sessionId?: string
  conversationId?: string
}

export interface SidebarProps {
  repos: RepoNode[]
  activeSessionId: string | null
  isOpen: boolean
  width: number
  filter: string
  serverStatus: 'connected' | 'disconnected' | 'reconnecting'
  /** #6418 — active session's chat-activity state. The connection dots breathe
      (busyPulse) while it's thinking/busy/waiting, mirroring the header+footer
      dots (#6415). Connection colour stays serverStatus-driven. */
  chatActivityState?: ChatActivityState
  tunnelUrl: string | null
  /** #5281 ①.3 — all clients attached to the daemon, for the shared-session
      presence indicator in the footer. */
  connectedClients: ConnectedClient[]
  /** Active session's primary (last-driver) client id, or null. */
  activePrimaryClientId: string | null
  /** #5589 / #5281 — this client's explicit role for the active session. */
  activeSessionRole?: SessionRole | null
  /** #5589 / #5281 — force-claim primary for the active session (take over). */
  onTakeOverPrimary?: () => void
  onFilterChange: (value: string) => void
  onSessionClick: (sessionId: string) => void
  onResumeSession: (conversationId: string, cwd?: string) => void
  onNewSession: (cwd: string) => void
  onToggle: () => void
  onContextMenu: (target: ContextMenuTarget, event: React.MouseEvent) => void
  searchResults?: SearchResult[]
  searchLoading?: boolean
  searchQuery?: string
  searchConversations?: (query: string) => void
  clearSearchResults?: () => void
  onWidthChange?: (width: number) => void
  // #4303 — full sessions list (used by the bottom slot's token view).
  // Optional so existing tests + callers don't break; defaults to [].
  sessions?: SessionInfo[]
  // #5665 — machine-wide monthly programmatic-credit meter snapshot, passed
  // through to the token view. Optional; null/omitted → no meter.
  monthlyBudget?: MonthlyBudgetState | null
  // #4303 — initial state for the bottom panel slot (loaded from
  // localStorage in App.tsx; defaults applied here).
  initialPanelHeight?: number
  initialPanelView?: string | null
  initialPanelCollapsed?: boolean
  // #4832 — drag-to-reorder callbacks. The sidebar fires these with the
  // FULL post-move id arrays (not deltas) so the parent can persist the
  // new order in a single `localStorage.setItem`. Both are optional so
  // tests + callers that don't care about reordering don't have to wire
  // them up.
  onReorderRepos?: (orderedRepoPaths: string[]) => void
  onReorderSessions?: (repoPath: string, orderedSessionIds: string[]) => void
  // #5200 — open the Control Room (a wide host/repo table) in the main
  // content area, launched from the bottom panel slot's header. Optional so
  // existing tests/callers don't need to wire it.
  onOpenControlRoom?: () => void
}

function abbreviateTunnel(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// #6820 — stable empty array so the active-session MCP selector's fallback keeps
// a referentially-stable identity across renders (avoids render loops).
const EMPTY_MCP_SERVERS: McpServer[] = []

export function Sidebar({
  repos,
  activeSessionId,
  isOpen,
  width,
  filter,
  serverStatus,
  chatActivityState,
  tunnelUrl,
  connectedClients,
  activePrimaryClientId,
  activeSessionRole,
  onTakeOverPrimary,
  onFilterChange,
  onSessionClick,
  onResumeSession,
  onNewSession,
  onToggle,
  onContextMenu,
  searchResults = [],
  searchLoading = false,
  searchQuery = '',
  searchConversations,
  clearSearchResults,
  onWidthChange,
  sessions = [],
  monthlyBudget = null,
  initialPanelHeight = 200,
  initialPanelView = null,
  initialPanelCollapsed = false,
  onReorderRepos,
  onReorderSessions,
  onOpenControlRoom,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [focusedIndex, setFocusedIndex] = useState(0)
  const treeRef = useRef<HTMLDivElement>(null)
  // #4972 — Sidebar reorder ladder now consults the registry so a user
  // rebind in Settings actually changes runtime behaviour. The aria-
  // keyshortcuts attribute also reads from the registry so screen
  // readers announce the effective binding instead of the hardcoded
  // default. The hook re-renders on every binding change.
  //
  // `aria-keyshortcuts` is platform-neutral per WAI-ARIA 1.2: it uses
  // spec modifier names ("Meta", "Control") not UI labels ("Cmd",
  // "Ctrl"), and multiple alternative combos are space-separated.
  const shortcutRegistry = useShortcutRegistry()
  const reorderUpBinding = shortcutRegistry.getBinding('sidebar.reorder.up')
  const reorderDownBinding = shortcutRegistry.getBinding('sidebar.reorder.down')
  const reorderAriaKeyshortcuts = `${formatBindingForAria(reorderUpBinding)} ${formatBindingForAria(reorderDownBinding)}`

  // #4303 — sidebar panel slot state. Initialized from localStorage via
  // props so SSR / tests stay deterministic. Each setter mirrors to
  // localStorage so the panel survives reloads.
  const [panelHeight, setPanelHeightState] = useState(initialPanelHeight)
  const [panelView, setPanelViewState] = useState<string | null>(initialPanelView ?? 'tokens')
  const [panelCollapsed, setPanelCollapsedState] = useState(initialPanelCollapsed)

  const handlePanelHeightChange = useCallback((next: number) => {
    setPanelHeightState(next)
    persistSidebarPanelHeight(next)
  }, [])

  const handlePanelViewChange = useCallback((next: string) => {
    setPanelViewState(next)
    persistSidebarPanelView(next)
  }, [])

  const handlePanelCollapsedChange = useCallback((next: boolean) => {
    setPanelCollapsedState(next)
    persistSidebarPanelCollapsed(next)
  }, [])

  // #6820 — active session's MCP servers, for the read-only "MCP" panel view
  // and its collapsed-header metric. Reads the same store field the mobile
  // SettingsBar renders (written by the `mcp_servers` broadcast handler); the
  // stable EMPTY_MCP_SERVERS fallback keeps a referentially-stable identity.
  const activeMcpServers = useConnectionStore((s) => {
    const id = s.activeSessionId
    return id && s.sessionStates[id] ? s.sessionStates[id].mcpServers : EMPTY_MCP_SERVERS
  })

  // #4303 — view registry. Order here = order in the tab strip. Adding a
  // future view (skills, etc.) is a one-entry append.
  const panelViews = useMemo<SidebarPanelView[]>(() => ([
    {
      id: 'tokens',
      label: 'Tokens',
      render: () => (
        <SidebarTokenView
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSessionClick={onSessionClick}
          monthlyBudget={monthlyBudget}
        />
      ),
      collapsedHeaderMetric: () => tokenViewCollapsedMetric(sessions),
    },
    // #6820 — read-only MCP server list for the active session (name + status),
    // the desktop analogue of the mobile SettingsBar "MCP Servers (N)" section.
    {
      id: 'mcp',
      label: 'MCP',
      render: () => <SidebarMcpView servers={activeMcpServers} />,
      collapsedHeaderMetric: () => mcpViewCollapsedMetric(activeMcpServers),
    },
    // #5176 (epic #5170) — the Control Room v1 sidebar panel was retired here;
    // the per-session activity tree now drills down inside the main-tab
    // ControlRoomSection (mapped repo → active session → activity tree).
  ]), [sessions, activeSessionId, onSessionClick, monthlyBudget, activeMcpServers])

  // #5200 — Control Room launcher in the slot header. The host/repo table is
  // wide, so the launcher opens it in the main content area (via
  // onOpenControlRoom) rather than rendering in the narrow slot.
  const panelLaunchers = useMemo<SidebarPanelLauncher[]>(() => (
    onOpenControlRoom
      ? [{ id: 'control-room', label: 'Control Room', title: 'Open the Control Room', onClick: onOpenControlRoom }]
      : []
  ), [onOpenControlRoom])

  const toggleRepo = useCallback((path: string) => {
    setCollapsed(prev => ({ ...prev, [path]: !prev[path] }))
  }, [])

  // Hoisted above the #4832 drag handlers below so their useCallback
  // dependency arrays (which reference filteredRepos) sit outside the TDZ.
  const filteredRepos = filter
    ? repos
        .map(r => {
          const lf = filter.toLowerCase()
          const matchesRepoName = r.name.toLowerCase().includes(lf)
          const filteredActive = r.activeSessions.filter(s =>
            s.name.toLowerCase().includes(lf),
          )
          const filteredResumable = r.resumableSessions.filter(s =>
            (s.preview ?? '').toLowerCase().includes(lf),
          )
          const hasMatchingChild = filteredActive.length > 0 || filteredResumable.length > 0
          if (!matchesRepoName && !hasMatchingChild) return null
          return {
            ...r,
            activeSessions: matchesRepoName ? r.activeSessions : filteredActive,
            resumableSessions: matchesRepoName ? r.resumableSessions : filteredResumable,
          }
        })
        .filter((r): r is RepoNode => r !== null)
    : repos

  // #4832 — drag-to-reorder state. We track the dragged item identity and
  // the current drop target separately:
  //
  //   - `dragRepo` / `dragSession` carry the id of the item currently being
  //     dragged. Set in `onDragStart`, cleared in `onDragEnd`. Used to
  //     filter `onDragOver` events so we ignore drags that started on a
  //     mismatched scope (e.g. a session row should not respond to a repo
  //     drag, and vice versa).
  //   - `dragOverRepo` / `dragOverSession` carry the id of the row the
  //     cursor is currently hovering during a drag, plus a 'before' /
  //     'after' position derived from the cursor's vertical midpoint. This
  //     drives the drop-indicator CSS class on the target row.
  //
  // Cross-group session drags are disallowed (sessions are pinned to their
  // owning repo by metadata, per the issue's "out of scope" notes), so the
  // session drop handlers only respond when the drag started inside the
  // same repo.
  const [dragRepo, setDragRepo] = useState<string | null>(null)
  const [dragOverRepo, setDragOverRepo] = useState<{ path: string; position: 'before' | 'after' } | null>(null)
  const [dragSession, setDragSession] = useState<{ repoPath: string; sessionId: string } | null>(null)
  const [dragOverSession, setDragOverSession] = useState<{ repoPath: string; sessionId: string; position: 'before' | 'after' } | null>(null)

  /**
   * Decide whether the cursor is above or below the row's vertical midpoint.
   * Used to render a single thin drop-indicator line at the top OR bottom
   * edge — the more conventional pattern than a thick highlight, and matches
   * VS Code / Linear.
   */
  const dropPosition = useCallback((event: React.DragEvent<HTMLElement>): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    return event.clientY < midY ? 'before' : 'after'
  }, [])

  const handleRepoDragStart = useCallback((path: string) => (event: React.DragEvent<HTMLElement>) => {
    if (!onReorderRepos) return
    // dataTransfer payload — required by Firefox for the drag to fire at
    // all. Setting effectAllowed='move' shows the move cursor.
    event.dataTransfer.effectAllowed = 'move'
    try { event.dataTransfer.setData('text/plain', path) } catch { /* SSR / jsdom no-op */ }
    setDragRepo(path)
  }, [onReorderRepos])

  const handleRepoDragOver = useCallback((path: string) => (event: React.DragEvent<HTMLElement>) => {
    if (!onReorderRepos || dragRepo === null) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const pos = dropPosition(event)
    setDragOverRepo(prev => prev && prev.path === path && prev.position === pos ? prev : { path, position: pos })
  }, [onReorderRepos, dragRepo, dropPosition])

  const handleRepoDragLeave = useCallback((path: string) => () => {
    setDragOverRepo(prev => prev && prev.path === path ? null : prev)
  }, [])

  const handleRepoDrop = useCallback((targetPath: string) => (event: React.DragEvent<HTMLElement>) => {
    if (!onReorderRepos || dragRepo === null) return
    event.preventDefault()
    const pos = dropPosition(event)
    setDragRepo(null)
    setDragOverRepo(null)
    if (dragRepo === targetPath) return
    const paths = filteredRepos.map(r => r.path)
    const fromIdx = paths.indexOf(dragRepo)
    const targetIdx = paths.indexOf(targetPath)
    if (fromIdx < 0 || targetIdx < 0) return
    // 'after' means the dragged item lands AFTER target; convert to splice
    // index. If we're moving forward and dropping after, the post-removal
    // target index doesn't need a +1 bump (splice removes first), so we
    // just use the target index when 'before' and target+1 when 'after',
    // then let moveItem normalize.
    let toIdx = pos === 'before' ? targetIdx : targetIdx + 1
    if (fromIdx < toIdx) toIdx -= 1
    const next = moveItem(paths, fromIdx, toIdx)
    onReorderRepos(next)
  }, [onReorderRepos, dragRepo, dropPosition, filteredRepos])

  const handleRepoDragEnd = useCallback(() => {
    setDragRepo(null)
    setDragOverRepo(null)
  }, [])

  const handleSessionDragStart = useCallback(
    (repoPath: string, sessionId: string) => (event: React.DragEvent<HTMLElement>) => {
      if (!onReorderSessions) return
      event.dataTransfer.effectAllowed = 'move'
      try { event.dataTransfer.setData('text/plain', sessionId) } catch { /* jsdom no-op */ }
      // stopPropagation so the parent repo treeitem's drag handlers don't
      // also fire (the outer treeitem is the drop target for repo
      // reordering — a session drag started inside it would otherwise be
      // mistaken for a repo drag).
      event.stopPropagation()
      setDragSession({ repoPath, sessionId })
    },
    [onReorderSessions],
  )

  const handleSessionDragOver = useCallback(
    (repoPath: string, sessionId: string) => (event: React.DragEvent<HTMLElement>) => {
      if (!onReorderSessions || dragSession === null) return
      // Only respond to drags that started in the same repo — cross-group
      // moves are out of scope (per the issue).
      if (dragSession.repoPath !== repoPath) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      const pos = dropPosition(event)
      setDragOverSession(prev =>
        prev && prev.sessionId === sessionId && prev.position === pos && prev.repoPath === repoPath
          ? prev
          : { repoPath, sessionId, position: pos },
      )
    },
    [onReorderSessions, dragSession, dropPosition],
  )

  const handleSessionDragLeave = useCallback(
    (sessionId: string) => () => {
      setDragOverSession(prev => prev && prev.sessionId === sessionId ? null : prev)
    },
    [],
  )

  const handleSessionDrop = useCallback(
    (repoPath: string, targetSessionId: string) => (event: React.DragEvent<HTMLElement>) => {
      if (!onReorderSessions || dragSession === null) return
      if (dragSession.repoPath !== repoPath) return
      event.preventDefault()
      event.stopPropagation()
      const pos = dropPosition(event)
      const dragged = dragSession.sessionId
      setDragSession(null)
      setDragOverSession(null)
      if (dragged === targetSessionId) return
      const repo = filteredRepos.find(r => r.path === repoPath)
      if (!repo) return
      const ids = orderToIds(repo.activeSessions, s => s.sessionId)
      const fromIdx = ids.indexOf(dragged)
      const targetIdx = ids.indexOf(targetSessionId)
      if (fromIdx < 0 || targetIdx < 0) return
      let toIdx = pos === 'before' ? targetIdx : targetIdx + 1
      if (fromIdx < toIdx) toIdx -= 1
      const next = moveItem(ids, fromIdx, toIdx)
      onReorderSessions(repoPath, next)
    },
    [onReorderSessions, dragSession, dropPosition, filteredRepos],
  )

  const handleSessionDragEnd = useCallback(() => {
    setDragSession(null)
    setDragOverSession(null)
  }, [])

  /**
   * Keyboard reordering — Alt+ArrowUp / Alt+ArrowDown. The Alt modifier
   * avoids clobbering plain ArrowUp/ArrowDown (which the WAI-ARIA tree
   * pattern uses for focus traversal — see handleTreeKeyDown below).
   *
   * Repo rows reorder the top-level repo list; session rows reorder
   * within their owning repo. Returns true when the key was handled so
   * the row handler can stopPropagation + preventDefault, blocking the
   * tree-level handler from also processing the same keypress.
   */
  const handleRepoReorderKey = useCallback(
    (path: string) => (event: React.KeyboardEvent<HTMLElement>): boolean => {
      if (!onReorderRepos) return false
      // Mirror the drag guard (`draggable={... && !filter}`) — reordering
      // from a filtered view would persist an order derived from the
      // visible subset, silently shuffling hidden repos relative to each
      // other. Disable the keyboard reorder shortcut while filtering too.
      if (filter) return false
      // #4972 — match via registry so a user rebind in Settings actually
      // changes the runtime keys. The direction is derived from the
      // matched id, not from event.key, so a rebind like cmd+j/cmd+k
      // works as well as the default alt+arrowup/down.
      // matchEvent's KeyEventLike is structural; React's KeyboardEvent
      // satisfies it directly (no DOM cast needed).
      const matched = shortcutRegistry.matchEvent(event, 'global')
      const dir = matched === 'sidebar.reorder.up' ? -1
        : matched === 'sidebar.reorder.down' ? 1
        : 0
      if (dir === 0) return false
      const paths = filteredRepos.map(r => r.path)
      const idx = paths.indexOf(path)
      if (idx < 0) return false
      const target = idx + dir
      if (target < 0 || target >= paths.length) return true // swallow, no-op at edges
      const next = moveItem(paths, idx, target)
      onReorderRepos(next)
      return true
    },
    [onReorderRepos, filteredRepos, filter, shortcutRegistry],
  )

  const handleSessionReorderKey = useCallback(
    (repoPath: string, sessionId: string) => (event: React.KeyboardEvent<HTMLElement>): boolean => {
      if (!onReorderSessions) return false
      // Same rationale as handleRepoReorderKey: filtered subset would
      // produce a partial persisted order.
      if (filter) return false
      // #4972 — match via registry; see handleRepoReorderKey rationale.
      // React KeyboardEvent structurally satisfies KeyEventLike.
      const matched = shortcutRegistry.matchEvent(event, 'global')
      const dir = matched === 'sidebar.reorder.up' ? -1
        : matched === 'sidebar.reorder.down' ? 1
        : 0
      if (dir === 0) return false
      const repo = filteredRepos.find(r => r.path === repoPath)
      if (!repo) return false
      const ids = orderToIds(repo.activeSessions, s => s.sessionId)
      const idx = ids.indexOf(sessionId)
      if (idx < 0) return false
      const target = idx + dir
      if (target < 0 || target >= ids.length) return true
      const next = moveItem(ids, idx, target)
      onReorderSessions(repoPath, next)
      return true
    },
    [onReorderSessions, filteredRepos, filter, shortcutRegistry],
  )

  // Resize handle drag logic
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(width)

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    startX.current = e.clientX
    startWidth.current = width

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const delta = ev.clientX - startX.current
      const newWidth = Math.min(480, Math.max(160, startWidth.current + delta))
      onWidthChange?.(newWidth)
    }

    const onMouseUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [width, onWidthChange])

  // Get all visible treeitem elements for keyboard navigation
  const getVisibleItems = useCallback((): HTMLElement[] => {
    if (!treeRef.current) return []
    return Array.from(treeRef.current.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(el => {
      const group = el.closest('[role="group"]')
      if (!group) return true
      const parent = group.closest('[role="treeitem"]')
      return !parent || parent.getAttribute('aria-expanded') !== 'false'
    })
  }, [])

  // #4392: a11y — invoke the sidebar context menu via keyboard. PR #4369
  // added arrow-key nav WITHIN the open menu, #4372 returned focus to the
  // row on close. This is the missing third leg: keyboard users navigating
  // the sidebar (Tab/ArrowDown) couldn't OPEN the menu without a mouse.
  //
  // Two platform-standard shortcuts:
  //   - `ContextMenu` key (dedicated menu key on most PC keyboards)
  //   - Shift+F10 (Windows/Linux convention; harmless on macOS where the
  //     key normally only adjusts speaker volume — Shift+F10 isn't bound)
  //
  // The handler synthesizes a position from the row's bounding rect
  // (right-edge center) and forwards a MouseEvent-shaped payload to the
  // existing onContextMenu prop. App.tsx reads `clientX/clientY` and
  // `currentTarget.focus()` from the event — both are stubbed here so the
  // keyboard path lights up the same code as a real right-click.
  const invokeContextMenuFromKey = useCallback((
    e: React.KeyboardEvent<HTMLElement>,
    target: ContextMenuTarget,
  ) => {
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return
    e.preventDefault()
    e.stopPropagation()
    const row = e.currentTarget
    const rect = row.getBoundingClientRect()
    // Right-edge center: places the menu's top-left near the visible
    // right side of the row, which lines up well with a left-to-right
    // sidebar where the menu opens into the editor area.
    const x = rect.right - 10
    const y = rect.top + rect.height / 2
    const synthetic = {
      clientX: x,
      clientY: y,
      currentTarget: row,
      target: row,
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
      nativeEvent: e.nativeEvent,
    } as unknown as React.MouseEvent
    onContextMenu(target, synthetic)
  }, [onContextMenu])

  // Keyboard handler for WAI-ARIA TreeView pattern
  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = getVisibleItems()
    if (items.length === 0) return

    const focused = document.activeElement as HTMLElement
    const currentIdx = items.indexOf(focused)
    if (currentIdx < 0) return

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = Math.min(currentIdx + 1, items.length - 1)
        items[next]!.focus()
        setFocusedIndex(next)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prev = Math.max(currentIdx - 1, 0)
        items[prev]!.focus()
        setFocusedIndex(prev)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        const item = items[currentIdx]!
        if (item.getAttribute('aria-expanded') === 'false') {
          // Expand collapsed repo
          const repoPath = item.querySelector('[data-testid^="repo-header-"]')?.getAttribute('data-testid')?.replace('repo-header-', '')
          if (repoPath) setCollapsed(prev => ({ ...prev, [repoPath]: false }))
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        const item = items[currentIdx]!
        if (item.getAttribute('aria-expanded') === 'true') {
          // Collapse expanded repo
          const repoPath = item.querySelector('[data-testid^="repo-header-"]')?.getAttribute('data-testid')?.replace('repo-header-', '')
          if (repoPath) setCollapsed(prev => ({ ...prev, [repoPath]: true }))
        }
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        focused.click()
        break
      }
      case 'Home': {
        e.preventDefault()
        items[0]!.focus()
        setFocusedIndex(0)
        break
      }
      case 'End': {
        e.preventDefault()
        items[items.length - 1]!.focus()
        setFocusedIndex(items.length - 1)
        break
      }
    }
  }, [getVisibleItems, setCollapsed])

  // Build a flat list of treeitem IDs for tabIndex assignment
  const flatItemIds = useCallback((): string[] => {
    const ids: string[] = []
    for (const repo of filteredRepos) {
      ids.push(`repo:${repo.path}`)
      const isCollapsed = filter ? false : (collapsed[repo.path] ?? false)
      if (!isCollapsed) {
        for (const s of repo.activeSessions) ids.push(`session:${s.sessionId}`)
        for (const c of repo.resumableSessions) ids.push(`resumable:${c.conversationId}`)
      }
    }
    return ids
  }, [filteredRepos, collapsed, filter])

  const visibleIds = flatItemIds()

  const statusLabel = serverStatus === 'connected' ? 'Running'
    : serverStatus === 'reconnecting' ? 'Reconnecting'
    : 'Stopped'

  return (
    <aside
      className={`sidebar${isOpen ? '' : ' collapsed'}`}
      style={isOpen ? { width } : undefined}
      data-testid="sidebar"
    >
      {/* Toggle button */}
      <button
        className="sidebar-toggle"
        data-testid="sidebar-toggle"
        onClick={onToggle}
        aria-label={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        type="button"
      >
        {isOpen ? '\u25C0' : '\u25B6'}
      </button>

      {isOpen && (
        <>
          {/* Filter */}
          <div className="sidebar-filter">
            <input
              type="text"
              placeholder="Filter..."
              value={filter}
              onChange={e => onFilterChange(e.target.value)}
              className="sidebar-filter-input"
            />
          </div>

          {/* Conversation search */}
          {searchConversations && clearSearchResults && (
            <ConversationSearch
              searchResults={searchResults}
              searchLoading={searchLoading}
              searchQuery={searchQuery}
              searchConversations={searchConversations}
              clearSearchResults={clearSearchResults}
              onResumeSession={(convId, cwd) => onResumeSession(convId, cwd)}
            />
          )}

          {/* #5183 — Projects/explorer header. Surfaces the daemon Running
              state (reusing the same `serverStatus` signal the footer uses)
              at the top of the left explorer where the user looks first,
              not just buried in the footer. */}
          <div className="sidebar-projects-header" data-testid="sidebar-projects-header">
            <span className="sidebar-projects-title">Projects</span>
            <span
              className={`sidebar-status-dot ${serverStatus}`}
              data-activity={serverStatus === 'connected' ? chatActivityState : undefined}
              data-testid="sidebar-projects-status-dot"
              // Decorative — the adjacent status label already announces the
              // state, so hide the dot from screen readers to avoid a
              // redundant/ambiguous announcement (Copilot review).
              aria-hidden="true"
              // Reuse the SAME tooltip wording as the footer dot so the two
              // indicators don't disagree when both are visible (Copilot
              // review).
              title={
                serverStatus === 'connected' ? 'Server connected'
                  : serverStatus === 'reconnecting' ? 'Reconnecting to server...'
                    : 'Server disconnected'
              }
            />
            <span className="sidebar-projects-status-label">{statusLabel}</span>
          </div>

          {/* Repo tree */}
          <div className="sidebar-tree" role="tree" aria-label="Repository sessions" ref={treeRef} onKeyDown={handleTreeKeyDown}>
            {filteredRepos.map(repo => {
              const isCollapsed = filter ? false : (collapsed[repo.path] ?? false)
              const repoDragOver = dragOverRepo?.path === repo.path ? dragOverRepo.position : null
              const repoClass = `sidebar-repo${dragRepo === repo.path ? ' dragging' : ''}${repoDragOver ? ` drop-${repoDragOver}` : ''}`
              return (
                <div
                  key={repo.path}
                  className={repoClass}
                  role="treeitem"
                  aria-expanded={!isCollapsed}
                  // #4832: only enable drag when reorder is wired AND no
                  // filter is applied. Reordering during an active filter is
                  // ambiguous (the on-screen list is a subset of the real
                  // order) and would persist a confusing order; gate it off.
                  draggable={!!onReorderRepos && !filter}
                  data-testid={`sidebar-repo-${repo.path}`}
                  data-drop-position={repoDragOver ?? undefined}
                  tabIndex={visibleIds.indexOf(`repo:${repo.path}`) === focusedIndex ? 0 : -1}
                  // #4941: surface the Alt+ArrowUp/Down keyboard reorder
                  // shortcut for screen readers and assistive tech. Only
                  // set when reorder is actually wired (callback present
                  // AND no filter active) so the announced shortcut
                  // doesn't lie when the row isn't actually reorderable.
                  // The space-separated multi-combo format follows the
                  // WAI-ARIA spec.
                  //
                  // #4972: built from the registry's effective binding so a
                  // user rebind in Settings flows through to the SR
                  // announcement, not just the cheat sheet.
                  aria-keyshortcuts={!!onReorderRepos && !filter ? reorderAriaKeyshortcuts : undefined}
                  // #4372: bind onContextMenu on the outer treeitem (not the
                  // inner .sidebar-repo-header) so that App's handler can
                  // call `event.currentTarget.focus()` on a focusable element.
                  // The header is a bare <div> without tabIndex/role, so a
                  // focus() call on it would be a no-op and leave
                  // document.activeElement on <body>.
                  onContextMenu={e => {
                    e.preventDefault()
                    onContextMenu({ type: 'repo', path: repo.path }, e)
                  }}
                  // #4392: keyboard invocation of the context menu via the
                  // ContextMenu key or Shift+F10. invokeContextMenuFromKey
                  // is a no-op for any other key, so this does not
                  // interfere with the tree-level arrow nav.
                  // #4832: Alt+ArrowUp/Down keyboard reorder is checked
                  // first; when handled it stops propagation so the
                  // tree-level arrow-nav handler doesn't ALSO move focus.
                  onKeyDown={e => {
                    if (handleRepoReorderKey(repo.path)(e)) {
                      e.preventDefault()
                      e.stopPropagation()
                      return
                    }
                    invokeContextMenuFromKey(e, { type: 'repo', path: repo.path })
                  }}
                  onDragStart={handleRepoDragStart(repo.path)}
                  onDragOver={handleRepoDragOver(repo.path)}
                  onDragLeave={handleRepoDragLeave(repo.path)}
                  onDrop={handleRepoDrop(repo.path)}
                  onDragEnd={handleRepoDragEnd}
                >
                  <div
                    className={`sidebar-repo-header${!repo.exists ? ' missing' : ''}`}
                    data-testid={`repo-header-${repo.path}`}
                    onClick={() => toggleRepo(repo.path)}
                  >
                    <span className="sidebar-chevron">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
                    <span className="sidebar-repo-name">{repo.name}</span>
                    {repo.source === 'manual' && (
                      <span className="sidebar-repo-badge">pinned</span>
                    )}
                    <button
                      className="sidebar-repo-new-session"
                      data-testid={`sidebar-new-session-${repo.path}`}
                      onClick={e => {
                        e.stopPropagation()
                        onNewSession(repo.path)
                      }}
                      aria-label={`New session in ${repo.name}`}
                      type="button"
                    >
                      +
                    </button>
                  </div>

                  {!isCollapsed && (
                    <div className="sidebar-repo-children" role="group">
                      {/* Active sessions */}
                      {repo.activeSessions.map(session => {
                        const status = session.status ?? (session.isBusy ? 'working' : 'idle')
                        const statusTitle = status === 'working'
                          ? 'Session working — response, tool, or agent active'
                          : status === 'stale'
                            ? 'Session stale — idle for 1 hour or more'
                            : 'Session idle — ready for input'
                        const isDraggingThis = dragSession?.sessionId === session.sessionId
                        const sessionDragOver = dragOverSession?.sessionId === session.sessionId ? dragOverSession.position : null
                        const sessionItemClass = `sidebar-session-item${activeSessionId === session.sessionId ? ' active' : ''}${isDraggingThis ? ' dragging' : ''}${sessionDragOver ? ` drop-${sessionDragOver}` : ''}`
                        return (
                          <div
                            key={session.sessionId}
                            role="treeitem"
                            aria-selected={activeSessionId === session.sessionId}
                            tabIndex={visibleIds.indexOf(`session:${session.sessionId}`) === focusedIndex ? 0 : -1}
                            className={sessionItemClass}
                            data-testid={`session-item-${session.sessionId}`}
                            // #4832: same filter guard as repo rows — order
                            // changes during a filter would persist a
                            // confusing partial ordering.
                            draggable={!!onReorderSessions && !filter}
                            data-drop-position={sessionDragOver ?? undefined}
                            // #4941: see the matching repo-row attribute
                            // above — same rationale (discoverability for
                            // assistive tech, only set when the shortcut
                            // is functionally wired on this row).
                            aria-keyshortcuts={!!onReorderSessions && !filter ? reorderAriaKeyshortcuts : undefined}
                            onClick={() => onSessionClick(session.sessionId)}
                            onContextMenu={e => {
                              // #4372: stopPropagation so the right-click
                              // does not bubble to the outer .sidebar-repo
                              // treeitem (which also listens since the fix).
                              // Without this the App handler fires twice and
                              // the *outer* listener wins for focus(),
                              // landing focus on the repo wrapper instead of
                              // the session row.
                              e.preventDefault()
                              e.stopPropagation()
                              onContextMenu({ type: 'session', sessionId: session.sessionId }, e)
                            }}
                            // #4392: keyboard invocation (ContextMenu /
                            // Shift+F10). stopPropagation inside the helper
                            // keeps the event from also reaching the outer
                            // repo treeitem's onKeyDown.
                            // #4832: Alt+ArrowUp/Down keyboard reorder runs
                            // first; when handled, stopPropagation +
                            // preventDefault block both the parent repo
                            // treeitem's reorder handler AND the
                            // tree-level focus traversal.
                            onKeyDown={e => {
                              if (handleSessionReorderKey(repo.path, session.sessionId)(e)) {
                                e.preventDefault()
                                e.stopPropagation()
                                return
                              }
                              invokeContextMenuFromKey(e, { type: 'session', sessionId: session.sessionId })
                            }}
                            onDragStart={handleSessionDragStart(repo.path, session.sessionId)}
                            onDragOver={handleSessionDragOver(repo.path, session.sessionId)}
                            onDragLeave={handleSessionDragLeave(session.sessionId)}
                            onDrop={handleSessionDrop(repo.path, session.sessionId)}
                            onDragEnd={handleSessionDragEnd}
                          >
                            <span className={`sidebar-session-dot status-${status}`} title={statusTitle} />
                            <span className="sidebar-session-name">{session.name}</span>
                            {session.worktree && (
                              <span className="sidebar-worktree-badge" title="Isolated git worktree">
                                W
                              </span>
                            )}
                            {session.provider && session.provider !== DEFAULT_PROVIDER && (
                              <span className="sidebar-provider-badge" title={session.provider}>
                                {session.provider.replace(/^claude-/, '').toUpperCase()}
                              </span>
                            )}
                            {session.stdinForwardingDisabled && (
                              // role="img" + aria-label is the dashboard
                              // convention for icon-only badges (see
                              // SkillsPanel.tsx). A bare span carrying
                              // aria-label is not consistently announced
                              // by screen readers.
                              <span
                                className="sidebar-stdin-disabled-badge"
                                data-testid={`sidebar-stdin-disabled-${session.sessionId}`}
                                role="img"
                                title="Stdin forwarding lost — restart this session"
                                aria-label="Stdin forwarding disabled"
                              >
                                !
                              </span>
                            )}
                            {session.cumulativeUsage && session.cumulativeUsage.costUsd > 0 && (
                              // #4073: cost badge. Only render when
                              // costUsd > 0 — subscription-billed sessions
                              // (claude-tui) leave it at 0 and shouldn't
                              // get decoration. Hover shows the full
                              // breakdown via the dashboard's standard
                              // native-title popover pattern.
                              <span
                                className="sidebar-cost-badge"
                                data-testid={`sidebar-cost-badge-${session.sessionId}`}
                                title={formatCostBreakdown(session.cumulativeUsage)}
                                aria-label={`Session cost ${formatCostBadge(session.cumulativeUsage.costUsd)}`}
                              >
                                {formatCostBadge(session.cumulativeUsage.costUsd)}
                              </span>
                            )}
                          </div>
                        )
                      })}

                      {/* Resumable sessions */}
                      {repo.resumableSessions.map(conv => (
                        <div
                          key={conv.conversationId}
                          role="treeitem"
                          aria-selected={false}
                          tabIndex={visibleIds.indexOf(`resumable:${conv.conversationId}`) === focusedIndex ? 0 : -1}
                          className="sidebar-resumable-item"
                          data-testid={`resumable-item-${conv.conversationId}`}
                          // #4939: resumable rows sit inside the outer
                          // .sidebar-repo treeitem which becomes
                          // draggable=true once onReorderRepos is wired.
                          // HTML5 drag-and-drop bubbles, so without an
                          // explicit guard here a click-and-drag on this
                          // row would start the PARENT repo's drag
                          // (visual + reorder side-effect both wrong).
                          // draggable=false marks this child as a drag
                          // source no-op, and stopPropagation on
                          // dragstart prevents the event reaching the
                          // outer repo's handleRepoDragStart.
                          draggable={false}
                          onDragStart={e => e.stopPropagation()}
                          onClick={() => onResumeSession(conv.conversationId)}
                          onContextMenu={e => {
                            // #4372: stopPropagation so the right-click does
                            // not bubble to the outer .sidebar-repo
                            // treeitem (see matching comment on session
                            // rows above).
                            e.preventDefault()
                            e.stopPropagation()
                            onContextMenu({ type: 'resumable', conversationId: conv.conversationId }, e)
                          }}
                          // #4392: keyboard invocation (ContextMenu /
                          // Shift+F10), see matching binding on session
                          // rows above.
                          onKeyDown={e => invokeContextMenuFromKey(e, { type: 'resumable', conversationId: conv.conversationId })}
                        >
                          <span className="sidebar-resumable-dot" title="Resumable conversation" />
                          <span className="sidebar-session-name">
                            {conv.preview || 'Untitled conversation'}
                          </span>
                        </div>
                      ))}

                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* #4303 — pluggable sidebar panel slot. SERVERS section
              stays BELOW the slot for v1 (rationale: ServerPicker has its
              own always-visible add button + status; forcing it into the
              slot's one-view-at-a-time model loses functionality you'd
              want simultaneously with whatever lives in the slot). */}
          <SidebarPanelSlot
            views={panelViews}
            launchers={panelLaunchers}
            selectedViewId={panelView}
            onSelectView={handlePanelViewChange}
            collapsed={panelCollapsed}
            onCollapsedChange={handlePanelCollapsedChange}
            height={panelHeight}
            onHeightChange={handlePanelHeightChange}
          />

          {/* Server picker (multi-machine) */}
          <ServerPicker />

          {/* Footer */}
          <div className="sidebar-footer" data-testid="sidebar-footer">
            <span
              className={`sidebar-status-dot ${serverStatus}`}
              data-activity={serverStatus === 'connected' ? chatActivityState : undefined}
              title={
                serverStatus === 'connected' ? 'Server connected'
                  : serverStatus === 'reconnecting' ? 'Reconnecting to server...'
                  : 'Server disconnected'
              }
            />
            <span className="sidebar-status-label">{statusLabel}</span>
            {tunnelUrl && (
              <span className="sidebar-tunnel" title={tunnelUrl}>
                {abbreviateTunnel(tunnelUrl)}
              </span>
            )}
            {/* #5281 ①.3 — shared-session presence. Renders the same plain
                "N client(s)" text when solo, an interactive popover when the
                session is genuinely shared (≥2 devices). */}
            <ViewersIndicator
              clients={connectedClients}
              primaryClientId={activePrimaryClientId}
              connected={serverStatus === 'connected'}
              sessionRole={activeSessionRole ?? null}
              onTakeOver={onTakeOverPrimary}
            />
          </div>
        </>
      )}
      {isOpen && (
        <div
          className="sidebar-resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      )}
    </aside>
  )
}
