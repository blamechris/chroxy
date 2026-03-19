/**
 * Sidebar — primary navigation for the desktop IDE.
 *
 * Shows repos with active/resumable sessions, filter, status footer.
 * Collapsible with Cmd+B toggle.
 */
import { useState, useCallback, useRef } from 'react'
import { ConversationSearch } from './ConversationSearch'
import { ServerPicker } from './ServerPicker'
import type { SearchResult } from '../store/types'

export interface ActiveSessionNode {
  sessionId: string
  name: string
  isBusy: boolean
  provider?: string
  worktree?: boolean
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
  tunnelUrl: string | null
  clientCount: number
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
}

function abbreviateTunnel(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function Sidebar({
  repos,
  activeSessionId,
  isOpen,
  width,
  filter,
  serverStatus,
  tunnelUrl,
  clientCount,
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
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [focusedIndex, setFocusedIndex] = useState(0)
  const treeRef = useRef<HTMLDivElement>(null)

  const toggleRepo = useCallback((path: string) => {
    setCollapsed(prev => ({ ...prev, [path]: !prev[path] }))
  }, [])

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

          {/* Repo tree */}
          <div className="sidebar-tree" role="tree" aria-label="Repository sessions" ref={treeRef} onKeyDown={handleTreeKeyDown}>
            {filteredRepos.map(repo => {
              const isCollapsed = filter ? false : (collapsed[repo.path] ?? false)
              return (
                <div key={repo.path} className="sidebar-repo" role="treeitem" aria-expanded={!isCollapsed} tabIndex={visibleIds.indexOf(`repo:${repo.path}`) === focusedIndex ? 0 : -1}>
                  <div
                    className={`sidebar-repo-header${!repo.exists ? ' missing' : ''}`}
                    data-testid={`repo-header-${repo.path}`}
                    onClick={() => toggleRepo(repo.path)}
                    onContextMenu={e => {
                      e.preventDefault()
                      onContextMenu({ type: 'repo', path: repo.path }, e)
                    }}
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
                      {repo.activeSessions.map(session => (
                        <div
                          key={session.sessionId}
                          role="treeitem"
                          aria-selected={activeSessionId === session.sessionId}
                          tabIndex={visibleIds.indexOf(`session:${session.sessionId}`) === focusedIndex ? 0 : -1}
                          className={`sidebar-session-item${activeSessionId === session.sessionId ? ' active' : ''}`}
                          data-testid={`session-item-${session.sessionId}`}
                          onClick={() => onSessionClick(session.sessionId)}
                          onContextMenu={e => {
                            e.preventDefault()
                            onContextMenu({ type: 'session', sessionId: session.sessionId }, e)
                          }}
                        >
                          {session.isBusy ? (
                            <span className="sidebar-busy-dot" title="Session busy — processing..." />
                          ) : (
                            <span className="sidebar-idle-dot" title="Session idle — ready for input" />
                          )}
                          <span className="sidebar-session-name">{session.name}</span>
                          {session.worktree && (
                            <span className="sidebar-worktree-badge" title="Isolated git worktree">
                              W
                            </span>
                          )}
                          {session.provider && session.provider !== 'claude-sdk' && (
                            <span className="sidebar-provider-badge" title={session.provider}>
                              {session.provider.replace(/^claude-/, '').toUpperCase()}
                            </span>
                          )}
                        </div>
                      ))}

                      {/* Resumable sessions */}
                      {repo.resumableSessions.map(conv => (
                        <div
                          key={conv.conversationId}
                          role="treeitem"
                          aria-selected={false}
                          tabIndex={visibleIds.indexOf(`resumable:${conv.conversationId}`) === focusedIndex ? 0 : -1}
                          className="sidebar-resumable-item"
                          data-testid={`resumable-item-${conv.conversationId}`}
                          onClick={() => onResumeSession(conv.conversationId)}
                          onContextMenu={e => {
                            e.preventDefault()
                            onContextMenu({ type: 'resumable', conversationId: conv.conversationId }, e)
                          }}
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

          {/* Server picker (multi-machine) */}
          <ServerPicker />

          {/* Footer */}
          <div className="sidebar-footer" data-testid="sidebar-footer">
            <span className={`sidebar-status-dot ${serverStatus}`} title={
              serverStatus === 'connected' ? 'Server connected'
                : serverStatus === 'reconnecting' ? 'Reconnecting to server...'
                : 'Server disconnected'
            } />
            <span className="sidebar-status-label">{statusLabel}</span>
            {tunnelUrl && (
              <span className="sidebar-tunnel" title={tunnelUrl}>
                {abbreviateTunnel(tunnelUrl)}
              </span>
            )}
            {serverStatus === 'connected' && (
              <span className="sidebar-client-count">{clientCount} client{clientCount !== 1 ? 's' : ''}</span>
            )}
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
