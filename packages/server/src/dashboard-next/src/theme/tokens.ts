/**
 * Design tokens for the Chroxy desktop dashboard.
 *
 * Source of truth: mobile app colors.ts + legacy dashboard.css
 * CSS custom properties in theme.css mirror these values.
 */

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export const colors = {
  // Backgrounds
  bg: {
    primary: '#0f0f1a',
    secondary: '#1a1a2e',
    tertiary: '#16162a',
    card: '#2a2a4e',
    input: '#0f0f1a',
    terminal: '#000000',
    header: '#151528',
    sessionBar: '#12121f',
    codeBlock: '#0a0a18',
    toolBubble: '#161625',
    permission: '#1e1a30',
    question: '#1a2530',
    planBanner: '#2a1a40',
    modal: '#1a1a2e',
  },

  // Text
  text: {
    primary: '#ffffff',
    secondary: '#cccccc',
    muted: '#888888',
    dim: '#666666',
    disabled: '#555555',
    error: '#e8a0a0',
    system: '#b0b0b0',
    link: '#4a9eff',
    emphasis: '#b0b8d0',
    heading: '#f0f0f0',
    blockquote: '#999999',
  },

  // Accents — solid
  accent: {
    blue: '#4a9eff',
    green: '#22c55e',
    purple: '#a78bfa',
    orange: '#f59e0b',
    red: '#ff4a4a',

    // Opacity variants (hex alpha)
    blueLight: '#4a9eff22',
    blueSubtle: '#4a9eff33',
    blueBorder: '#4a9eff44',
    blueBorderStrong: '#4a9eff66',

    greenLight: '#22c55e22',
    greenBorder: '#22c55e33',
    greenBorderStrong: '#22c55e66',

    purpleLight: '#a78bfa22',
    purpleSubtle: '#a78bfa33',
    purpleBorderStrong: '#a78bfa66',
    purpleCode: '#c4a5ff',

    orangeLight: '#f59e0b11',
    orangeSubtle: '#f59e0b22',
    orangeMedium: '#f59e0b33',
    orangeBorder: '#f59e0b44',
    orangeBorderStrong: '#f59e0b66',

    redLight: '#ff4a4a11',
    redSubtle: '#ff4a4a22',
    redBorder: '#ff4a4a44',
  },

  // Borders
  border: {
    primary: '#2a2a4e',
    secondary: '#3a3a5e',
    subtle: '#4a4a6e',
    focus: '#4a9eff',
    permission: '#4a3a7a',
    question: '#2a5a7a',
  },

  // Status indicator dots
  status: {
    connected: '#22c55e',
    disconnected: '#ef4444',
    connecting: '#eab308',
    restarting: '#f59e0b',
  },

  // Syntax highlighting
  syntax: {
    keyword: '#c4a5ff',
    string: '#4eca6a',
    comment: '#7a7a7a',
    number: '#ff9a52',
    function: '#4a9eff',
    operator: '#e0e0e0',
    punctuation: '#888888',
    plain: '#a0d0ff',
    type: '#4a9eff',
    property: '#4eca6a',
  },

  // Diff
  diff: {
    addBg: '#1a2e1a',
    removeBg: '#2e1a1a',
    addText: '#4eca6a',
    removeText: '#ff5b5b',
  },

  // Scrollbar
  scrollbar: {
    track: 'transparent',
    thumb: '#333355',
    thumbHover: '#444466',
  },
} as const

// ---------------------------------------------------------------------------
// Spacing — 4px base grid
// ---------------------------------------------------------------------------

export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
} as const

// ---------------------------------------------------------------------------
// Typography — font sizes in px
// ---------------------------------------------------------------------------

export const typography = {
  xs: 10,
  sm: 12,
  base: 13,
  md: 14,
  lg: 16,
} as const

// ---------------------------------------------------------------------------
// Font stacks
// ---------------------------------------------------------------------------

export const fonts = {
  mono: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, Consolas, monospace",
  ui: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
} as const
