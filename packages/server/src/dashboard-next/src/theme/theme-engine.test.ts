/**
 * Theme engine tests (#1526)
 *
 * Tests theme application, localStorage persistence, and CSS variable injection.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { getThemeById, BUILT_IN_THEMES } from './themes'

describe('themes', () => {
  it('has at least 3 built-in themes', () => {
    expect(BUILT_IN_THEMES.length).toBeGreaterThanOrEqual(3)
  })

  it('returns default theme for unknown ID', () => {
    const theme = getThemeById('nonexistent')
    expect(theme.id).toBe('default')
  })

  it('returns correct theme by ID', () => {
    const hacker = getThemeById('hacker')
    expect(hacker.id).toBe('hacker')
    expect(hacker.name).toBe('Hacker')
  })

  it('default theme has empty colors (uses CSS fallback)', () => {
    const def = getThemeById('default')
    expect(Object.keys(def.colors).length).toBe(0)
  })

  it('non-default themes have terminal theme', () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(theme.terminal).toBeDefined()
      expect(theme.terminal.background).toBeTruthy()
      expect(theme.terminal.foreground).toBeTruthy()
    }
  })
})

describe('theme-engine', () => {
  beforeEach(() => {
    // Reset DOM style
    document.documentElement.style.cssText = ''
    localStorage.clear()
  })

  it('applyTheme sets CSS variables on :root', async () => {
    // Dynamic import to get a fresh module after localStorage reset
    const { applyTheme } = await import('./theme-engine')
    const hacker = getThemeById('hacker')
    applyTheme(hacker)

    const root = document.documentElement
    expect(root.style.getPropertyValue('--bg-primary')).toBe('#000000')
    expect(root.style.getPropertyValue('--text-primary')).toBe('#00ff41')
  })

  it('applyTheme clears overrides for default theme', async () => {
    const { applyTheme } = await import('./theme-engine')
    const hacker = getThemeById('hacker')
    applyTheme(hacker)
    expect(document.documentElement.style.getPropertyValue('--bg-primary')).toBe('#000000')

    const def = getThemeById('default')
    applyTheme(def)
    expect(document.documentElement.style.getPropertyValue('--bg-primary')).toBe('')
  })

  it('applyTheme persists theme ID to localStorage', async () => {
    const { applyTheme } = await import('./theme-engine')
    const midnight = getThemeById('midnight')
    applyTheme(midnight)
    expect(localStorage.getItem('chroxy_persist_theme')).toBe('midnight')
  })

  it('loadPersistedThemeId returns default when empty', async () => {
    const { loadPersistedThemeId } = await import('./theme-engine')
    expect(loadPersistedThemeId()).toBe('default')
  })

  it('getTerminalTheme returns active theme terminal colors', async () => {
    const { applyTheme, getTerminalTheme } = await import('./theme-engine')
    const hacker = getThemeById('hacker')
    applyTheme(hacker)
    const term = getTerminalTheme()
    expect(term.foreground).toBe('#00ff41')
  })
})
