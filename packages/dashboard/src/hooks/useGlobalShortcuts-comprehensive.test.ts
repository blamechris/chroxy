/**
 * Comprehensive keyboard shortcuts test (#1115).
 *
 * Source-level tests verifying the dashboard still covers all required
 * shortcuts from the IDE shortcut map.
 *
 * #3852 split the source of truth in two:
 *  - User-rebindable shortcuts (palette, sidebar, settings, new
 *    session) now live in the shortcut registry's defaults file. We
 *    import the registry directly so these tests track the binding
 *    declaratively rather than scraping App.tsx text.
 *  - The remaining shortcuts (Cmd+1-9, Cmd+Shift+[/], Cmd+W,
 *    Cmd+Shift+P, Cmd+Shift+D, Cmd+.) are still hand-rolled in
 *    App.tsx's keydown ladder, so we keep the textual grep for them.
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

  it('has Cmd+1-9 for tab switching', () => {
    expect(appSource).toMatch(/e\.key\s*>=\s*'1'/)
  })

  it('has Cmd+Shift+[/] for prev/next tab', () => {
    expect(appSource).toMatch(/e\.key\s*===\s*'\['/)
  })

  it('has Cmd+W for close tab', () => {
    expect(appSource).toMatch(/e\.key\s*===\s*'w'/)
  })

  it('has Cmd+B for sidebar toggle (via shortcut registry)', () => {
    expect(defaultBindingFor('sidebar.toggle')).toBe('cmd+b')
  })

  it('has Cmd+Shift+P for command palette alias', () => {
    expect(appSource).toMatch(/e\.key.*'p'/)
    expect(appSource).toMatch(/e\.shiftKey.*'p'|'p'.*e\.shiftKey/)
  })

  it('has Cmd+Shift+D for toggle view mode', () => {
    expect(appSource).toMatch(/e\.key.*'d'/)
    expect(appSource).toMatch(/setViewMode/)
  })

  it('has Cmd+. for interrupt', () => {
    expect(appSource).toMatch(/e\.key\s*===\s*'\.'/)
    expect(appSource).toMatch(/sendInterrupt\(\)/)
  })
})
