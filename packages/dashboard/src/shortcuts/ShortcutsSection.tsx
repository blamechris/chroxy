/**
 * ShortcutsSection — Settings panel section that lists every
 * customizable shortcut and lets the user rebind or reset each one
 * (#3852).
 *
 * Layout:
 *   <h3>Keyboard Shortcuts</h3>
 *   ─ description ┬ binding chip ┬ Edit ┬ Reset
 *
 * The Edit button swaps the binding chip for a KeybindCapture input.
 * If the captured combo conflicts with another shortcut in the same
 * scope, we surface the collision inline (red badge naming the other
 * action) instead of silently overwriting. The user can either pick a
 * different combo or cancel.
 */
import { useState } from 'react'
import { isMacPlatform } from '../utils/platform'
import { useShortcutRegistry } from './useShortcutRegistry'
import { KeybindCapture } from './KeybindCapture'
import { formatBindingForDisplay, type ShortcutCategory } from './registry'

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  navigation: 'Navigation',
  composer: 'Composer',
  session: 'Session',
  view: 'View',
  sidebar: 'Sidebar',
  other: 'Other',
}

const CATEGORY_ORDER: ShortcutCategory[] = ['navigation', 'view', 'session', 'sidebar', 'composer', 'other']

export function ShortcutsSection() {
  const registry = useShortcutRegistry()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isMac = isMacPlatform()

  // useMemo intentionally omitted — registry.list() is cheap and the
  // hook already re-renders on every binding change. Memoising on
  // [registry] would skip updates because the registry reference is
  // stable across renders.
  const grouped = (() => {
    const map = new Map<ShortcutCategory, ReturnType<typeof registry.list>>()
    for (const entry of registry.list()) {
      const bucket = map.get(entry.category) || []
      bucket.push(entry)
      map.set(entry.category, bucket)
    }
    return CATEGORY_ORDER
      .filter(c => map.has(c))
      .map(c => ({ category: c, entries: map.get(c)! }))
  })()

  const handleCapture = (id: string) => (binding: string) => {
    try {
      registry.setBinding(id, binding)
      setError(null)
      setEditingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      // Stay in edit mode so the user can try a different combo or
      // cancel.
    }
  }

  const handleCancel = () => {
    setEditingId(null)
    setError(null)
  }

  return (
    <section className="settings-section" data-testid="shortcuts-section">
      <div className="settings-section-header">
        <h3>Keyboard Shortcuts</h3>
        <button
          type="button"
          className="settings-link-button"
          onClick={() => registry.resetAll()}
          data-testid="shortcuts-reset-all"
        >
          Reset all
        </button>
      </div>
      <p className="settings-hint">
        Click Edit next to a shortcut and press a new key combination. Press Escape to cancel.
      </p>
      {error && (
        <div className="settings-error" role="alert" data-testid="shortcuts-error">
          {error}
        </div>
      )}
      {grouped.map(({ category, entries }) => (
        <div key={category} className="shortcuts-group">
          <h4 className="shortcuts-group-title">{CATEGORY_LABELS[category]}</h4>
          <ul className="shortcuts-list">
            {entries.map(entry => {
              const isEditing = editingId === entry.id
              const displayBinding = formatBindingForDisplay(entry.binding, isMac)
              const defaultDisplay = formatBindingForDisplay(entry.defaultBinding, isMac)
              // #4970 — sessionbar scope is informational-only: the actual
              // handler in SessionBar.tsx hardcodes the keys (Shift+Space,
              // arrows, etc.) and never consults `registry.matchEvent`. A
              // rebind here would silently do nothing — the cheat sheet,
              // tooltip, and SR announcement would all advertise the new
              // combo while the tab still only responds to the original
              // keys. Disable Edit/Reset for this scope until the handler
              // is migrated to `registry.matchEvent` (see issue #4970).
              const isReadOnly = entry.scope === 'sessionbar'
              const readOnlyTitle = 'Not rebindable yet — this shortcut is fixed in this release.'
              return (
                <li key={entry.id} className="shortcuts-section-row" data-testid={`shortcut-row-${entry.id}`}>
                  <div className="shortcuts-section-row-description">
                    <span>{entry.description}</span>
                    {entry.isCustomized && (
                      <span className="shortcuts-section-row-default" title={`Default: ${defaultDisplay}`}>
                        (default {defaultDisplay})
                      </span>
                    )}
                    {isReadOnly && (
                      <span
                        className="shortcuts-section-row-readonly"
                        data-testid={`shortcut-readonly-${entry.id}`}
                        title={readOnlyTitle}
                      >
                        (not rebindable)
                      </span>
                    )}
                  </div>
                  <div className="shortcuts-section-row-controls">
                    {isEditing ? (
                      <KeybindCapture
                        onCapture={handleCapture(entry.id)}
                        onCancel={handleCancel}
                      />
                    ) : (
                      <kbd className="shortcuts-section-row-binding" data-testid={`shortcut-binding-${entry.id}`}>
                        {displayBinding}
                      </kbd>
                    )}
                    {!isEditing && (
                      <>
                        <button
                          type="button"
                          className="settings-secondary-button"
                          onClick={() => { setEditingId(entry.id); setError(null) }}
                          disabled={isReadOnly}
                          title={isReadOnly ? readOnlyTitle : undefined}
                          data-testid={`shortcut-edit-${entry.id}`}
                          aria-label={`Edit shortcut for ${entry.description}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="settings-secondary-button"
                          onClick={() => registry.resetBinding(entry.id)}
                          disabled={isReadOnly || !entry.isCustomized}
                          title={isReadOnly ? readOnlyTitle : undefined}
                          data-testid={`shortcut-reset-${entry.id}`}
                          aria-label={`Reset shortcut for ${entry.description}`}
                        >
                          Reset
                        </button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </section>
  )
}
