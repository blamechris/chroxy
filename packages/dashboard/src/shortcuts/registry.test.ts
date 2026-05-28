/**
 * Tests for the shortcut registry (#3852).
 *
 * The registry is the single source of truth for customizable shortcuts:
 *   - lookup by id returns the user override when present, otherwise the
 *     default
 *   - setBinding persists to localStorage and a follow-up read reflects
 *     the new value
 *   - conflict detection refuses to bind two shortcuts in the same scope
 *     to the same combo
 *   - resetBinding restores the default
 *   - normalizeBinding canonicalises "Cmd+K" / "cmd+k" / "Meta+k" to a
 *     single form so comparisons are reliable
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createShortcutRegistry,
  normalizeBinding,
  parseBinding,
  formatBindingForDisplay,
  STORAGE_KEY,
  type ShortcutDef,
} from './registry'

const defs: ShortcutDef[] = [
  { id: 'palette.toggle', defaultBinding: 'Cmd+K', description: 'Command palette', category: 'navigation', scope: 'global' },
  { id: 'sidebar.toggle', defaultBinding: 'Cmd+B', description: 'Toggle sidebar', category: 'view', scope: 'global' },
  { id: 'settings.open', defaultBinding: 'Cmd+,', description: 'Open settings', category: 'navigation', scope: 'global' },
  { id: 'session.new', defaultBinding: 'Cmd+N', description: 'New session', category: 'session', scope: 'global' },
]

describe('normalizeBinding', () => {
  it('lowercases modifiers and key', () => {
    expect(normalizeBinding('Cmd+K')).toBe('cmd+k')
    expect(normalizeBinding('CMD+SHIFT+P')).toBe('cmd+shift+p')
  })
  it('treats Meta and Ctrl as the same modifier slot (cmd)', () => {
    // Cross-platform: Meta on macOS == Ctrl elsewhere. Registry stores
    // the canonical "cmd" token.
    expect(normalizeBinding('Meta+K')).toBe('cmd+k')
    expect(normalizeBinding('Ctrl+K')).toBe('cmd+k')
  })
  it('orders modifiers deterministically (cmd, shift, alt)', () => {
    expect(normalizeBinding('Shift+Cmd+P')).toBe('cmd+shift+p')
    expect(normalizeBinding('Alt+Shift+Cmd+P')).toBe('cmd+shift+alt+p')
  })
  it('preserves punctuation keys', () => {
    expect(normalizeBinding('Cmd+,')).toBe('cmd+,')
    expect(normalizeBinding('Cmd+\\')).toBe('cmd+\\')
  })
})

describe('parseBinding', () => {
  it('parses a binding into a structured form for matching', () => {
    expect(parseBinding('Cmd+Shift+P')).toEqual({
      key: 'p', meta: true, shift: true, alt: false,
    })
    expect(parseBinding('?')).toEqual({
      key: '?', meta: false, shift: false, alt: false,
    })
  })
})

describe('formatBindingForDisplay', () => {
  it('renders mac-style on mac', () => {
    expect(formatBindingForDisplay('cmd+k', true)).toBe('Cmd+K')
    expect(formatBindingForDisplay('cmd+shift+p', true)).toBe('Cmd+Shift+P')
  })
  it('rewrites cmd to ctrl on non-mac', () => {
    expect(formatBindingForDisplay('cmd+k', false)).toBe('Ctrl+K')
  })
  it('handles punctuation keys without uppercasing them', () => {
    expect(formatBindingForDisplay('cmd+,', true)).toBe('Cmd+,')
    expect(formatBindingForDisplay('cmd+\\', true)).toBe('Cmd+\\')
  })
})

describe('createShortcutRegistry', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns the default binding when no override exists', () => {
    const registry = createShortcutRegistry(defs)
    expect(registry.getBinding('palette.toggle')).toBe('cmd+k')
  })

  it('returns the override when one is set', () => {
    const registry = createShortcutRegistry(defs)
    registry.setBinding('palette.toggle', 'Cmd+J')
    expect(registry.getBinding('palette.toggle')).toBe('cmd+j')
  })

  it('persists overrides to localStorage under the canonical key', () => {
    const registry = createShortcutRegistry(defs)
    registry.setBinding('palette.toggle', 'Cmd+J')
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({ 'palette.toggle': 'cmd+j' })
  })

  it('loads overrides from localStorage on construction', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'palette.toggle': 'cmd+j' }))
    const registry = createShortcutRegistry(defs)
    expect(registry.getBinding('palette.toggle')).toBe('cmd+j')
  })

  it('ignores malformed localStorage data and falls back to defaults', () => {
    localStorage.setItem(STORAGE_KEY, 'not json')
    const registry = createShortcutRegistry(defs)
    expect(registry.getBinding('palette.toggle')).toBe('cmd+k')
  })

  it('resetBinding removes the override', () => {
    const registry = createShortcutRegistry(defs)
    registry.setBinding('palette.toggle', 'Cmd+J')
    registry.resetBinding('palette.toggle')
    expect(registry.getBinding('palette.toggle')).toBe('cmd+k')
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw === null || JSON.parse(raw!)['palette.toggle'] === undefined).toBe(true)
  })

  it('returns the list of definitions with effective bindings', () => {
    const registry = createShortcutRegistry(defs)
    registry.setBinding('palette.toggle', 'Cmd+J')
    const list = registry.list()
    const palette = list.find(s => s.id === 'palette.toggle')!
    expect(palette.binding).toBe('cmd+j')
    expect(palette.defaultBinding).toBe('cmd+k')
    expect(palette.isCustomized).toBe(true)
    const sidebar = list.find(s => s.id === 'sidebar.toggle')!
    expect(sidebar.binding).toBe('cmd+b')
    expect(sidebar.isCustomized).toBe(false)
  })

  describe('conflict detection', () => {
    it('detects a conflict when two global shortcuts share the same binding', () => {
      const registry = createShortcutRegistry(defs)
      const conflict = registry.findConflict('palette.toggle', 'Cmd+B')
      expect(conflict?.id).toBe('sidebar.toggle')
    })

    it('refuses setBinding when the target combo collides in scope', () => {
      const registry = createShortcutRegistry(defs)
      expect(() => registry.setBinding('palette.toggle', 'Cmd+B'))
        .toThrow(/conflict/i)
      // Original binding is preserved
      expect(registry.getBinding('palette.toggle')).toBe('cmd+k')
    })

    it('does not flag a binding that only matches its own id', () => {
      const registry = createShortcutRegistry(defs)
      // Setting palette.toggle to its current value is a no-op, not a
      // self-conflict.
      expect(() => registry.setBinding('palette.toggle', 'Cmd+K')).not.toThrow()
      expect(registry.getBinding('palette.toggle')).toBe('cmd+k')
    })

    it('respects scope — same combo across different scopes is allowed', () => {
      const scoped: ShortcutDef[] = [
        ...defs,
        { id: 'composer.history.prev', defaultBinding: 'Cmd+K', description: 'Prev history', category: 'composer', scope: 'composer' },
      ]
      const registry = createShortcutRegistry(scoped)
      // palette.toggle (global) and composer.history.prev (composer) both
      // bound to Cmd+K — no conflict.
      expect(registry.findConflict('palette.toggle', 'Cmd+K')).toBeNull()
    })
  })

  it('notifies subscribers when a binding changes', () => {
    const registry = createShortcutRegistry(defs)
    let calls = 0
    const unsubscribe = registry.subscribe(() => { calls += 1 })
    registry.setBinding('palette.toggle', 'Cmd+J')
    expect(calls).toBe(1)
    registry.resetBinding('palette.toggle')
    expect(calls).toBe(2)
    unsubscribe()
    registry.setBinding('palette.toggle', 'Cmd+M')
    expect(calls).toBe(2)
  })

  it('matchEvent returns the shortcut id whose binding matches the event', () => {
    const registry = createShortcutRegistry(defs)
    // Simulate Cmd+K on Mac
    const match = registry.matchEvent({
      key: 'k', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
    }, 'global')
    expect(match).toBe('palette.toggle')
  })

  it('matchEvent treats ctrlKey and metaKey equivalently (cross-platform)', () => {
    const registry = createShortcutRegistry(defs)
    // Simulate Ctrl+K on Windows/Linux
    const match = registry.matchEvent({
      key: 'k', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false,
    }, 'global')
    expect(match).toBe('palette.toggle')
  })

  it('matchEvent returns null when no shortcut matches', () => {
    const registry = createShortcutRegistry(defs)
    const match = registry.matchEvent({
      key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
    }, 'global')
    expect(match).toBeNull()
  })

  it('matchEvent ignores shortcuts in other scopes', () => {
    const scoped: ShortcutDef[] = [
      ...defs,
      { id: 'composer.history.prev', defaultBinding: 'Up', description: 'Prev history', category: 'composer', scope: 'composer' },
    ]
    const registry = createShortcutRegistry(scoped)
    const match = registry.matchEvent({
      key: 'arrowup', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    }, 'global')
    expect(match).toBeNull()
  })
})
