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
import { CLAUDE_TUI_PTY_SIZE } from '@chroxy/protocol'
import { TerminalView, type TerminalHandle } from './TerminalView'
import { useConnectionStore } from '../store/connection'

// #5835 (PR2): the live claude-tui PTY mirror is a fixed grid server-side
// (claude-tui-session.js spawns the PTY at CLAUDE_TUI_PTY_SIZE). The Output pane
// is claude-tui-only, so render every terminal here at that exact size,
// letterboxed, to keep the mirror 1:1 faithful. Single-sourced from @chroxy/
// protocol (#5839) so server + dashboard can't drift.
//
// #5835 Phase 2: the size is now DYNAMIC — the server reports the authoritative
// grid per session via terminal_size (stored on sessionStates[id].terminalSize),
// and the viewer measures its pane and asks the server to resize the real PTY
// (terminal_resize). MIRROR_DEFAULT is just the pre-terminal_size fallback.
const MIRROR_DEFAULT = CLAUDE_TUI_PTY_SIZE

export interface MultiTerminalViewProps {
  sessions: { sessionId: string }[]
  activeSessionId: string | null
  className?: string
}

export function MultiTerminalView({ sessions, activeSessionId, className }: MultiTerminalViewProps) {
  const handlesRef = useRef(new Map<string, TerminalHandle>())
  const setTerminalWriteCallback = useConnectionStore(s => s.setTerminalWriteCallback)
  const requestTerminalResize = useConnectionStore(s => s.requestTerminalResize)
  // #6313: manual "refresh terminal" — forces the server to repaint the live PTY
  // if the viewer notices a desynced grid (a backpressure-dropped frame the
  // stateless mirror can't otherwise recover).
  const requestTerminalResync = useConnectionStore(s => s.requestTerminalResync)
  const sendTerminalInput = useConnectionStore(s => s.sendTerminalInput)
  // #5835 Phase 2: per-session authoritative sizes (server terminal_size). Reads
  // the whole map so a size change re-renders and the new fixedSize flows to the
  // affected TerminalView (which resizes its xterm in place).
  const sessionStates = useConnectionStore(s => s.sessionStates)

  // Track whether active session has terminal data for empty state
  const activeBuffer = useConnectionStore(s => {
    if (!activeSessionId) return ''
    return s.sessionStates[activeSessionId]?.terminalRawBuffer || ''
  })

  // #5835 Phase 2: forward a pane measurement to the server as a resize request.
  // Only the ACTIVE (visible) session drives the shared PTY — hidden panes are
  // display:none and measure 0, but guard on live activeSessionId anyway. Dedupe
  // identical sizes so we don't re-send the same grid (the server also no-ops an
  // unchanged size, but this saves the round trip). TerminalView already debounces
  // the measurement itself.
  const lastSentRef = useRef(new Map<string, string>())
  const handleMeasure = useCallback((sessionId: string, cols: number, rows: number) => {
    const state = useConnectionStore.getState()
    if (state.activeSessionId !== sessionId) return
    // Include the session's authority role in the dedupe key (Copilot review): if
    // we measured while an observer (the server ignored the resize) and later
    // become primary/unclaimed, the role flips and the same grid re-sends — so
    // claiming primary takes effect without needing a pane-size change.
    const role = state.sessionStates[sessionId]?.sessionRole ?? 'none'
    const key = `${cols}x${rows}@${role}`
    if (lastSentRef.current.get(sessionId) === key) return
    lastSentRef.current.set(sessionId, key)
    requestTerminalResize(sessionId, cols, rows)
  }, [requestTerminalResize])

  // #5835 Phase 3: forward a keystroke from a terminal to the server. Only the
  // ACTIVE (visible, focusable) session can emit onData, but guard on live
  // activeSessionId anyway. Role gating happens upstream (TerminalView's
  // `interactive` disables stdin for an observer, so onData never fires), and the
  // server is the final authority — this is the thin forwarding seam.
  const handleInput = useCallback((sessionId: string, data: string) => {
    if (useConnectionStore.getState().activeSessionId !== sessionId) return
    sendTerminalInput(sessionId, data)
  }, [sendTerminalInput])

  // Get initial data for a session from the store (one-time, at mount)
  const getInitialData = useCallback((sessionId: string) => {
    const state = useConnectionStore.getState()
    const ss = state.sessionStates[sessionId]
    return ss?.terminalRawBuffer || ''
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

  // Clean up handles + last-sent sizes for removed sessions
  useEffect(() => {
    const currentIds = new Set(sessions.map(s => s.sessionId))
    for (const id of handlesRef.current.keys()) {
      if (!currentIds.has(id)) {
        handlesRef.current.delete(id)
      }
    }
    for (const id of lastSentRef.current.keys()) {
      if (!currentIds.has(id)) {
        lastSentRef.current.delete(id)
      }
    }
  }, [sessions])

  // #5835 Phase 3: the active session is read-only iff this client observes it
  // (another device holds primary) — same predicate as each pane's `interactive`,
  // named once for the badge.
  const activeIsObserver = !!activeSessionId && sessionStates[activeSessionId]?.sessionRole === 'observer'

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
            fixedSize={sessionStates[session.sessionId]?.terminalSize ?? MIRROR_DEFAULT}
            onMeasure={(cols, rows) => handleMeasure(session.sessionId, cols, rows)}
            // #5835 Phase 3: interactive (keystrokes → PTY) unless this client is
            // an OBSERVER of the session — another device holds primary. The
            // server is the final authority; this keeps an observer's keys from
            // spamming input_conflict and reflects read-only in the cursor/focus.
            interactive={sessionStates[session.sessionId]?.sessionRole !== 'observer'}
            onInput={(data) => handleInput(session.sessionId, data)}
          />
        </div>
      ))}
      {activeSessionId && activeBuffer && (
        <button
          type="button"
          className="terminal-resync-button"
          data-testid="terminal-resync-button"
          title="Refresh terminal — force a fresh repaint if the view looks out of sync"
          aria-label="Refresh terminal"
          onClick={() => requestTerminalResync(activeSessionId)}
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}
        >
          ⟳
        </button>
      )}
      {activeIsObserver && (
        <div className="terminal-readonly-badge" data-testid="terminal-readonly-badge">
          Read-only — another device is driving this session
        </div>
      )}
      {!activeBuffer && (
        <div className="terminal-empty-state" data-testid="terminal-empty-state">
          <p>No terminal output yet.</p>
          <p className="terminal-empty-hint">Output from the active session will appear here as it runs.</p>
        </div>
      )}
    </div>
  )
}
