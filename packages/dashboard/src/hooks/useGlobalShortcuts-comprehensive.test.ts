/**
 * Comprehensive keyboard shortcuts test (#1115, #3852, #4412).
 *
 * Source-of-truth: the shortcut registry. Pre-#4412 a subset of
 * shortcuts (Cmd+1-9, Cmd+Shift+[/], Cmd+W, Cmd+Shift+P, Cmd+Shift+D,
 * Cmd+.) were hand-rolled in App.tsx's keydown ladder, so this file
 * grepped App.tsx text for them. After #4412 every global shortcut is
 * declared in `shortcuts/defaults.ts`, so every assertion below
 * inspects the registry definitions instead — declarative, robust to
 * dispatch-table refactors, and re-uses the registry types directly.
 *
 * Two non-registry assertions remain:
 *  - `sendInterrupt()` is wired to the `session.interrupt` shortcut
 *    in App.tsx — we still grep for the call to catch a regression
 *    where the dispatch arm is dropped.
 *  - `setViewMode` is wired to `view.toggleChatTerminal`.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DEFAULT_SHORTCUTS } from '../shortcuts/defaults'

const appSource = fs.readFileSync(
  path.resolve(__dirname, '../App.tsx'),
  'utf-8',
)

function defaultBindingFor(id: string): string {
  const entry = DEFAULT_SHORTCUTS.find(d => d.id === id)
  if (!entry) throw new Error(`Missing default for ${id}`)
  return entry.defaultBinding
}

describe('Comprehensive keyboard shortcuts (#1115)', () => {
  it('has Cmd+K for command palette (via shortcut registry)', () => {
    expect(defaultBindingFor('palette.toggle')).toBe('cmd+k')
  })

  it('has Cmd+N for new session (via shortcut registry)', () => {
    expect(defaultBindingFor('session.new')).toBe('cmd+n')
  })

  it('has Cmd+1-9 for tab switching (via shortcut registry — one entry per digit)', () => {
    for (let n = 1; n <= 9; n += 1) {
      expect(defaultBindingFor(`session.switch.${n}`)).toBe(`cmd+${n}`)
    }
  })

  it('has Cmd+Shift+[/] for prev/next tab (via shortcut registry)', () => {
    expect(defaultBindingFor('session.prev')).toBe('cmd+shift+[')
    expect(defaultBindingFor('session.next')).toBe('cmd+shift+]')
  })

  it('has Cmd+W for close tab (via shortcut registry)', () => {
    expect(defaultBindingFor('session.close')).toBe('cmd+w')
  })

  it('has Cmd+B for sidebar toggle (via shortcut registry)', () => {
    expect(defaultBindingFor('sidebar.toggle')).toBe('cmd+b')
  })

  it('has Cmd+Shift+P for command palette alias (via shortcut registry)', () => {
    expect(defaultBindingFor('palette.toggle.vscode')).toBe('cmd+shift+p')
  })

  it('has Cmd+Shift+D for toggle view mode (via shortcut registry + App dispatch)', () => {
    expect(defaultBindingFor('view.toggleChatTerminal')).toBe('cmd+shift+d')
    expect(appSource).toMatch(/setViewMode/)
  })

  it('has Cmd+. for interrupt (via shortcut registry + App dispatch)', () => {
    expect(defaultBindingFor('session.interrupt')).toBe('cmd+.')
    expect(appSource).toMatch(/sendInterrupt\(\)/)
  })

  it('has Cmd+\\ for cycle split view (via shortcut registry)', () => {
    expect(defaultBindingFor('view.cycleSplit')).toBe('cmd+\\')
  })

  it('has Cmd+Shift+T for copy transcript (via shortcut registry)', () => {
    expect(defaultBindingFor('session.copyTranscript')).toBe('cmd+shift+t')
  })

  it('has Shift+Tab for toggle plan mode (via shortcut registry, gated in text inputs)', () => {
    const entry = DEFAULT_SHORTCUTS.find(d => d.id === 'session.togglePlanMode')
    expect(entry?.defaultBinding).toBe('shift+tab')
    expect(entry?.disabledInTextInput).toBe(true)
  })

  it('has ? for shortcut help (via shortcut registry, gated in text inputs)', () => {
    const entry = DEFAULT_SHORTCUTS.find(d => d.id === 'help.toggle')
    expect(entry?.defaultBinding).toBe('?')
    expect(entry?.disabledInTextInput).toBe(true)
  })
})
