/**
 * WelcomeScreen — shown when no sessions are active.
 *
 * Provides quick-start actions: new session button, recent sessions
 * for resume, and keyboard shortcut hints. Replaces the blank
 * main-content area when session list is empty.
 */

export interface RecentSession {
  conversationId: string
  preview: string
  cwd: string
  updatedAt: number
}

export interface WelcomeScreenProps {
  onNewSession: () => void
  recentSessions: RecentSession[]
  onResumeSession: (conversationId: string, cwd: string) => void
  className?: string
}

const MAX_RECENT = 5

/** Shorten a path to last 2 segments */
function abbreviatePath(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 3) return path
  return '.../' + parts.slice(-2).join('/')
}

/** Format a timestamp as relative time */
function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  if (diffMs < 0) return 'just now'
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

const shortcuts = [
  { keys: 'Cmd+K', label: 'Command palette' },
]

export function WelcomeScreen({
  onNewSession,
  recentSessions,
  onResumeSession,
  className,
}: WelcomeScreenProps) {
  const recent = recentSessions.slice(0, MAX_RECENT)

  return (
    <div
      className={['welcome-screen', className].filter(Boolean).join(' ')}
      data-testid="welcome-screen"
    >
      <div className="welcome-inner">
        {/* Logo + tagline */}
        <div className="welcome-header">
          <h1 className="welcome-logo">Chroxy</h1>
          <p className="welcome-tagline">CLI Agent IDE</p>
        </div>

        {/* Quick actions */}
        <div className="welcome-actions">
          <button
            type="button"
            className="welcome-card welcome-card-primary"
            data-testid="welcome-new-session"
            onClick={onNewSession}
          >
            <span className="welcome-card-icon">+</span>
            <span className="welcome-card-label">New Session</span>
          </button>
        </div>

        {/* Recent sessions */}
        {recent.length > 0 && (
          <div className="welcome-recent" data-testid="welcome-recent-list">
            <h2 className="welcome-section-title">Recent Sessions</h2>
            <ul className="welcome-recent-items">
              {recent.map(session => (
                <li key={session.conversationId} data-testid={`welcome-recent-item-${session.conversationId}`}>
                  <button
                    type="button"
                    className="welcome-recent-btn"
                    onClick={() => onResumeSession(session.conversationId, session.cwd)}
                  >
                    <span className="welcome-recent-preview">{session.preview}</span>
                    <span className="welcome-recent-meta">
                      <span
                        className="welcome-recent-cwd"
                        data-testid={`welcome-recent-cwd-${session.conversationId}`}
                      >
                        {abbreviatePath(session.cwd)}
                      </span>
                      <span className="welcome-recent-time">{relativeTime(session.updatedAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Keyboard shortcuts */}
        <div className="welcome-shortcuts">
          {shortcuts.map(s => (
            <span key={s.keys} className="welcome-shortcut">
              <kbd>{s.keys}</kbd> {s.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
