/**
 * Theme application engine.
 *
 * Applies theme color overrides by setting CSS custom properties on :root.
 * The default theme removes overrides so theme.css values take effect.
 *
 * Initializes synchronously on import to avoid a flash of unstyled content.
 */

import { getThemeById, BUILT_IN_THEMES } from './themes'
import type { ThemeDefinition, TerminalTheme } from './themes'

const STORAGE_KEY = 'chroxy_persist_theme'

/** All CSS variable names from theme.css (used to clear overrides) */
const ALL_CSS_VARS = [
  'bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-card', 'bg-input',
  'bg-terminal', 'bg-header', 'bg-session-bar', 'bg-code-block',
  'bg-tool-bubble', 'bg-permission', 'bg-question', 'bg-plan-banner', 'bg-modal',
  'text-primary', 'text-secondary', 'text-muted', 'text-dim', 'text-disabled',
  'text-error', 'text-system', 'text-link', 'text-emphasis', 'text-heading', 'text-blockquote',
  'accent-blue', 'accent-green', 'accent-purple', 'accent-orange', 'accent-red',
  'accent-blue-light', 'accent-blue-subtle', 'accent-blue-border', 'accent-blue-border-strong',
  'accent-green-light', 'accent-green-border', 'accent-green-border-strong',
  'accent-purple-light', 'accent-purple-subtle', 'accent-purple-border-strong', 'accent-purple-code',
  'accent-orange-light', 'accent-orange-subtle', 'accent-orange-medium',
  'accent-orange-border', 'accent-orange-border-strong',
  'accent-red-light', 'accent-red-subtle', 'accent-red-border',
  'border-primary', 'border-secondary', 'border-subtle', 'border-focus',
  'border-permission', 'border-question',
  'banner-border-subtle',
  'warning-fg',
  'status-connected', 'status-disconnected', 'status-connecting', 'status-restarting',
  'syntax-keyword', 'syntax-string', 'syntax-comment', 'syntax-number',
  'syntax-function', 'syntax-operator', 'syntax-punctuation', 'syntax-plain',
  'syntax-type', 'syntax-property',
  'diff-add-bg', 'diff-remove-bg', 'diff-add-text', 'diff-remove-text',
  'scrollbar-track', 'scrollbar-thumb', 'scrollbar-thumb-hover',
]

let _currentTheme: ThemeDefinition = getThemeById('default')

/** Apply a theme by setting CSS custom properties on :root */
export function applyTheme(theme: ThemeDefinition): void {
  const root = document.documentElement

  if (theme.id === 'default' || Object.keys(theme.colors).length === 0) {
    // Clear all overrides — revert to theme.css values
    for (const varName of ALL_CSS_VARS) {
      root.style.removeProperty(`--${varName}`)
    }
  } else {
    // First clear any previous overrides for vars not in this theme
    for (const varName of ALL_CSS_VARS) {
      if (!(varName in theme.colors)) {
        root.style.removeProperty(`--${varName}`)
      }
    }
    // Apply new overrides
    for (const [varName, value] of Object.entries(theme.colors)) {
      root.style.setProperty(`--${varName}`, value)
    }
  }

  _currentTheme = theme

  // Persist
  try {
    localStorage.setItem(STORAGE_KEY, theme.id)
  } catch {
    // localStorage not available
  }
}

/** Get the current active theme ID */
export function getCurrentThemeId(): string {
  return _currentTheme.id
}

/** Get the current theme definition */
export function getCurrentTheme(): ThemeDefinition {
  return _currentTheme
}

/** Get xterm.js terminal theme for the active theme */
export function getTerminalTheme(): TerminalTheme {
  return _currentTheme.terminal
}

/** Get all available themes */
export function getAvailableThemes(): ThemeDefinition[] {
  return BUILT_IN_THEMES
}

/** Load persisted theme ID from localStorage */
export function loadPersistedThemeId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? 'default'
  } catch {
    return 'default'
  }
}

// ---------------------------------------------------------------------------
// Auto-initialize on import — apply persisted theme before React mounts
// ---------------------------------------------------------------------------

const savedId = loadPersistedThemeId()
if (savedId !== 'default') {
  const theme = getThemeById(savedId)
  applyTheme(theme)
}
