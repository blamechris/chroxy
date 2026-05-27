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
import { useEffect, useRef, useState } from 'react'

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
  // #4248: per-item refs so arrow-key handlers can move focus between
  // <li> nodes without round-tripping through state. A ref array is
  // cheaper than reading from the DOM by selector and avoids the
  // testid-as-API coupling that querySelector would introduce.
  const itemRefs = useRef<(HTMLLIElement | null)[]>([])
  // #4248: roving tabindex — exactly one item is tab-focusable at a time
  // so external Tab key presses don't have to walk through every menu
  // entry, per WAI-ARIA Authoring Practices for the menu role.
  const [focusedIndex, setFocusedIndex] = useState(0)
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

  // #4248: focus the first item on mount and restore focus to whatever
  // element triggered the menu (typically the right-clicked sidebar row)
  // when the menu unmounts. This is the focus-return half of the WAI-ARIA
  // menu pattern and keeps keyboard-only users oriented after Esc.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const first = itemRefs.current[0]
    if (first) first.focus()
    return () => {
      // Guard against the trigger having been removed from the DOM (the
      // sidebar row might be unmounted in another effect during the same
      // render cycle). focus() on a detached node is a no-op but the
      // `isConnected` check makes the intent explicit.
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus()
      }
    }
    // Intentionally empty deps — we want this to run once on mount, with
    // the cleanup running once on unmount. x/y changes don't re-focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // #4248: when the focused index changes (via arrow keys / Home / End),
  // imperatively focus the matching DOM node. We can't rely on the
  // tabIndex={0} attribute alone — that only governs Tab traversal, not
  // programmatic focus.
  useEffect(() => {
    const target = itemRefs.current[focusedIndex]
    if (target && document.activeElement !== target) {
      target.focus()
    }
  }, [focusedIndex])

  if (visibleItems.length === 0) return null

  // #4248: activate the current item the same way the click handler does
  // (try/finally so a throwing handler still dismisses the menu). Shared
  // by Enter / Space and the mouse click path.
  const activate = (item: ContextMenuItem) => {
    try {
      item.onClick?.()
    } finally {
      onDismiss()
    }
  }

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
      {visibleItems.map((item, index) => (
        <li
          key={item.id}
          ref={(node) => {
            itemRefs.current[index] = node
          }}
          role="menuitem"
          // #4248: roving tabindex — only the currently-focused item is in
          // the Tab order. The rest are programmatically focusable via the
          // arrow-key handler but won't be reached by a stray Tab press
          // from outside the menu.
          tabIndex={focusedIndex === index ? 0 : -1}
          data-testid={`session-context-menu-item-${item.id}`}
          className={`session-context-menu-item${item.destructive ? ' destructive' : ''}${item.separatorAbove ? ' separator-above' : ''}`}
          onClick={() => activate(item)}
          onKeyDown={(e) => {
            switch (e.key) {
              case 'ArrowDown': {
                e.preventDefault()
                e.stopPropagation()
                // Wrap-around: last → first.
                setFocusedIndex((i) => (i + 1) % visibleItems.length)
                break
              }
              case 'ArrowUp': {
                e.preventDefault()
                e.stopPropagation()
                // Wrap-around: first → last.
                setFocusedIndex((i) => (i - 1 + visibleItems.length) % visibleItems.length)
                break
              }
              case 'Home': {
                e.preventDefault()
                e.stopPropagation()
                setFocusedIndex(0)
                break
              }
              case 'End': {
                e.preventDefault()
                e.stopPropagation()
                setFocusedIndex(visibleItems.length - 1)
                break
              }
              case 'Enter':
              case ' ': {
                // Both Enter and Space activate the focused item — matches
                // the WAI-ARIA menuitem pattern. preventDefault on Space
                // avoids the default scroll-the-page behaviour.
                e.preventDefault()
                e.stopPropagation()
                activate(item)
                break
              }
              // Escape is handled by the document-level listener so it
              // still fires when focus has drifted away from the menu.
              default:
                break
            }
          }}
        >
          {item.label}
        </li>
      ))}
    </ul>
  )
}
