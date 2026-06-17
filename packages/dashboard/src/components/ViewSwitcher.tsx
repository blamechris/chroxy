import { useState, useEffect, useCallback, useRef } from 'react'
import { type SplitDirection } from './SplitPane'
import { formatShortcutKeys } from '../utils/platform'

// #5204 — 'control-room' is no longer a per-session viewMode; the Control
// Room is a dedicated session-independent top-level tab (see `controlRoomOpen`
// / `controlRoomActive` in App).
export type ViewMode = 'chat' | 'terminal' | 'files' | 'diff' | 'system' | 'console' | 'environments' | 'snapshots' | 'pool'

/** Scrollable tab bar with arrow buttons when overflowing */
export function ViewSwitcher({
  viewMode, setViewMode, splitMode, setSplitMode, persistSplitMode,
  showChatTab = true, showTerminalTab = true, showConsoleTab, unreadSystemCount, checkpointsOpen, setCheckpointsOpen,
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
          <button className={`view-tab${viewMode === 'terminal' && !splitMode ? ' active' : ''}`} onClick={() => { setViewMode('terminal'); setSplitMode(null); persistSplitMode(null) }} type="button">Output</button>
        )}
        {/* #5200/#5204: the Control Room is launched from the bottom sidebar
            panel slot (its header "Control Room" button) and opens as its own
            session-independent top-level tab in the SessionBar strip — not a
            per-session view tab here. */}
        <button
          className={`view-tab${splitMode ? ' active' : ''}`}
          onClick={() => { const next: SplitDirection | null = splitMode ? null : 'horizontal'; setSplitMode(next); persistSplitMode(next) }}
          type="button" title={`Split view (${formatShortcutKeys('Cmd+\\')})`}
        >Split</button>
        <button className={`view-tab${viewMode === 'files' ? ' active' : ''}`} onClick={() => setViewMode('files')} type="button">Files</button>
        <button className={`view-tab${viewMode === 'system' ? ' active' : ''}`} onClick={() => { setViewMode('system'); setSplitMode(null); persistSplitMode(null) }} type="button">
          System{unreadSystemCount > 0 && <span className="system-badge">{unreadSystemCount}</span>}
        </button>
        {showConsoleTab && (
          <button className={`view-tab${viewMode === 'console' ? ' active' : ''}`} onClick={() => { setViewMode('console'); setSplitMode(null); persistSplitMode(null) }} type="button">Console</button>
        )}
        <button className={`view-tab${viewMode === 'environments' ? ' active' : ''}`} onClick={() => { setViewMode('environments'); setSplitMode(null); persistSplitMode(null) }} type="button">Envs</button>
        <button className={`view-tab${viewMode === 'snapshots' ? ' active' : ''}`} onClick={() => { setViewMode('snapshots'); setSplitMode(null); persistSplitMode(null) }} type="button">Snapshots</button>
        <button className={`view-tab${viewMode === 'pool' ? ' active' : ''}`} onClick={() => { setViewMode('pool'); setSplitMode(null); persistSplitMode(null) }} type="button">Pool</button>
        <div className="view-switch-spacer" />
        <button className={`view-tab view-tab-right${checkpointsOpen ? ' active' : ''}`} onClick={() => setCheckpointsOpen(prev => !prev)} type="button" title="Toggle checkpoint timeline">Checkpoints</button>
        <button className={`view-tab${viewMode === 'diff' ? ' active' : ''}`} onClick={() => setViewMode('diff')} type="button">Diff</button>
      </div>
      {canScrollRight && (
        <button className="view-switch-arrow view-switch-arrow-right" onClick={() => scroll(1)} type="button" aria-label="Scroll tabs right">›</button>
      )}
    </div>
  )
}
