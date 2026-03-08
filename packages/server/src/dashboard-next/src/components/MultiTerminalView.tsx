/**
 * MultiTerminalView — manages per-session xterm.js terminals.
 *
 * Each session gets its own TerminalView that persists for the session's
 * lifetime. Hidden tabs use display:none (no destroy/recreate), so scroll
 * position and content are preserved across tab switches.
 *
 * On session switch: hide old → show new → fitAddon.fit().
 */
import { useEffect, useRef, useCallback } from 'react'
import { TerminalView, type TerminalHandle } from './TerminalView'
import { useConnectionStore } from '../store/connection'

export interface MultiTerminalViewProps {
  sessions: { sessionId: string }[]
  activeSessionId: string | null
  className?: string
}

export function MultiTerminalView({ sessions, activeSessionId, className }: MultiTerminalViewProps) {
  const handlesRef = useRef(new Map<string, TerminalHandle>())
  const setTerminalWriteCallback = useConnectionStore(s => s.setTerminalWriteCallback)

  // Track whether active session has terminal data for empty state
  const activeBuffer = useConnectionStore(s => {
    if (!activeSessionId) return ''
    return s.sessionStates[activeSessionId]?.terminalRawBuffer || s.terminalRawBuffer || ''
  })

  // Get initial data for a session from the store (one-time, at mount)
  const getInitialData = useCallback((sessionId: string) => {
    const state = useConnectionStore.getState()
    const ss = state.sessionStates[sessionId]
    return ss?.terminalRawBuffer || state.terminalRawBuffer || ''
  }, [])

  // Wire the active session's terminal to the store write callback
  useEffect(() => {
    if (!activeSessionId) return
    const handle = handlesRef.current.get(activeSessionId)
    if (handle) {
      setTerminalWriteCallback(handle.write)
      handle.fit()
    }
    return () => { setTerminalWriteCallback(null) }
  }, [activeSessionId, setTerminalWriteCallback])

  const handleReady = useCallback((sessionId: string, handle: TerminalHandle) => {
    handlesRef.current.set(sessionId, handle)
    // Use getState() for a fresh read — avoids stale closure from TerminalView's mount-once effect
    const currentActive = useConnectionStore.getState().activeSessionId
    if (sessionId === currentActive) {
      setTerminalWriteCallback(handle.write)
      handle.fit()
    }
  }, [setTerminalWriteCallback])

  // Clean up handles for removed sessions
  useEffect(() => {
    const currentIds = new Set(sessions.map(s => s.sessionId))
    for (const id of handlesRef.current.keys()) {
      if (!currentIds.has(id)) {
        handlesRef.current.delete(id)
      }
    }
  }, [sessions])

  return (
    <div className={className} data-testid="multi-terminal-container" style={{ position: 'relative' }}>
      {sessions.map(session => (
        <div
          key={session.sessionId}
          data-testid={`terminal-pane-${session.sessionId}`}
          style={{
            display: session.sessionId === activeSessionId ? 'block' : 'none',
            width: '100%',
            height: '100%',
          }}
        >
          <TerminalView
            className="terminal-container"
            initialData={getInitialData(session.sessionId)}
            onReady={(handle) => handleReady(session.sessionId, handle)}
          />
        </div>
      ))}
      {!activeBuffer && (
        <div className="terminal-empty-state" data-testid="terminal-empty-state">
          <p>No terminal output yet.</p>
          <p className="terminal-empty-hint">Output from the active session will appear here as it runs.</p>
        </div>
      )}
    </div>
  )
}
