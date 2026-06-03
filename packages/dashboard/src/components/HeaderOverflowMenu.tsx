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
 *
 * #4980 — full WAI-ARIA Authoring Practices menu keyboard pattern:
 *   - Initial focus moves into the first item when the menu opens
 *   - ArrowDown / ArrowUp move focus between items (wrap-around)
 *   - Home / End jump to first / last item
 *   - Enter / Space activate the focused item
 *   - Escape dismisses + returns focus to the trigger
 *   - Roving tabindex: only the currently-focused item is tabIndex={0}
 *   - Focus returns to the trigger after outside-click dismissal and
 *     after item activation
 *   - aria-controls on the trigger pointing at the menu id
 *
 * Mirrors the SessionContextMenu (#4248) pattern verbatim — both menus
 * now satisfy the same WAI-ARIA acceptance set.
 */
import { useEffect, useId, useRef, useState } from 'react'

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
  // #4980 — roving tabindex requires tracking the currently-focused index.
  // Reset to 0 when the menu opens so re-opens always land on the first item.
  const [focusedIndex, setFocusedIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  // #4980 — item refs for imperative focus; mirrors SessionContextMenu.
  // Using a ref array instead of querySelector keeps the API independent
  // of the data-testid contract and avoids DOM lookups on every focus shift.
  const itemRefs = useRef<(HTMLLIElement | null)[]>([])
  // #4980 — stable id for aria-controls wire-up between trigger and menu.
  // useId is React 18+ SSR-safe; matches the rest of the codebase pattern.
  const menuId = useId()
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
      // #4980 — focus restoration is handled centrally by the cleanup
      // effect below; just flip `open` and let all dismiss paths
      // converge through the same restore branch.
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
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

  // #4980 — on open, reset focus to the first item AND imperatively
  // focus it. setFocusedIndex(0) covers the case where the menu was
  // last closed on a non-first item. The imperative focus() is
  // necessary because tabIndex={0} only governs Tab traversal, not
  // programmatic focus on mount.
  useEffect(() => {
    if (!open) return
    setFocusedIndex(0)
    const first = itemRefs.current[0]
    if (first) first.focus()
  }, [open])

  // #4980 (review feedback PR #4996) — single focus-restore cleanup that
  // runs whenever `open` transitions true → false so every dismiss path
  // (Escape, outside-click, window blur, item activation) converges
  // reliably. Without this, the window.blur path silently skipped focus
  // restore, and the per-branch `triggerRef.current?.focus()` calls
  // during mousedown could race the browser's own focus-on-click. This
  // mirrors SessionContextMenu's unmount focus-restore pattern (#4248).
  //
  // We snapshot whatever was focused at the moment the menu opens,
  // falling back to the trigger button (which is always how the menu
  // was opened from a user gesture, even if the click didn't move
  // browser focus). The `isConnected` guard handles the case where the
  // snapshot was removed from the DOM during the menu lifetime — e.g.
  // the parent re-rendered and unmounted the trigger.
  useEffect(() => {
    if (!open) return
    const active = document.activeElement as HTMLElement | null
    // If focus is on <body> or a still-mounted menu item from a prior
    // interaction, fall back to the trigger — that's the conventional
    // anchor a keyboard user expects to land back on.
    const previouslyFocused =
      active && active !== document.body && !menuRef.current?.contains(active)
        ? active
        : triggerRef.current
    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus()
      }
    }
  }, [open])

  // #4980 — when focusedIndex changes (via arrow keys / Home / End),
  // imperatively move focus to the matching item. Same pattern as
  // SessionContextMenu.
  useEffect(() => {
    if (!open) return
    const target = itemRefs.current[focusedIndex]
    if (target && document.activeElement !== target) {
      target.focus()
    }
  }, [focusedIndex, open])

  // #4980 (review feedback PR #4996) — clamp `focusedIndex` when the
  // visible item set shrinks while the menu is open (e.g. App.tsx gates
  // Copy Transcript on viewMode/hasMessages, so the row can disappear
  // mid-interaction). If we don't clamp, no <li> ends up with
  // tabIndex={0} and the focus-sync effect above reads a null ref —
  // arrow nav silently stops working until the menu is re-opened.
  useEffect(() => {
    if (!open) return
    if (focusedIndex >= visibleItems.length && visibleItems.length > 0) {
      setFocusedIndex(visibleItems.length - 1)
    }
  }, [visibleItems.length, focusedIndex, open])

  if (visibleItems.length === 0) return null

  const activate = (item: HeaderOverflowItem) => {
    try {
      item.onClick?.()
    } finally {
      // #4980 — focus restoration handled by the open-transition cleanup
      // effect above; just flip `open` here.
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
        // #4980 — aria-controls wires the trigger to the menu's id so
        // assistive tech can announce the relationship. Only meaningful
        // when the menu is open (the popover doesn't exist otherwise),
        // but per WAI-ARIA the attribute is allowed regardless and most
        // ATs handle the closed case gracefully.
        aria-controls={menuId}
        title={triggerLabel}
      >
        &#x22EF;
      </button>
      {open && (
        <ul
          ref={menuRef}
          id={menuId}
          className="header-overflow-menu"
          data-testid="header-overflow-menu"
          role="menu"
          aria-orientation="vertical"
        >
          {visibleItems.map((item, index) => (
            <li
              key={item.id}
              ref={(node) => {
                itemRefs.current[index] = node
              }}
              role="menuitem"
              // #4980 — roving tabindex: only the currently-focused item
              // is in the Tab order. The rest stay programmatically
              // focusable (we move focus via the arrow-key handler)
              // without polluting the surrounding header's Tab order.
              tabIndex={focusedIndex === index ? 0 : -1}
              data-testid={`header-overflow-item-${item.id}`}
              className="header-overflow-menu-item"
              title={item.title}
              onClick={() => activate(item)}
              onKeyDown={(e) => {
                switch (e.key) {
                  case 'ArrowDown': {
                    e.preventDefault()
                    e.stopPropagation()
                    setFocusedIndex((i) => (i + 1) % visibleItems.length)
                    break
                  }
                  case 'ArrowUp': {
                    e.preventDefault()
                    e.stopPropagation()
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
                    e.preventDefault()
                    e.stopPropagation()
                    activate(item)
                    break
                  }
                  // Escape is handled at the document level so it still
                  // fires when focus has drifted away from the menu.
                  default:
                    break
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
