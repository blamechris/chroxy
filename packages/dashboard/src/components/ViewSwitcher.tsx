import { useState, useEffect, useCallback, useRef } from 'react'
import { type SplitDirection } from './SplitPane'
import { formatShortcutKeys } from '../utils/platform'

// #5204 — 'control-room' is no longer a per-session viewMode; the Control
// Room is a dedicated session-independent top-level tab (see `controlRoomOpen`
// / `controlRoomActive` in App).
export type ViewMode = 'chat' | 'terminal' | 'files' | 'diff' | 'git' | 'system' | 'console' | 'snapshots' | 'pool' | 'pages' | 'devices'

/** Scrollable tab bar with arrow buttons when overflowing */
export function ViewSwitcher({
  viewMode, setViewMode, splitMode, setSplitMode, persistSplitMode,
  showChatTab = true, showTerminalTab = true, showConsoleTab, unreadSystemCount, checkpointsOpen, setCheckpointsOpen,
  compactChatFilter = false, onToggleCompactChatFilter,
}: {
  viewMode: string
  setViewMode: (m: ViewMode) => void
  splitMode: SplitDirection | null
  setSplitMode: (m: SplitDirection | null) => void
  persistSplitMode: (m: SplitDirection | null) => void
  // #5986: the Chat tab is hidden for terminal-only providers (user-shell) —
  // a raw $SHELL has no parsed chat surface, only the Output terminal.
  showChatTab?: boolean
  // #5835 (PR2): the "Output" tab is the live claude-tui PTY mirror — shown for
  // providers with a real PTY (claude-tui, and user-shell since #5986).
  showTerminalTab?: boolean
  showConsoleTab: boolean
  unreadSystemCount: number
  checkpointsOpen: boolean
  setCheckpointsOpen: (fn: (prev: boolean) => boolean) => void
  // #6799 — global compact chat filter (hide tool calls + thinking, mobile
  // parity). The toggle only renders while a chat surface is on screen. When
  // `onToggleCompactChatFilter` is omitted the control is hidden entirely.
  compactChatFilter?: boolean
  onToggleCompactChatFilter?: (enabled: boolean) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const dragState = useRef<{ isDragging: boolean; startX: number; scrollLeft: number }>({
    isDragging: false, startX: 0, scrollLeft: 0,
  })

  const updateArrows = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateArrows()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(updateArrows)
      ro.observe(el)
    }
    el.addEventListener('scroll', updateArrows, { passive: true })
    return () => { ro?.disconnect(); el.removeEventListener('scroll', updateArrows) }
  }, [updateArrows, showConsoleTab, unreadSystemCount])

  const scroll = useCallback((dir: number) => {
    const el = scrollRef.current
    if (!el) return
    // Scroll by one tab width (use the first tab's width as reference)
    const tabWidth = el.querySelector('.view-tab')?.getBoundingClientRect().width ?? 100
    el.scrollBy({ left: dir * (tabWidth + 8), behavior: 'smooth' })
  }, [])

  // Drag-to-scroll handlers
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Only drag on the container background, not on buttons or their children
    if ((e.target as HTMLElement).closest('button')) return
    const el = scrollRef.current
    if (!el) return
    dragState.current = { isDragging: true, startX: e.clientX, scrollLeft: el.scrollLeft }
    el.setPointerCapture(e.pointerId)
    el.style.cursor = 'grabbing'
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current.isDragging) return
    const el = scrollRef.current
    if (!el) return
    const dx = e.clientX - dragState.current.startX
    el.scrollLeft = dragState.current.scrollLeft - dx
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current.isDragging) return
    dragState.current.isDragging = false
    const el = scrollRef.current
    if (!el) return
    el.releasePointerCapture(e.pointerId)
    el.style.cursor = ''
  }, [])

  return (
    <div className="view-switch-wrapper">
      {canScrollLeft && (
        <button className="view-switch-arrow view-switch-arrow-left" onClick={() => scroll(-1)} type="button" aria-label="Scroll tabs left">‹</button>
      )}
      <div
        className="view-switch"
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {showChatTab && (
          <button className={`view-tab${viewMode === 'chat' && !splitMode ? ' active' : ''}`} onClick={() => { setViewMode('chat'); setSplitMode(null); persistSplitMode(null) }} type="button">Chat</button>
        )}
        {showTerminalTab && (
          <button className={`view-tab${viewMode === 'terminal' && !splitMode ? ' active' : ''}`} onClick={() => { setViewMode('terminal'); setSplitMode(null); persistSplitMode(null) }} type="button">Terminal</button>
        )}
        {/* #5200/#5204: the Control Room is launched from the bottom sidebar
            panel slot (its header "Control Room" button) and opens as its own
            session-independent top-level tab in the SessionBar strip — not a
            per-session view tab here. */}
        {/* #5997 — Split renders BOTH a ChatView and a terminal pane, so it
            needs both surfaces present. Hidden unless the provider has a Chat
            tab AND an Output terminal — i.e. only claude-tui today. For a
            terminal-only provider (user-shell, no chat) or a chat-only provider
            (no PTY/Output) one half would render empty. */}
        {showChatTab && showTerminalTab && (
          <button
            className={`view-tab${splitMode ? ' active' : ''}`}
            onClick={() => { const next: SplitDirection | null = splitMode ? null : 'horizontal'; setSplitMode(next); persistSplitMode(next) }}
            type="button" title={`Split view (${formatShortcutKeys('Cmd+\\')})`}
          >Split</button>
        )}
        <button className={`view-tab${viewMode === 'files' ? ' active' : ''}`} onClick={() => setViewMode('files')} type="button">Files</button>
        {/* #6780 — stage/unstage/commit UI on top of the existing git status
            wiring (Files tab already shows read-only decorations + branch). */}
        <button className={`view-tab${viewMode === 'git' ? ' active' : ''}`} onClick={() => setViewMode('git')} type="button">Git</button>
        <button className={`view-tab${viewMode === 'system' ? ' active' : ''}`} onClick={() => { setViewMode('system'); setSplitMode(null); persistSplitMode(null) }} type="button">
          System{unreadSystemCount > 0 && <span className="system-badge">{unreadSystemCount}</span>}
        </button>
        {showConsoleTab && (
          <button className={`view-tab${viewMode === 'console' ? ' active' : ''}`} onClick={() => { setViewMode('console'); setSplitMode(null); persistSplitMode(null) }} type="button">Console</button>
        )}
        <button className={`view-tab${viewMode === 'snapshots' ? ' active' : ''}`} onClick={() => { setViewMode('snapshots'); setSplitMode(null); persistSplitMode(null) }} type="button">Snapshots</button>
        <button className={`view-tab${viewMode === 'pool' ? ' active' : ''}`} onClick={() => { setViewMode('pool'); setSplitMode(null); persistSplitMode(null) }} type="button">Pool</button>
        <button className={`view-tab${viewMode === 'pages' ? ' active' : ''}`} onClick={() => { setViewMode('pages'); setSplitMode(null); persistSplitMode(null) }} type="button">Pages</button>
        <button className={`view-tab${viewMode === 'devices' ? ' active' : ''}`} onClick={() => { setViewMode('devices'); setSplitMode(null); persistSplitMode(null) }} type="button">Devices</button>
        <div className="view-switch-spacer" />
        {/* #6799 — global compact chat filter: hide every tool call + thinking
            block from the transcript at once (mobile parity). Only meaningful
            while a chat surface is showing — split always renders a ChatView, so
            it counts too. A pressed/`active` toggle button rather than a tab: it
            doesn't change viewMode, it filters the current one. */}
        {showChatTab && onToggleCompactChatFilter && (viewMode === 'chat' || splitMode !== null) && (
          <button
            className={`view-tab view-tab-right${compactChatFilter ? ' active' : ''}`}
            data-testid="compact-chat-filter-toggle"
            onClick={() => onToggleCompactChatFilter(!compactChatFilter)}
            type="button"
            aria-pressed={compactChatFilter}
            title={compactChatFilter ? 'Showing compact chat — click to show tool calls and thinking' : 'Hide tool calls and thinking from the transcript'}
          >Compact</button>
        )}
        <button className={`view-tab view-tab-right${checkpointsOpen ? ' active' : ''}`} onClick={() => setCheckpointsOpen(prev => !prev)} type="button" title="Toggle checkpoint timeline">Checkpoints</button>
        <button className={`view-tab${viewMode === 'diff' ? ' active' : ''}`} onClick={() => setViewMode('diff')} type="button">Diff</button>
      </div>
      {canScrollRight && (
        <button className="view-switch-arrow view-switch-arrow-right" onClick={() => scroll(1)} type="button" aria-label="Scroll tabs right">›</button>
      )}
    </div>
  )
}
