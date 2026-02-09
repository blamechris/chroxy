/**
 * Shared color constants for the Chroxy app.
 * All color values are defined here to maintain consistency across components.
 */

export const COLORS = {
  // -- Background Colors --
  /** Primary background: main app surface */
  backgroundPrimary: '#0f0f1a',
  /** Secondary background: secondary surfaces, slightly lighter than primary */
  backgroundSecondary: '#1a1a2e',
  /** Tertiary background: tertiary surfaces */
  backgroundTertiary: '#16162a',
  /** Input field background */
  backgroundInput: '#0f0f1a',
  /** Card background: for card-like components */
  backgroundCard: '#2a2a4e',
  /** Code block background */
  backgroundCodeBlock: '#0a0a18',
  /** Terminal area background */
  backgroundTerminal: '#000',

  // -- Text Colors --
  /** Primary text: main readable text */
  textPrimary: '#fff',
  /** Secondary text: less prominent text */
  textSecondary: '#ccc',
  /** Chat message text */
  textChatMessage: '#e0e0e0',
  /** Muted text: for less important information */
  textMuted: '#888',
  /** Dimmed text: for subtle elements */
  textDim: '#666',
  /** Disabled text: for disabled states */
  textDisabled: '#555',
  /** Error text: for error messages */
  textError: '#e8a0a0',
  /** Code block text */
  textCodeBlock: '#a0d0ff',
  /** Terminal text output */
  textTerminal: '#00ff00',

  // -- Accent Colors: Blue (Primary) --
  /** Primary blue accent */
  accentBlue: '#4a9eff',
  /** Light blue: low-opacity background (13%) */
  accentBlueLight: '#4a9eff22',
  /** Subtle blue: very low-opacity background (20%) */
  accentBlueSubtle: '#4a9eff33',
  /** Blue border: standard opacity (27%) */
  accentBlueBorder: '#4a9eff44',
  /** Strong blue border: higher opacity (40%) */
  accentBlueBorderStrong: '#4a9eff66',
  /** Blue transparent: alpha 0x40 (~25% opacity) */
  accentBlueTransparent40: '#4a9eff40',

  // -- Accent Colors: Green (Claude/Success) --
  /** Primary green accent: success state */
  accentGreen: '#22c55e',
  /** Light green: low-opacity background (13%) */
  accentGreenLight: '#22c55e22',
  /** Green border: standard opacity (20%) */
  accentGreenBorder: '#22c55e33',
  /** Strong green border: higher opacity (40%) */
  accentGreenBorderStrong: '#22c55e66',

  // -- Accent Colors: Purple (Tool/Activity) --
  /** Primary purple accent: tool usage */
  accentPurple: '#a78bfa',
  /** Purple code text */
  accentPurpleCode: '#c4a5ff',

  // -- Accent Colors: Orange (Warning/Prompt) --
  /** Primary orange accent: warning/attention */
  accentOrange: '#f59e0b',
  /** Light orange: very low-opacity background (7%) */
  accentOrangeLight: '#f59e0b11',
  /** Subtle orange: low-opacity background (13%) */
  accentOrangeSubtle: '#f59e0b22',
  /** Medium orange: moderate-opacity background (20%) */
  accentOrangeMedium: '#f59e0b33',
  /** Orange border: standard opacity (27%) */
  accentOrangeBorder: '#f59e0b44',
  /** Strong orange border: higher opacity (40%) */
  accentOrangeBorderStrong: '#f59e0b66',

  // -- Accent Colors: Red (Error/Interrupt) --
  /** Primary red accent: error state */
  accentRed: '#ff4a4a',
  /** Light red: very low-opacity background (7%) */
  accentRedLight: '#ff4a4a11',
  /** Subtle red: low-opacity background (13%) */
  accentRedSubtle: '#ff4a4a22',
  /** Red border: standard opacity (27%) */
  accentRedBorder: '#ff4a4a44',

  // -- Border Colors --
  /** Primary border: main component borders */
  borderPrimary: '#2a2a4e',
  /** Secondary border: secondary borders */
  borderSecondary: '#3a3a5e',
  /** Subtle border: for minimal emphasis */
  borderSubtle: '#4a4a6e',
  /** Transparent border: invisible */
  borderTransparent: 'transparent',

  // -- Header Colors --
  /** Header text level 1: largest headers */
  headerText1: '#f0f0f0',
  /** Header text level 2: medium headers */
  headerText2: '#e8e8e8',
  /** Header text level 3: smallest headers */
  headerText3: '#e0e0e0',

  // -- Special UI Colors --
  /** Scroll button background */
  scrollButtonBackground: '#1a1a2ebb',
  /** Cancel button overlay: semi-transparent white */
  cancelButtonOverlay: 'rgba(255,255,255,0.2)',
  /** Reconnect URL text color */
  reconnectUrlText: 'rgba(255,255,255,0.7)',

  // -- Shadow --
  /** Shadow color: used in elevation effects */
  shadowColor: '#000',
} as const;

/**
 * Type helper for color constants.
 * Use this to get TypeScript autocomplete and type-safety when accessing color keys.
 *
 * @example
 * const color: ColorKey = 'textPrimary'
 * const colorValue = COLORS[color]
 */
export type ColorKey = keyof typeof COLORS;
