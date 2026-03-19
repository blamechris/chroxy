/**
 * Theme definitions for the Chroxy dashboard.
 *
 * Each theme is a named preset that overrides CSS custom properties at runtime.
 * The `default` theme uses CSS values from theme.css as-is (empty overrides).
 * Other themes provide a full color map to replace all tokens.
 */

export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

export interface ThemeDefinition {
  id: string
  name: string
  description: string
  /** CSS variable overrides: key is the variable name without '--', value is the CSS value */
  colors: Record<string, string>
  /** xterm.js terminal theme */
  terminal: TerminalTheme
}

// ---------------------------------------------------------------------------
// Built-in themes
// ---------------------------------------------------------------------------

const defaultTheme: ThemeDefinition = {
  id: 'default',
  name: 'Default',
  description: 'Purple and blue dark theme',
  colors: {},
  terminal: {
    background: '#000000',
    foreground: '#e0e0e0',
    cursor: '#4a9eff',
    selectionBackground: '#4a9eff44',
  },
}

const hackerTheme: ThemeDefinition = {
  id: 'hacker',
  name: 'Hacker',
  description: 'Black and lime green',
  colors: {
    // Backgrounds
    'bg-primary': '#000000',
    'bg-secondary': '#0a0a0a',
    'bg-tertiary': '#050505',
    'bg-card': '#111111',
    'bg-input': '#000000',
    'bg-terminal': '#000000',
    'bg-header': '#080808',
    'bg-session-bar': '#060606',
    'bg-code-block': '#020202',
    'bg-tool-bubble': '#0a0a0a',
    'bg-permission': '#0a1a0a',
    'bg-question': '#0a1a0a',
    'bg-plan-banner': '#0a1a0a',
    'bg-modal': '#0a0a0a',

    // Text
    'text-primary': '#00ff41',
    'text-secondary': '#00cc33',
    'text-muted': '#009926',
    'text-dim': '#006619',
    'text-disabled': '#004d13',
    'text-error': '#ff4444',
    'text-system': '#00aa2e',
    'text-link': '#00ff41',
    'text-emphasis': '#33ff66',
    'text-heading': '#00ff41',
    'text-blockquote': '#008822',

    // Accents
    'accent-blue': '#00ff41',
    'accent-green': '#00ff41',
    'accent-purple': '#00cc33',
    'accent-orange': '#ccff00',
    'accent-red': '#ff4444',

    // Accent variants
    'accent-blue-light': '#00ff4122',
    'accent-blue-subtle': '#00ff4133',
    'accent-blue-border': '#00ff4144',
    'accent-blue-border-strong': '#00ff4166',
    'accent-green-light': '#00ff4122',
    'accent-green-border': '#00ff4133',
    'accent-green-border-strong': '#00ff4166',
    'accent-purple-light': '#00cc3322',
    'accent-purple-subtle': '#00cc3333',
    'accent-purple-border-strong': '#00cc3366',
    'accent-purple-code': '#33ff66',
    'accent-orange-light': '#ccff0011',
    'accent-orange-subtle': '#ccff0022',
    'accent-orange-medium': '#ccff0033',
    'accent-orange-border': '#ccff0044',
    'accent-orange-border-strong': '#ccff0066',
    'accent-red-light': '#ff444411',
    'accent-red-subtle': '#ff444422',
    'accent-red-border': '#ff444444',

    // Borders
    'border-primary': '#1a3a1a',
    'border-secondary': '#2a4a2a',
    'border-subtle': '#336633',
    'border-focus': '#00ff41',
    'border-permission': '#1a3a1a',
    'border-question': '#1a3a1a',

    // Status
    'status-connected': '#00ff41',
    'status-disconnected': '#ff4444',
    'status-connecting': '#ccff00',
    'status-restarting': '#ccff00',

    // Syntax
    'syntax-keyword': '#00ff41',
    'syntax-string': '#33ff66',
    'syntax-comment': '#336633',
    'syntax-number': '#ccff00',
    'syntax-function': '#00ff41',
    'syntax-operator': '#00cc33',
    'syntax-punctuation': '#336633',
    'syntax-plain': '#00ff41',
    'syntax-type': '#33ff66',
    'syntax-property': '#00cc33',

    // Diff
    'diff-add-bg': '#0a1a0a',
    'diff-remove-bg': '#1a0a0a',
    'diff-add-text': '#00ff41',
    'diff-remove-text': '#ff4444',

    // Scrollbar
    'scrollbar-track': 'transparent',
    'scrollbar-thumb': '#1a3a1a',
    'scrollbar-thumb-hover': '#2a4a2a',
  },
  terminal: {
    background: '#000000',
    foreground: '#00ff41',
    cursor: '#00ff41',
    selectionBackground: '#00ff4144',
  },
}

const midnightTheme: ThemeDefinition = {
  id: 'midnight',
  name: 'Midnight',
  description: 'Deep blue with softer contrast',
  colors: {
    // Backgrounds
    'bg-primary': '#0a0e1a',
    'bg-secondary': '#111827',
    'bg-tertiary': '#0d1220',
    'bg-card': '#1e293b',
    'bg-input': '#0a0e1a',
    'bg-terminal': '#060a14',
    'bg-header': '#0c1120',
    'bg-session-bar': '#0a0e18',
    'bg-code-block': '#060a14',
    'bg-tool-bubble': '#0d1220',
    'bg-permission': '#141830',
    'bg-question': '#0f1a2e',
    'bg-plan-banner': '#181430',
    'bg-modal': '#111827',

    // Text
    'text-primary': '#e2e8f0',
    'text-secondary': '#b0bcd0',
    'text-muted': '#7888a0',
    'text-dim': '#5a6880',
    'text-disabled': '#475060',
    'text-error': '#f0a0a0',
    'text-system': '#90a0b8',
    'text-link': '#60a5fa',
    'text-emphasis': '#c8d4e4',
    'text-heading': '#e8ecf4',
    'text-blockquote': '#8898b0',

    // Accents
    'accent-blue': '#60a5fa',
    'accent-green': '#34d399',
    'accent-purple': '#a78bfa',
    'accent-orange': '#fbbf24',
    'accent-red': '#f87171',

    // Accent variants
    'accent-blue-light': '#60a5fa22',
    'accent-blue-subtle': '#60a5fa33',
    'accent-blue-border': '#60a5fa44',
    'accent-blue-border-strong': '#60a5fa66',
    'accent-green-light': '#34d39922',
    'accent-green-border': '#34d39933',
    'accent-green-border-strong': '#34d39966',
    'accent-purple-light': '#a78bfa22',
    'accent-purple-subtle': '#a78bfa33',
    'accent-purple-border-strong': '#a78bfa66',
    'accent-purple-code': '#c4b5fd',
    'accent-orange-light': '#fbbf2411',
    'accent-orange-subtle': '#fbbf2422',
    'accent-orange-medium': '#fbbf2433',
    'accent-orange-border': '#fbbf2444',
    'accent-orange-border-strong': '#fbbf2466',
    'accent-red-light': '#f8717111',
    'accent-red-subtle': '#f8717122',
    'accent-red-border': '#f8717144',

    // Borders
    'border-primary': '#1e293b',
    'border-secondary': '#334155',
    'border-subtle': '#475569',
    'border-focus': '#60a5fa',
    'border-permission': '#2e2860',
    'border-question': '#1e3a5e',

    // Status
    'status-connected': '#34d399',
    'status-disconnected': '#f87171',
    'status-connecting': '#fbbf24',
    'status-restarting': '#fbbf24',

    // Syntax
    'syntax-keyword': '#c4b5fd',
    'syntax-string': '#34d399',
    'syntax-comment': '#64748b',
    'syntax-number': '#fbbf24',
    'syntax-function': '#60a5fa',
    'syntax-operator': '#d0d8e4',
    'syntax-punctuation': '#7888a0',
    'syntax-plain': '#93c5fd',
    'syntax-type': '#60a5fa',
    'syntax-property': '#34d399',

    // Diff
    'diff-add-bg': '#0f2418',
    'diff-remove-bg': '#240f0f',
    'diff-add-text': '#34d399',
    'diff-remove-text': '#f87171',

    // Scrollbar
    'scrollbar-track': 'transparent',
    'scrollbar-thumb': '#1e293b',
    'scrollbar-thumb-hover': '#334155',
  },
  terminal: {
    background: '#060a14',
    foreground: '#e2e8f0',
    cursor: '#60a5fa',
    selectionBackground: '#60a5fa44',
  },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const BUILT_IN_THEMES: ThemeDefinition[] = [
  defaultTheme,
  hackerTheme,
  midnightTheme,
]

/** Look up a theme by ID. Returns the default theme if not found. */
export function getThemeById(id: string): ThemeDefinition {
  return BUILT_IN_THEMES.find(t => t.id === id) ?? defaultTheme
}
