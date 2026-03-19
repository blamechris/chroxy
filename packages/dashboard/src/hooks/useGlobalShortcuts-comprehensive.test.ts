/**
 * Comprehensive keyboard shortcuts test (#1115).
 *
 * Source-level tests verifying the keydown handler in App.tsx covers
 * all required shortcuts from the IDE shortcut map.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const appSource = fs.readFileSync(
  path.resolve(__dirname, '../App.tsx'),
  'utf-8',
)

describe('Comprehensive keyboard shortcuts (#1115)', () => {
  it('has Cmd+K for command palette', () => {
    expect(appSource).toMatch(/e\.key\s*===\s*'k'/)
  })

  it('has Cmd+N for new session', () => {
    expect(appSource).toMatch(/e\.key\s*===\s*'n'/)
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

  it('has Cmd+B for sidebar toggle', () => {
    expect(appSource).toMatch(/e\.key\s*===\s*'b'/)
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
