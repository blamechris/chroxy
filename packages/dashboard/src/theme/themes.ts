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

const lightTheme: ThemeDefinition = {
  id: 'light',
  name: 'Light',
  description: 'Clean light theme for daytime',
  colors: {
    // Backgrounds
    'bg-primary': '#ffffff',
    'bg-secondary': '#f5f5f5',
    'bg-tertiary': '#fafafa',
    'bg-card': '#ffffff',
    'bg-input': '#ffffff',
    'bg-terminal': '#fafafa',
    'bg-header': '#f8f8f8',
    'bg-session-bar': '#f0f0f0',
    'bg-code-block': '#f5f5f5',
    'bg-tool-bubble': '#f0f4f8',
    'bg-permission': '#fef9ee',
    'bg-question': '#eef4fe',
    'bg-plan-banner': '#f3eefe',
    'bg-modal': '#ffffff',

    // Text
    'text-primary': '#1a1a2e',
    'text-secondary': '#4a4a5a',
    'text-muted': '#6b7280',
    'text-dim': '#9ca3af',
    'text-disabled': '#c0c4cc',
    'text-error': '#dc2626',
    'text-system': '#6b7280',
    'text-link': '#2563eb',
    'text-emphasis': '#111827',
    'text-heading': '#0f172a',
    'text-blockquote': '#64748b',

    // Accents
    'accent-blue': '#2563eb',
    'accent-green': '#16a34a',
    'accent-purple': '#7c3aed',
    'accent-orange': '#d97706',
    'accent-red': '#dc2626',

    // Accent variants
    'accent-blue-light': '#2563eb18',
    'accent-blue-subtle': '#2563eb22',
    'accent-blue-border': '#2563eb44',
    'accent-blue-border-strong': '#2563eb66',
    'accent-green-light': '#16a34a18',
    'accent-green-border': '#16a34a33',
    'accent-green-border-strong': '#16a34a66',
    'accent-purple-light': '#7c3aed18',
    'accent-purple-subtle': '#7c3aed22',
    'accent-purple-border-strong': '#7c3aed55',
    'accent-purple-code': '#6d28d9',
    'accent-orange-light': '#d9770611',
    'accent-orange-subtle': '#d9770618',
    'accent-orange-medium': '#d9770622',
    'accent-orange-border': '#d9770644',
    'accent-orange-border-strong': '#d9770666',
    'accent-red-light': '#dc262611',
    'accent-red-subtle': '#dc262618',
    'accent-red-border': '#dc262644',

    // Borders
    'border-primary': '#e2e8f0',
    'border-secondary': '#cbd5e1',
    'border-subtle': '#94a3b8',
    'border-focus': '#2563eb',
    'border-permission': '#f59e0b44',
    'border-question': '#2563eb44',

    // Status
    'status-connected': '#16a34a',
    'status-disconnected': '#dc2626',
    'status-connecting': '#d97706',
    'status-restarting': '#d97706',

    // Syntax
    'syntax-keyword': '#7c3aed',
    'syntax-string': '#16a34a',
    'syntax-comment': '#9ca3af',
    'syntax-number': '#d97706',
    'syntax-function': '#2563eb',
    'syntax-operator': '#374151',
    'syntax-punctuation': '#6b7280',
    'syntax-plain': '#1e293b',
    'syntax-type': '#0891b2',
    'syntax-property': '#b45309',

    // Diff
    'diff-add-bg': '#dcfce7',
    'diff-remove-bg': '#fee2e2',
    'diff-add-text': '#166534',
    'diff-remove-text': '#991b1b',

    // Scrollbar
    'scrollbar-track': '#f1f5f9',
    'scrollbar-thumb': '#cbd5e1',
    'scrollbar-thumb-hover': '#94a3b8',
  },
  terminal: {
    background: '#fafafa',
    foreground: '#1a1a2e',
    cursor: '#2563eb',
    selectionBackground: '#2563eb33',
  },
}

const solarizedTheme: ThemeDefinition = {
  id: 'solarized',
  name: 'Solarized',
  description: 'Ethan Schoonover\'s iconic palette',
  colors: {
    // Backgrounds — Solarized Dark: base03 #002b36, base02 #073642
    'bg-primary': '#002b36',
    'bg-secondary': '#073642',
    'bg-tertiary': '#002b36',
    'bg-card': '#073642',
    'bg-input': '#002b36',
    'bg-terminal': '#001e26',
    'bg-header': '#073642',
    'bg-session-bar': '#002b36',
    'bg-code-block': '#001e26',
    'bg-tool-bubble': '#073642',
    'bg-permission': '#073642',
    'bg-question': '#073642',
    'bg-plan-banner': '#073642',
    'bg-modal': '#073642',

    // Text — base0 #839496, base1 #93a1a1, base00 #657b83, base01 #586e75
    'text-primary': '#839496',
    'text-secondary': '#93a1a1',
    'text-muted': '#657b83',
    'text-dim': '#586e75',
    'text-disabled': '#475b62',
    'text-error': '#dc322f',
    'text-system': '#657b83',
    'text-link': '#268bd2',
    'text-emphasis': '#eee8d5',
    'text-heading': '#fdf6e3',
    'text-blockquote': '#657b83',

    // Accents — Solarized accent colors
    'accent-blue': '#268bd2',
    'accent-green': '#859900',
    'accent-purple': '#6c71c4',
    'accent-orange': '#cb4b16',
    'accent-red': '#dc322f',

    // Accent variants
    'accent-blue-light': '#268bd222',
    'accent-blue-subtle': '#268bd233',
    'accent-blue-border': '#268bd244',
    'accent-blue-border-strong': '#268bd266',
    'accent-green-light': '#85990022',
    'accent-green-border': '#85990033',
    'accent-green-border-strong': '#85990066',
    'accent-purple-light': '#6c71c422',
    'accent-purple-subtle': '#6c71c433',
    'accent-purple-border-strong': '#6c71c466',
    'accent-purple-code': '#d33682',
    'accent-orange-light': '#cb4b1611',
    'accent-orange-subtle': '#cb4b1622',
    'accent-orange-medium': '#cb4b1633',
    'accent-orange-border': '#cb4b1644',
    'accent-orange-border-strong': '#cb4b1666',
    'accent-red-light': '#dc322f11',
    'accent-red-subtle': '#dc322f22',
    'accent-red-border': '#dc322f44',

    // Borders — base02/base01 tones
    'border-primary': '#073642',
    'border-secondary': '#586e75',
    'border-subtle': '#657b83',
    'border-focus': '#268bd2',
    'border-permission': '#b5890044',
    'border-question': '#268bd244',

    // Status
    'status-connected': '#859900',
    'status-disconnected': '#dc322f',
    'status-connecting': '#b58900',
    'status-restarting': '#b58900',

    // Syntax — Solarized canonical assignments
    'syntax-keyword': '#859900',
    'syntax-string': '#2aa198',
    'syntax-comment': '#586e75',
    'syntax-number': '#d33682',
    'syntax-function': '#268bd2',
    'syntax-operator': '#839496',
    'syntax-punctuation': '#657b83',
    'syntax-plain': '#839496',
    'syntax-type': '#b58900',
    'syntax-property': '#cb4b16',

    // Diff
    'diff-add-bg': '#073642',
    'diff-remove-bg': '#3c1111',
    'diff-add-text': '#859900',
    'diff-remove-text': '#dc322f',

    // Scrollbar
    'scrollbar-track': 'transparent',
    'scrollbar-thumb': '#073642',
    'scrollbar-thumb-hover': '#586e75',
  },
  terminal: {
    background: '#001e26',
    foreground: '#839496',
    cursor: '#268bd2',
    selectionBackground: '#073642',
  },
}

const monokaiTheme: ThemeDefinition = {
  id: 'monokai',
  name: 'Monokai',
  description: 'Classic warm developer palette',
  colors: {
    // Backgrounds — Monokai: #272822 main, #3e3d32 gutter
    'bg-primary': '#272822',
    'bg-secondary': '#2d2e27',
    'bg-tertiary': '#222318',
    'bg-card': '#3e3d32',
    'bg-input': '#272822',
    'bg-terminal': '#1e1f1a',
    'bg-header': '#2d2e27',
    'bg-session-bar': '#222318',
    'bg-code-block': '#1e1f1a',
    'bg-tool-bubble': '#2d2e27',
    'bg-permission': '#3e3a20',
    'bg-question': '#2a2e3a',
    'bg-plan-banner': '#352a3e',
    'bg-modal': '#2d2e27',

    // Text — Monokai: #f8f8f2 foreground, #75715e comment
    'text-primary': '#f8f8f2',
    'text-secondary': '#cfcfc2',
    'text-muted': '#a6a699',
    'text-dim': '#75715e',
    'text-disabled': '#555548',
    'text-error': '#f92672',
    'text-system': '#a6a699',
    'text-link': '#66d9ef',
    'text-emphasis': '#ffffff',
    'text-heading': '#f8f8f2',
    'text-blockquote': '#75715e',

    // Accents — Monokai signature colors
    'accent-blue': '#66d9ef',
    'accent-green': '#a6e22e',
    'accent-purple': '#ae81ff',
    'accent-orange': '#fd971f',
    'accent-red': '#f92672',

    // Accent variants
    'accent-blue-light': '#66d9ef22',
    'accent-blue-subtle': '#66d9ef33',
    'accent-blue-border': '#66d9ef44',
    'accent-blue-border-strong': '#66d9ef66',
    'accent-green-light': '#a6e22e22',
    'accent-green-border': '#a6e22e33',
    'accent-green-border-strong': '#a6e22e66',
    'accent-purple-light': '#ae81ff22',
    'accent-purple-subtle': '#ae81ff33',
    'accent-purple-border-strong': '#ae81ff66',
    'accent-purple-code': '#ae81ff',
    'accent-orange-light': '#fd971f11',
    'accent-orange-subtle': '#fd971f22',
    'accent-orange-medium': '#fd971f33',
    'accent-orange-border': '#fd971f44',
    'accent-orange-border-strong': '#fd971f66',
    'accent-red-light': '#f9267211',
    'accent-red-subtle': '#f9267222',
    'accent-red-border': '#f9267244',

    // Borders
    'border-primary': '#3e3d32',
    'border-secondary': '#555548',
    'border-subtle': '#75715e',
    'border-focus': '#66d9ef',
    'border-permission': '#fd971f44',
    'border-question': '#66d9ef44',

    // Status
    'status-connected': '#a6e22e',
    'status-disconnected': '#f92672',
    'status-connecting': '#fd971f',
    'status-restarting': '#fd971f',

    // Syntax — Monokai canonical colors
    'syntax-keyword': '#f92672',
    'syntax-string': '#a6e22e',
    'syntax-comment': '#75715e',
    'syntax-number': '#ae81ff',
    'syntax-function': '#66d9ef',
    'syntax-operator': '#f92672',
    'syntax-punctuation': '#a6a699',
    'syntax-plain': '#f8f8f2',
    'syntax-type': '#66d9ef',
    'syntax-property': '#fd971f',

    // Diff
    'diff-add-bg': '#2a3a1a',
    'diff-remove-bg': '#3a1a2a',
    'diff-add-text': '#a6e22e',
    'diff-remove-text': '#f92672',

    // Scrollbar
    'scrollbar-track': 'transparent',
    'scrollbar-thumb': '#3e3d32',
    'scrollbar-thumb-hover': '#555548',
  },
  terminal: {
    background: '#1e1f1a',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selectionBackground: '#49483e',
  },
}

const nordTheme: ThemeDefinition = {
  id: 'nord',
  name: 'Nord',
  description: 'Arctic, north-bluish color palette',
  colors: {
    // Backgrounds — Polar Night: nord0 #2e3440, nord1 #3b4252, nord2 #434c5e, nord3 #4c566a
    'bg-primary': '#2e3440',
    'bg-secondary': '#3b4252',
    'bg-tertiary': '#2e3440',
    'bg-card': '#3b4252',
    'bg-input': '#2e3440',
    'bg-terminal': '#242933',
    'bg-header': '#3b4252',
    'bg-session-bar': '#2e3440',
    'bg-code-block': '#242933',
    'bg-tool-bubble': '#3b4252',
    'bg-permission': '#3b3e4a',
    'bg-question': '#2e3a4a',
    'bg-plan-banner': '#3a354a',
    'bg-modal': '#3b4252',

    // Text — Snow Storm: nord4 #d8dee9, nord5 #e5e9f0, nord6 #eceff4
    'text-primary': '#d8dee9',
    'text-secondary': '#e5e9f0',
    'text-muted': '#a0aab8',
    'text-dim': '#7b8694',
    'text-disabled': '#616e7c',
    'text-error': '#bf616a',
    'text-system': '#a0aab8',
    'text-link': '#88c0d0',
    'text-emphasis': '#eceff4',
    'text-heading': '#eceff4',
    'text-blockquote': '#7b8694',

    // Accents — Frost: nord7 #8fbcbb, nord8 #88c0d0, nord9 #81a1c1, nord10 #5e81ac
    'accent-blue': '#88c0d0',
    'accent-green': '#a3be8c',
    'accent-purple': '#b48ead',
    'accent-orange': '#d08770',
    'accent-red': '#bf616a',

    // Accent variants
    'accent-blue-light': '#88c0d022',
    'accent-blue-subtle': '#88c0d033',
    'accent-blue-border': '#88c0d044',
    'accent-blue-border-strong': '#88c0d066',
    'accent-green-light': '#a3be8c22',
    'accent-green-border': '#a3be8c33',
    'accent-green-border-strong': '#a3be8c66',
    'accent-purple-light': '#b48ead22',
    'accent-purple-subtle': '#b48ead33',
    'accent-purple-border-strong': '#b48ead66',
    'accent-purple-code': '#b48ead',
    'accent-orange-light': '#d0877011',
    'accent-orange-subtle': '#d0877022',
    'accent-orange-medium': '#d0877033',
    'accent-orange-border': '#d0877044',
    'accent-orange-border-strong': '#d0877066',
    'accent-red-light': '#bf616a11',
    'accent-red-subtle': '#bf616a22',
    'accent-red-border': '#bf616a44',

    // Borders — Polar Night edges
    'border-primary': '#3b4252',
    'border-secondary': '#434c5e',
    'border-subtle': '#4c566a',
    'border-focus': '#88c0d0',
    'border-permission': '#d0877044',
    'border-question': '#88c0d044',

    // Status — Aurora: nord14 #a3be8c, nord11 #bf616a, nord13 #ebcb8b
    'status-connected': '#a3be8c',
    'status-disconnected': '#bf616a',
    'status-connecting': '#ebcb8b',
    'status-restarting': '#ebcb8b',

    // Syntax — Nord recommended
    'syntax-keyword': '#81a1c1',
    'syntax-string': '#a3be8c',
    'syntax-comment': '#616e7c',
    'syntax-number': '#b48ead',
    'syntax-function': '#88c0d0',
    'syntax-operator': '#81a1c1',
    'syntax-punctuation': '#7b8694',
    'syntax-plain': '#d8dee9',
    'syntax-type': '#8fbcbb',
    'syntax-property': '#d08770',

    // Diff
    'diff-add-bg': '#2e3e30',
    'diff-remove-bg': '#3e2e30',
    'diff-add-text': '#a3be8c',
    'diff-remove-text': '#bf616a',

    // Scrollbar
    'scrollbar-track': 'transparent',
    'scrollbar-thumb': '#3b4252',
    'scrollbar-thumb-hover': '#434c5e',
  },
  terminal: {
    background: '#242933',
    foreground: '#d8dee9',
    cursor: '#88c0d0',
    selectionBackground: '#434c5e',
  },
}

const highContrastTheme: ThemeDefinition = {
  id: 'high-contrast',
  name: 'High Contrast',
  description: 'Maximum readability with strong contrast',
  colors: {
    // Backgrounds — pure blacks
    'bg-primary': '#000000',
    'bg-secondary': '#0a0a0a',
    'bg-tertiary': '#000000',
    'bg-card': '#121212',
    'bg-input': '#000000',
    'bg-terminal': '#000000',
    'bg-header': '#0a0a0a',
    'bg-session-bar': '#050505',
    'bg-code-block': '#0a0a0a',
    'bg-tool-bubble': '#0a0a0a',
    'bg-permission': '#1a1a00',
    'bg-question': '#00001a',
    'bg-plan-banner': '#1a001a',
    'bg-modal': '#0a0a0a',

    // Text — bright whites, vivid error
    'text-primary': '#ffffff',
    'text-secondary': '#f0f0f0',
    'text-muted': '#cccccc',
    'text-dim': '#aaaaaa',
    'text-disabled': '#777777',
    'text-error': '#ff3333',
    'text-system': '#cccccc',
    'text-link': '#5599ff',
    'text-emphasis': '#ffffff',
    'text-heading': '#ffffff',
    'text-blockquote': '#bbbbbb',

    // Accents — vivid, high-saturation primaries
    'accent-blue': '#4499ff',
    'accent-green': '#33ff33',
    'accent-purple': '#cc66ff',
    'accent-orange': '#ffaa00',
    'accent-red': '#ff3333',

    // Accent variants
    'accent-blue-light': '#4499ff33',
    'accent-blue-subtle': '#4499ff44',
    'accent-blue-border': '#4499ff66',
    'accent-blue-border-strong': '#4499ff99',
    'accent-green-light': '#33ff3333',
    'accent-green-border': '#33ff3344',
    'accent-green-border-strong': '#33ff3399',
    'accent-purple-light': '#cc66ff33',
    'accent-purple-subtle': '#cc66ff44',
    'accent-purple-border-strong': '#cc66ff99',
    'accent-purple-code': '#dd88ff',
    'accent-orange-light': '#ffaa0022',
    'accent-orange-subtle': '#ffaa0033',
    'accent-orange-medium': '#ffaa0044',
    'accent-orange-border': '#ffaa0066',
    'accent-orange-border-strong': '#ffaa0099',
    'accent-red-light': '#ff333322',
    'accent-red-subtle': '#ff333333',
    'accent-red-border': '#ff333366',

    // Borders — bright, visible
    'border-primary': '#444444',
    'border-secondary': '#666666',
    'border-subtle': '#888888',
    'border-focus': '#4499ff',
    'border-permission': '#ffaa0066',
    'border-question': '#4499ff66',

    // Status
    'status-connected': '#33ff33',
    'status-disconnected': '#ff3333',
    'status-connecting': '#ffaa00',
    'status-restarting': '#ffaa00',

    // Syntax — vivid, distinct colors for each token type
    'syntax-keyword': '#ff6699',
    'syntax-string': '#33ff33',
    'syntax-comment': '#888888',
    'syntax-number': '#ffaa00',
    'syntax-function': '#4499ff',
    'syntax-operator': '#ffffff',
    'syntax-punctuation': '#cccccc',
    'syntax-plain': '#ffffff',
    'syntax-type': '#00ddff',
    'syntax-property': '#ffcc00',

    // Diff
    'diff-add-bg': '#003300',
    'diff-remove-bg': '#330000',
    'diff-add-text': '#33ff33',
    'diff-remove-text': '#ff3333',

    // Scrollbar
    'scrollbar-track': '#111111',
    'scrollbar-thumb': '#555555',
    'scrollbar-thumb-hover': '#777777',
  },
  terminal: {
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#ffffff',
    selectionBackground: '#4499ff55',
  },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const BUILT_IN_THEMES: ThemeDefinition[] = [
  defaultTheme,
  hackerTheme,
  midnightTheme,
  lightTheme,
  solarizedTheme,
  monokaiTheme,
  nordTheme,
  highContrastTheme,
]

/** Look up a theme by ID. Returns the default theme if not found. */
export function getThemeById(id: string): ThemeDefinition {
  return BUILT_IN_THEMES.find(t => t.id === id) ?? defaultTheme
}
