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

export function SessionBar({ sessions, onSwitch, onClose, onRename, onNewSession }: SessionBarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const showClose = sessions.length > 1

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renamingId])

  const startRename = useCallback((session: SessionTabData) => {
    setRenamingId(session.sessionId)
    setRenameValue(session.name)
  }, [])

  const commitRename = useCallback((sessionId: string) => {
    const trimmed = renameValue.trim()
    if (trimmed) {
      onRename(sessionId, trimmed)
    }
    setRenamingId(null)
  }, [renameValue, onRename])

  const cancelRename = useCallback(() => {
    setRenamingId(null)
  }, [])

  return (
    <div className="session-bar" data-testid="session-bar">
      <div className="session-tabs">
        {sessions.map(session => (
          <div
            key={session.sessionId}
            className={`session-tab${session.isActive ? ' active' : ''}`}
            data-testid={`session-tab-${session.sessionId}`}
            onClick={() => {
              if (!session.isActive) onSwitch(session.sessionId)
            }}
          >
            {session.isBusy && (
              <span className="tab-busy-dot" data-testid="busy-dot" />
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

            {showClose && (
              <button
                className="tab-close"
                data-testid="tab-close"
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
        title="New session (Ctrl+N)"
        type="button"
      >
        +
      </button>
    </div>
  )
}
