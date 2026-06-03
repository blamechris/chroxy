/**
 * HeaderOverflowMenu (#4974) — collapses the tertiary header icons
 * (Skills, Copy Transcript, Settings) behind a single "..." trigger so
 * the prominent `+ New Session` button (#4943) and the model selector
 * dropdown no longer collide at narrow desktop widths.
 *
 * Before #4974 the right zone laid out as:
 *   [+ New Session] [Skills] [Copy?] [Settings] [StatusBar]
 * which under ~1400px overlapped the model-selector chevron in the
 * center zone. After this PR:
 *   [+ New Session] [⋯] [StatusBar]
 *
 * The popover reuses the same dismiss pattern as SessionContextMenu —
 * outside click (capturing mousedown so we close before any underlying
 * row handler fires), Escape, window blur — and is positioned with CSS
 * relative to the trigger button rather than a runtime measurement so
 * SSR / first-paint stays simple.
 *
 * Caller provides the visible items via the `items[]` prop. Items with
 * a falsy `onClick` are filtered out (capability gate — e.g. "Copy
 * transcript" only shows up in chat view with at least one message).
 * This keeps the trigger from being a no-op three-dots when nothing
 * collapses into it.
 */
import { useEffect, useRef, useState } from 'react'

export interface HeaderOverflowItem {
  /** Stable id used as React key and `data-testid` suffix. */
  id: string
  /** Visible label inside the dropdown row. */
  label: string
  /** Optional glyph rendered alongside the label (decorative). */
  icon?: string
  /** Action — when falsy, the item is skipped entirely. */
  onClick?: () => void
  /** Optional title attribute (tooltip) for the row. */
  title?: string
}

export interface HeaderOverflowMenuProps {
  items: HeaderOverflowItem[]
  /** Optional override for the trigger's aria-label / title. */
  triggerLabel?: string
}

export function HeaderOverflowMenu({
  items,
  triggerLabel = 'More actions',
}: HeaderOverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const visibleItems = items.filter((i) => typeof i.onClick === 'function')

  useEffect(() => {
    if (!open) return
    // Capturing-phase mousedown so an outside click dismisses the menu
    // BEFORE any underlying button handler fires. Matches the dismiss
    // pattern used by SessionContextMenu.
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current && menuRef.current.contains(target)) return
      if (triggerRef.current && triggerRef.current.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onBlur = () => setOpen(false)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  if (visibleItems.length === 0) return null

  const activate = (item: HeaderOverflowItem) => {
    try {
      item.onClick?.()
    } finally {
      setOpen(false)
    }
  }

  return (
    <div className="header-overflow">
      <button
        ref={triggerRef}
        type="button"
        className="header-icon-btn header-overflow-trigger"
        data-testid="header-overflow-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerLabel}
      >
        &#x22EF;
      </button>
      {open && (
        <ul
          ref={menuRef}
          className="header-overflow-menu"
          data-testid="header-overflow-menu"
          role="menu"
          aria-orientation="vertical"
        >
          {visibleItems.map((item) => (
            <li
              key={item.id}
              role="menuitem"
              tabIndex={0}
              data-testid={`header-overflow-item-${item.id}`}
              className="header-overflow-menu-item"
              title={item.title}
              onClick={() => activate(item)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  activate(item)
                }
              }}
            >
              {item.icon ? (
                <span className="header-overflow-menu-icon" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span className="header-overflow-menu-label">{item.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
