/**
 * useGlobalShortcuts — register global keyboard shortcuts.
 *
 * Parses shortcut strings like "cmd+shift+p" and fires handlers
 * when matching keydown events occur outside text inputs.
 *
 * Uses a ref internally so the listener is registered once on mount.
 * Callers do NOT need to stabilize the shortcuts object with useMemo.
 */
import { useEffect, useRef } from 'react'

export type ShortcutMap = Record<string, () => void>

interface ParsedShortcut {
  key: string
  meta: boolean
  shift: boolean
  alt: boolean
}

function parseShortcut(str: string): ParsedShortcut {
  const parts = str.toLowerCase().split('+')
  return {
    key: parts[parts.length - 1]!,
    meta: parts.includes('cmd') || parts.includes('ctrl'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  }
}

const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'email', 'password', 'tel', 'number',
])

function isTextInput(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || el.isContentEditable) return true
  if (tag === 'INPUT') {
    return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)
  }
  return false
}

export function useGlobalShortcuts(shortcuts: ShortcutMap): void {
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts

  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return

      const parsed = Object.entries(shortcutsRef.current).map(([str, handler]) => ({
        ...parseShortcut(str),
        handler,
      }))

      const key = e.key.toLowerCase()
      const meta = e.metaKey || e.ctrlKey
      const shift = e.shiftKey
      const alt = e.altKey

      for (const shortcut of parsed) {
        if (
          key === shortcut.key &&
          meta === shortcut.meta &&
          shift === shortcut.shift &&
          alt === shortcut.alt
        ) {
          e.preventDefault()
          shortcut.handler()
          return
        }
      }
    }

    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])
}
