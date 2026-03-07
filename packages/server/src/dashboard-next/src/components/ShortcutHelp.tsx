/**
 * ShortcutHelp — keyboard shortcut help overlay.
 *
 * Triggered by pressing '?'. Shows all available shortcuts grouped by section.
 */
import { useEffect, useRef } from 'react'

export interface ShortcutEntry {
  keys: string
  description: string
  section: string
}

export interface ShortcutHelpProps {
  isOpen: boolean
  onClose: () => void
  shortcuts: ShortcutEntry[]
}

export function ShortcutHelp({ isOpen, onClose, shortcuts }: ShortcutHelpProps) {
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const overlays = document.querySelectorAll('[data-modal-overlay]')
        if (overlays.length > 0 && overlays[overlays.length - 1] === backdropRef.current) {
          e.preventDefault()
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  // Group shortcuts by section
  const sections = new Map<string, ShortcutEntry[]>()
  for (const s of shortcuts) {
    const list = sections.get(s.section) || []
    list.push(s)
    sections.set(s.section, list)
  }

  return (
    <div ref={backdropRef} className="shortcut-help-overlay" data-modal-overlay onClick={onClose}>
      <div
        className="shortcut-help-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="shortcut-help-header">
          <h2 id="shortcut-help-title">Keyboard Shortcuts</h2>
          <button className="settings-close" onClick={onClose} aria-label="Close shortcuts" type="button">
            &times;
          </button>
        </div>
        <div className="shortcut-help-body">
          {[...sections.entries()].map(([section, entries]) => (
            <div key={section} className="shortcut-section">
              <h3>{section}</h3>
              <dl className="shortcut-list">
                {entries.map(entry => (
                  <div key={entry.keys} className="shortcut-row">
                    <dt><kbd>{entry.keys}</kbd></dt>
                    <dd>{entry.description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
