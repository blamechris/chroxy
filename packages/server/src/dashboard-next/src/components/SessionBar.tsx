/**
 * SessionBar — horizontal tab strip for session management.
 *
 * Features: active highlight, busy dot, close/rename, cwd badge, model badge.
 */
import { useState, useCallback, useRef, useEffect } from 'react'

export interface SessionTabData {
  sessionId: string
  name: string
  isBusy: boolean
  isActive: boolean
  cwd?: string
  model?: string
  provider?: string
}

export interface SessionBarProps {
  sessions: SessionTabData[]
  onSwitch: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
  onNewSession: () => void
}

function shortenModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d.*$/, '')
}

function abbreviateCwd(cwd: string): string {
  const parts = cwd.split('/')
  return parts[parts.length - 1] || cwd
}

function shortenProvider(provider: string): string {
  return provider.replace(/^claude-/, '').toUpperCase()
}

export function SessionBar({ sessions, onSwitch, onClose, onRename, onNewSession }: SessionBarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelledRef = useRef(false)
  const showClose = sessions.length > 1

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renamingId])

  const startRename = useCallback((session: SessionTabData) => {
    cancelledRef.current = false
    setRenamingId(session.sessionId)
    setRenameValue(session.name)
  }, [])

  const commitRename = useCallback((sessionId: string) => {
    if (cancelledRef.current) return
    const trimmed = renameValue.trim()
    const session = sessions.find(s => s.sessionId === sessionId)
    if (trimmed && session && trimmed !== session.name.trim()) {
      onRename(sessionId, trimmed)
    }
    setRenamingId(null)
  }, [renameValue, onRename, sessions])

  const cancelRename = useCallback(() => {
    cancelledRef.current = true
    setRenamingId(null)
  }, [])

  return (
    <div className="session-bar" data-testid="session-bar">
      <div className="session-tabs" role="tablist">
        {sessions.map(session => (
          <div
            key={session.sessionId}
            className={`session-tab${session.isActive ? ' active' : ''}`}
            data-testid={`session-tab-${session.sessionId}`}
            role="tab"
            aria-selected={session.isActive}
            tabIndex={0}
            onClick={() => {
              if (!session.isActive) onSwitch(session.sessionId)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (!session.isActive) onSwitch(session.sessionId)
              }
            }}
          >
            {session.isBusy && (
              <span className="tab-busy-dot" data-testid="busy-dot" title="Session busy — processing..." />
            )}

            {renamingId === session.sessionId ? (
              <input
                ref={inputRef}
                className="tab-rename-input"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitRename(session.sessionId)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    cancelRename()
                  }
                }}
                onBlur={() => commitRename(session.sessionId)}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span
                className="tab-name"
                onDoubleClick={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  startRename(session)
                }}
              >
                {session.name}
              </span>
            )}

            {session.cwd && (
              <span className="tab-cwd" title={session.cwd}>
                {abbreviateCwd(session.cwd)}
              </span>
            )}

            {session.model && (
              <span className="tab-model">
                {shortenModel(session.model)}
              </span>
            )}

            {session.provider && (
              <span className="tab-provider" title={session.provider}>
                {shortenProvider(session.provider)}
              </span>
            )}

            {showClose && (
              <button
                className="tab-close"
                data-testid="tab-close"
                aria-label={`Close session ${session.name}`}
                onClick={e => {
                  e.stopPropagation()
                  onClose(session.sessionId)
                }}
                type="button"
              >
                &times;
              </button>
            )}
          </div>
        ))}
      </div>

      <button
        className="btn-new-session"
        data-testid="new-session-btn"
        onClick={onNewSession}
        aria-label="Create new session"
        title="New session (Ctrl+N)"
        type="button"
      >
        +
      </button>
    </div>
  )
}
