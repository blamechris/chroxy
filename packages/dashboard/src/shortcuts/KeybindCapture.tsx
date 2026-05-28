/**
 * KeybindCapture — focused input that captures the next keystroke
 * combo and emits it to the parent (#3852).
 *
 * Interaction model (matches VSCode's rebind UI):
 *   - On mount, focus the button.
 *   - The user presses a key combo. We swallow modifier-only presses
 *     and only emit once a non-modifier key arrives.
 *   - Esc cancels (`onCancel`) without emitting.
 *   - We intentionally prevent default so editor-host shortcuts (Cmd+K
 *     etc.) don't double-fire during capture.
 */
import { useEffect, useRef } from 'react'
import { normalizeBinding } from './registry'

export interface KeybindCaptureProps {
  onCapture: (binding: string) => void
  onCancel: () => void
}

const MODIFIER_KEYS = new Set([
  'meta', 'control', 'shift', 'alt', 'option', 'os', 'hyper', 'super',
  'capslock', 'numlock', 'scrolllock', 'fn', 'dead',
])

export function KeybindCapture({ onCapture, onCancel }: KeybindCaptureProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    buttonRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        onCancel()
        return
      }
      const keyLower = (e.key || '').toLowerCase()
      if (MODIFIER_KEYS.has(keyLower)) return
      const parts: string[] = []
      if (e.metaKey || e.ctrlKey) parts.push('cmd')
      if (e.shiftKey) parts.push('shift')
      if (e.altKey) parts.push('alt')
      parts.push(keyLower)
      const binding = normalizeBinding(parts.join('+'))
      onCapture(binding)
    }
    // Capture phase so we beat the App.tsx global keydown ladder while
    // the rebind UI is active.
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions)
  }, [onCapture, onCancel])

  return (
    <button
      ref={buttonRef}
      type="button"
      className="keybind-capture"
      aria-label="Press a key combination, or Escape to cancel"
      data-testid="keybind-capture"
      onBlur={onCancel}
      onClick={e => e.preventDefault()}
    >
      Press a key combination…
    </button>
  )
}
