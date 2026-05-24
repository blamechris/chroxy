/**
 * SessionContextMenu (#4045) — right-click context menu for sidebar items.
 *
 * Self-contained, position-aware menu rendered as an absolutely-positioned
 * overlay at the click coordinates. Dismisses on:
 *   - outside click (capturing mousedown, so it fires before any other
 *     handler swaps the active session)
 *   - Escape key
 *   - window blur
 *   - scroll on any ancestor (the menu's anchor coordinates would otherwise
 *     drift away from the target row)
 *
 * Item visibility is driven by `items[]` — the parent decides which actions
 * are capability-gated (e.g. "Open in Finder" only when running under Tauri,
 * "Archive" only when the server reports archive support). Items with a
 * falsy `onClick` are not rendered so consumers don't have to filter their
 * arrays before passing them in.
 *
 * No third-party library — the menu is a `<ul>` with click handlers and a
 * single `useEffect` that wires the dismiss listeners.
 */
import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  /** Stable id used as React key and `data-testid` suffix. */
  id: string
  /** Display label. */
  label: string
  /** Action — when falsy, the item is skipped entirely (capability gate). */
  onClick?: () => void
  /**
   * Optional "destructive" flag — renders the row in the danger colour so
   * Close/Delete read as risky relative to Duplicate/Reveal. The menu does
   * not add its own confirm dialog; that stays with the caller (matches the
   * existing Close-session window.confirm in App.tsx).
   */
  destructive?: boolean
  /** Optional separator above this item. */
  separatorAbove?: boolean
}

export interface SessionContextMenuProps {
  /** Viewport coordinates of the right-click. */
  x: number
  y: number
  /** Menu items — falsy `onClick` items are filtered out. */
  items: ContextMenuItem[]
  /** Called when the menu should close (outside click, Escape, blur). */
  onDismiss: () => void
}

export function SessionContextMenu({
  x,
  y,
  items,
  onDismiss,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLUListElement>(null)
  const visibleItems = items.filter(i => typeof i.onClick === 'function')

  // Adjust position so the menu stays inside the viewport. We can't know the
  // real menu size until after layout, but a conservative estimate keeps the
  // first paint inside bounds — the effect below corrects it once mounted.
  const estimatedWidth = 200
  const estimatedHeight = Math.max(32, visibleItems.length * 32 + 8)
  const initialLeft = Math.min(x, Math.max(0, window.innerWidth - estimatedWidth))
  const initialTop = Math.min(y, Math.max(0, window.innerHeight - estimatedHeight))

  useEffect(() => {
    // Reposition after first paint with the real rendered size.
    const menu = menuRef.current
    if (menu) {
      const rect = menu.getBoundingClientRect()
      const overflowRight = rect.right - window.innerWidth
      const overflowBottom = rect.bottom - window.innerHeight
      if (overflowRight > 0) menu.style.left = `${Math.max(0, x - rect.width)}px`
      if (overflowBottom > 0) menu.style.top = `${Math.max(0, y - rect.height)}px`
    }
  }, [x, y])

  useEffect(() => {
    // Capturing-phase mousedown so we dismiss BEFORE the underlying row's
    // onClick fires (which would otherwise swap the active session out from
    // under the user when they click outside the menu).
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onDismiss()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onDismiss()
      }
    }
    const onBlur = () => onDismiss()
    const onScroll = () => onDismiss()
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    // `true` so we catch ancestor scroll events too.
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onDismiss])

  if (visibleItems.length === 0) return null

  return (
    <ul
      ref={menuRef}
      className="session-context-menu"
      data-testid="session-context-menu"
      role="menu"
      style={{
        position: 'fixed',
        left: initialLeft,
        top: initialTop,
        zIndex: 1000,
      }}
    >
      {visibleItems.map(item => (
        <li
          key={item.id}
          role="menuitem"
          data-testid={`session-context-menu-item-${item.id}`}
          className={`session-context-menu-item${item.destructive ? ' destructive' : ''}${item.separatorAbove ? ' separator-above' : ''}`}
          onClick={() => {
            item.onClick?.()
            onDismiss()
          }}
        >
          {item.label}
        </li>
      ))}
    </ul>
  )
}
