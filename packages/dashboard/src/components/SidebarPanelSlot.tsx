/**
 * SidebarPanelSlot (#4303) — pluggable bottom panel in the left sidebar.
 *
 * Hosts a collection of registered views (declared by parent) and lets the
 * user pick one via a tab strip, collapse the entire panel to just its
 * header, and drag-resize its height. Persistence (height, selected view,
 * collapsed state) is handled by the parent via callbacks so each consumer
 * picks its own storage backend.
 *
 * Designed to host future occupants beyond v1's token view: MCP server
 * status, skills registry, slash command palette, etc. Adding a view is
 * declarative — pass another entry in `views`.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react'

export interface SidebarPanelView {
  /** Stable id used for persistence + view selection. */
  id: string
  /** Short label shown in the tab strip. */
  label: string
  /** The view body. Rendered only when this view is selected. */
  render: () => ReactNode
  /**
   * Optional metric to surface in the collapsed-panel header bar
   * (decision #4 in #4303). When the panel is collapsed, the active
   * view can still report a single live number/string here so the
   * user gets at-a-glance info without expanding.
   */
  collapsedHeaderMetric?: () => ReactNode
}

export interface SidebarPanelSlotProps {
  views: SidebarPanelView[]
  selectedViewId: string | null
  onSelectView: (viewId: string) => void
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  height: number
  onHeightChange: (height: number) => void
  /** Min content height in px (default 120). */
  minHeight?: number
  /** Max content height in px (default 600). */
  maxHeight?: number
}

const DEFAULT_MIN_HEIGHT = 120
const DEFAULT_MAX_HEIGHT = 600
const HEADER_HEIGHT_PX = 28

export function SidebarPanelSlot({
  views,
  selectedViewId,
  onSelectView,
  collapsed,
  onCollapsedChange,
  height,
  onHeightChange,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: SidebarPanelSlotProps) {
  // Resolve selected view — fall back to first view if id is stale (e.g.
  // a previously-selected view was removed). Falls back to null only when
  // there are zero registered views, which is a degenerate case but
  // shouldn't crash.
  // Intentional behavior, NOT a bug — when a previously-registered view
  // is removed in a future build, the user lands on the first registered
  // view rather than seeing an empty body.
  const activeView =
    views.find((v) => v.id === selectedViewId) ?? views[0] ?? null

  const isDragging = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(height)
  // #4304 review: hold the live drag listeners on refs so the unmount
  // effect can detach them. Without this, starting a drag and then
  // unmounting the slot (e.g. Cmd+B sidebar collapse) leaks document
  // listeners that keep calling onHeightChange on a dead component.
  const dragMoveRef = useRef<((ev: MouseEvent) => void) | null>(null)
  const dragUpRef = useRef<(() => void) | null>(null)

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (collapsed) return
      e.preventDefault()
      isDragging.current = true
      startY.current = e.clientY
      startHeight.current = height

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return
        // The handle is on the TOP edge — dragging UP makes the panel
        // taller, so subtract delta from start.
        const delta = startY.current - ev.clientY
        const next = Math.min(maxHeight, Math.max(minHeight, startHeight.current + delta))
        onHeightChange(next)
      }

      const onMouseUp = () => {
        isDragging.current = false
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        dragMoveRef.current = null
        dragUpRef.current = null
      }

      dragMoveRef.current = onMouseMove
      dragUpRef.current = onMouseUp
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [collapsed, height, maxHeight, minHeight, onHeightChange],
  )

  // Keyboard resize support: arrow keys when the handle is focused move
  // the panel boundary in 16px steps.
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (collapsed) return
      const STEP = 16
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        onHeightChange(Math.min(maxHeight, height + STEP))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        onHeightChange(Math.max(minHeight, height - STEP))
      }
    },
    [collapsed, height, maxHeight, minHeight, onHeightChange],
  )

  // #4304 review: remove any live drag listeners on unmount. Refs hold
  // the exact closures registered, so the removeEventListener calls
  // match what was added.
  useEffect(() => {
    return () => {
      isDragging.current = false
      if (dragMoveRef.current) {
        document.removeEventListener('mousemove', dragMoveRef.current)
        dragMoveRef.current = null
      }
      if (dragUpRef.current) {
        document.removeEventListener('mouseup', dragUpRef.current)
        dragUpRef.current = null
      }
    }
  }, [])

  // #4304 review: WAI-ARIA tablist keyboard navigation (ArrowLeft/Right,
  // Home, End). Wires roving focus to the matching tab button so users
  // arriving via Tab can move between tabs without a mouse. Trips today
  // with only one tab registered but is cheap to add now so future view
  // additions don't ship an a11y regression.
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent, currentIndex: number) => {
      if (views.length === 0) return
      let nextIndex: number | null = null
      switch (e.key) {
        case 'ArrowLeft':
          nextIndex = (currentIndex - 1 + views.length) % views.length
          break
        case 'ArrowRight':
          nextIndex = (currentIndex + 1) % views.length
          break
        case 'Home':
          nextIndex = 0
          break
        case 'End':
          nextIndex = views.length - 1
          break
        default:
          return
      }
      e.preventDefault()
      const target = views[nextIndex]
      if (target) {
        onSelectView(target.id)
        // Move focus to the newly-selected tab so the user lands on
        // tabIndex=0 next render.
        tabRefs.current[nextIndex]?.focus()
      }
    },
    [onSelectView, views],
  )

  if (views.length === 0) return null

  const contentHeight = Math.min(maxHeight, Math.max(minHeight, height))

  return (
    <div
      className="sidebar-panel-slot"
      data-testid="sidebar-panel-slot"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      {!collapsed && (
        <div
          className="sidebar-panel-slot-resize-handle"
          data-testid="sidebar-panel-slot-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={contentHeight}
          aria-valuemin={minHeight}
          aria-valuemax={maxHeight}
          aria-label="Resize sidebar panel"
          tabIndex={0}
          onMouseDown={handleResizeMouseDown}
          onKeyDown={handleResizeKeyDown}
        />
      )}
      <div
        className="sidebar-panel-slot-header"
        data-testid="sidebar-panel-slot-header"
        style={{ height: HEADER_HEIGHT_PX }}
      >
        <div
          className="sidebar-panel-slot-tabs"
          role="tablist"
          aria-label="Sidebar panel views"
        >
          {views.map((v, i) => {
            const selected = v.id === activeView?.id
            return (
              <button
                key={v.id}
                ref={(el) => { tabRefs.current[i] = el }}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`sidebar-panel-slot-view-${v.id}`}
                data-testid={`sidebar-panel-slot-tab-${v.id}`}
                className={`sidebar-panel-slot-tab${selected ? ' selected' : ''}`}
                onClick={() => onSelectView(v.id)}
                onKeyDown={(e) => handleTabKeyDown(e, i)}
                tabIndex={selected ? 0 : -1}
              >
                {v.label}
              </button>
            )
          })}
        </div>
        {collapsed && activeView?.collapsedHeaderMetric && (
          <div
            className="sidebar-panel-slot-collapsed-metric"
            data-testid="sidebar-panel-slot-collapsed-metric"
          >
            {activeView.collapsedHeaderMetric()}
          </div>
        )}
        <button
          type="button"
          className="sidebar-panel-slot-collapse-toggle"
          data-testid="sidebar-panel-slot-collapse-toggle"
          aria-label={collapsed ? 'Expand sidebar panel' : 'Collapse sidebar panel'}
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && activeView && (
        <div
          className="sidebar-panel-slot-body"
          data-testid="sidebar-panel-slot-body"
          id={`sidebar-panel-slot-view-${activeView.id}`}
          role="tabpanel"
          style={{ height: contentHeight }}
        >
          {activeView.render()}
        </div>
      )}
    </div>
  )
}
