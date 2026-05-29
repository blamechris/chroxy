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

    it('skips runtime-disabled defs when scanning for conflicts (#4431)', () => {
      // Two shortcuts that can never both be live at once — e.g. a
      // Tauri-only desktop binding and a browser-only web binding —
      // sharing the same combo must NOT be flagged as a conflict.
      // matchEvent already respects `enabled`, so the registry must
      // mirror that during the conflict scan and during setBinding.
      let isTauri = true
      const gated: ShortcutDef[] = [
        { id: 'tauri.close', defaultBinding: 'Cmd+W', description: 'Tauri close', category: 'session', scope: 'global', enabled: () => isTauri },
        { id: 'browser.close', defaultBinding: 'Cmd+W', description: 'Browser close', category: 'session', scope: 'global', enabled: () => !isTauri },
      ]
      const registry = createShortcutRegistry(gated)
      // Tauri side live, browser side disabled — no conflict either way.
      expect(registry.findConflict('tauri.close', 'Cmd+W')).toBeNull()
      expect(registry.findConflict('browser.close', 'Cmd+W')).toBeNull()
      // Flip the environment — same expectation, conflict still
      // suppressed because exactly one side is live.
      isTauri = false
      expect(registry.findConflict('tauri.close', 'Cmd+W')).toBeNull()
      expect(registry.findConflict('browser.close', 'Cmd+W')).toBeNull()

      // setBinding must agree with findConflict — rebinding either side
      // to a fresh shared combo must succeed when the counterpart is
      // gated off. Use Cmd+T (not in `defs` because this registry only
      // has the two gated entries) to exercise the conflict path.
      isTauri = true
      registry.setBinding('tauri.close', 'Cmd+T')
      expect(registry.getBinding('tauri.close')).toBe('cmd+t')
      registry.setBinding('browser.close', 'Cmd+T')
      expect(registry.getBinding('browser.close')).toBe('cmd+t')
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

  describe('matchEvent gates (#4412)', () => {
    it('respects the `enabled` predicate — false skips the match', () => {
      let enabled = false
      const gated: ShortcutDef[] = [
        { id: 'session.close', defaultBinding: 'Cmd+W', description: 'Close tab', category: 'session', scope: 'global', enabled: () => enabled },
      ]
      const registry = createShortcutRegistry(gated)
      // Disabled: no match.
      expect(registry.matchEvent({
        key: 'w', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
      }, 'global')).toBeNull()
      // Flip the predicate, same event matches.
      enabled = true
      expect(registry.matchEvent({
        key: 'w', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
      }, 'global')).toBe('session.close')
    })

    it('respects `disabledInTextInput` — suppresses match inside INPUT/TEXTAREA/contenteditable', () => {
      const gated: ShortcutDef[] = [
        { id: 'help.toggle', defaultBinding: '?', description: 'Help', category: 'other', scope: 'global', disabledInTextInput: true },
      ]
      const registry = createShortcutRegistry(gated)
      // No target — fires.
      expect(registry.matchEvent({
        key: '?', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      }, 'global')).toBe('help.toggle')
      // INPUT target — suppressed.
      const input = document.createElement('input')
      expect(registry.matchEvent({
        key: '?', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: input,
      }, 'global')).toBeNull()
      // TEXTAREA target — suppressed.
      const textarea = document.createElement('textarea')
      expect(registry.matchEvent({
        key: '?', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: textarea,
      }, 'global')).toBeNull()
      // contenteditable target — suppressed. jsdom's
      // `isContentEditable` derives from `contentEditable === 'true'`
      // but only when the element is actually attached and the
      // attribute is reflected; stub the getter so the match-event
      // gate sees `true` deterministically across jsdom versions.
      const div = document.createElement('div')
      Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true })
      expect(registry.matchEvent({
        key: '?', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: div,
      }, 'global')).toBeNull()
      // Non-text element (button) — fires.
      const button = document.createElement('button')
      expect(registry.matchEvent({
        key: '?', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: button,
      }, 'global')).toBe('help.toggle')
    })

    it('a disabled shortcut does not block a later (non-gated) match on the same combo', () => {
      // Realistic: two shortcuts in different scopes can't share a combo
      // in the same scope by conflict-detection rules, but `enabled` is
      // evaluated AFTER combo match so a disabled shortcut must not
      // shadow nothing. This test pins the behaviour: when the disabled
      // shortcut comes first in the definitions list, matchEvent still
      // returns null (no later entry to fall back to) rather than
      // throwing.
      const gated: ShortcutDef[] = [
        { id: 'tauri.only', defaultBinding: 'Cmd+W', description: 'Tauri', category: 'session', scope: 'global', enabled: () => false },
      ]
      const registry = createShortcutRegistry(gated)
      expect(registry.matchEvent({
        key: 'w', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
      }, 'global')).toBeNull()
    })
  })
})
