/**
 * Sidebar — primary navigation for the desktop IDE.
 *
 * Shows repos with active/resumable sessions, filter, status footer.
 * Collapsible with Cmd+B toggle.
 */
import { useState, useCallback } from 'react'

export interface ActiveSessionNode {
  sessionId: string
  name: string
  isBusy: boolean
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
  onResumeSession: (conversationId: string) => void
  onNewSession: (cwd: string) => void
  onToggle: () => void
  onContextMenu: (target: ContextMenuTarget, event: React.MouseEvent) => void
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
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggleRepo = useCallback((path: string) => {
    setCollapsed(prev => ({ ...prev, [path]: !prev[path] }))
  }, [])

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

          {/* Repo tree */}
          <div className="sidebar-tree">
            {filteredRepos.map(repo => {
              const isCollapsed = collapsed[repo.path] ?? false
              return (
                <div key={repo.path} className="sidebar-repo">
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
                    <div className="sidebar-repo-children">
                      {/* Active sessions */}
                      {repo.activeSessions.map(session => (
                        <div
                          key={session.sessionId}
                          className={`sidebar-session-item${activeSessionId === session.sessionId ? ' active' : ''}`}
                          data-testid={`session-item-${session.sessionId}`}
                          onClick={() => onSessionClick(session.sessionId)}
                          onContextMenu={e => {
                            e.preventDefault()
                            onContextMenu({ type: 'session', sessionId: session.sessionId }, e)
                          }}
                        >
                          {session.isBusy ? (
                            <span className="sidebar-busy-dot" />
                          ) : (
                            <span className="sidebar-idle-dot" />
                          )}
                          <span className="sidebar-session-name">{session.name}</span>
                        </div>
                      ))}

                      {/* Resumable sessions */}
                      {repo.resumableSessions.map(conv => (
                        <div
                          key={conv.conversationId}
                          className="sidebar-resumable-item"
                          data-testid={`resumable-item-${conv.conversationId}`}
                          onClick={() => onResumeSession(conv.conversationId)}
                          onContextMenu={e => {
                            e.preventDefault()
                            onContextMenu({ type: 'resumable', conversationId: conv.conversationId }, e)
                          }}
                        >
                          <span className="sidebar-resumable-dot" />
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

          {/* Footer */}
          <div className="sidebar-footer" data-testid="sidebar-footer">
            <span className={`sidebar-status-dot ${serverStatus}`} />
            <span className="sidebar-status-label">{statusLabel}</span>
            {tunnelUrl && (
              <span className="sidebar-tunnel" title={tunnelUrl}>
                {abbreviateTunnel(tunnelUrl)}
              </span>
            )}
            <span className="sidebar-client-count">{clientCount} client{clientCount !== 1 ? 's' : ''}</span>
          </div>
        </>
      )}
    </aside>
  )
}
