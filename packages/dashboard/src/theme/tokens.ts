/**
 * DO NOT EDIT — generated from @chroxy/design-tokens by
 * scripts/generate-theme-tokens.mjs.
 *
 * Edit tokens in packages/design-tokens/src/tokens-data.js, then run
 * `npm run generate-tokens` in packages/dashboard.
 */

export const colors = {
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
  accent: {
    blue: '#4a9eff',
    green: '#22c55e',
    purple: '#a78bfa',
    orange: '#f59e0b',
    red: '#ff4a4a',
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
    orange500: '#f97316',
    yellow500: '#eab308',
    red500: '#ef4444',
  },
  border: {
    primary: '#2a2a4e',
    secondary: '#3a3a5e',
    subtle: '#4a4a6e',
    focus: '#4a9eff',
    permission: '#4a3a7a',
    question: '#2a5a7a',
  },
  banner: {
    borderSubtle: '#252540',
  },
  warning: {
    fg: '#fbbf24',
    bgSubtle: '#fbbf2422',
  },
  status: {
    connected: '#22c55e',
    disconnected: '#ef4444',
    connecting: '#eab308',
    restarting: '#f59e0b',
  },
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
  diff: {
    addBg: '#1a2e1a',
    removeBg: '#2e1a1a',
    addText: '#4eca6a',
    removeText: '#ff5b5b',
  },
  scrollbar: {
    track: 'transparent',
    thumb: '#333355',
    thumbHover: '#444466',
  },
} as const

export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
} as const

export const typography = {
  xs: 10,
  sm: 12,
  base: 13,
  md: 14,
  lg: 16,
  chat: 15,
} as const

export const fonts = {
  mono: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, Consolas, monospace",
  ui: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
} as const

export const leading = {
  tight: 1.35,
  normal: 1.5,
  chat: 1.6,
  code: 1.5,
} as const

export const radii = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const

export const motion = {
  durations: {
    fast: 150,
    base: 200,
    slow: 280,
  },
  easings: {
    out: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  loops: {
    railHeartbeat: 1200,
    railBreathe: 2400,
    caretBlink: 1100,
    waitingPulse: 1600,
  },
} as const
