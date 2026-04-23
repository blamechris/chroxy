/**
 * Theme engine tests (#1526)
 *
 * Tests theme application, localStorage persistence, and CSS variable injection.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getThemeById, BUILT_IN_THEMES } from './themes'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

/**
 * Parse theme.css for all color-token `--name:` declarations inside `:root`.
 *
 * Returns only tokens considered "themeable" — excludes font/typography/spacing
 * tokens (--font-*, --text-xs/sm/base/md/lg, --space-*) which are structural
 * and intentionally not in ALL_CSS_VARS (they aren't overridden by themes).
 */
function parseRootTokensFromCss(): string[] {
  const cssPath = join(__dirname, 'theme.css')
  const css = readFileSync(cssPath, 'utf-8')

  // Extract the `:root { ... }` block
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/)
  if (!rootMatch || !rootMatch[1]) {
    throw new Error('Could not locate :root block in theme.css')
  }
  const rootBody: string = rootMatch[1]

  // Match every `--token-name:` declaration
  const names: string[] = []
  const decl = /--([a-zA-Z0-9-]+)\s*:/g
  let m: RegExpExecArray | null
  while ((m = decl.exec(rootBody)) !== null) {
    if (m[1]) names.push(m[1])
  }

  // Exclude non-themeable structural tokens
  const excludePrefixes = ['font-', 'text-xs', 'text-sm', 'text-base', 'text-md', 'text-lg', 'space-']
  return names.filter((n) => !excludePrefixes.some((p) => n === p || n.startsWith(p)))
}

describe('theme-engine ALL_CSS_VARS consistency', () => {
  it('every themeable --var in theme.css is registered in ALL_CSS_VARS cleanup list', async () => {
    // Import the module so we can access ALL_CSS_VARS via the exported helper
    const engineModule = await import('./theme-engine')
    const cssTokens = parseRootTokensFromCss()

    // Apply a synthetic theme that sets every parsed token, then switch back to
    // default — any token absent from ALL_CSS_VARS will leak past the cleanup.
    const root = document.documentElement
    root.style.cssText = ''
    for (const name of cssTokens) {
      root.style.setProperty(`--${name}`, 'rgb(1, 2, 3)')
    }

    engineModule.applyTheme(getThemeById('default'))

    const leaked: string[] = []
    for (const name of cssTokens) {
      if (root.style.getPropertyValue(`--${name}`) !== '') {
        leaked.push(name)
      }
    }
    expect(leaked).toEqual([])
  })

  it('includes warning-fg and banner-border-subtle (PR #2876 follow-up)', async () => {
    const root = document.documentElement
    root.style.cssText = ''
    root.style.setProperty('--warning-fg', '#fbbf24')
    root.style.setProperty('--banner-border-subtle', '#252540')

    const { applyTheme } = await import('./theme-engine')
    applyTheme(getThemeById('default'))

    expect(root.style.getPropertyValue('--warning-fg')).toBe('')
    expect(root.style.getPropertyValue('--banner-border-subtle')).toBe('')
  })
})
