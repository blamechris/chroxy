/**
 * Shared color constants for the Chroxy app.
 * All color values are defined here to maintain consistency across components.
 */

export const COLORS = {
  // Background colors
  backgroundPrimary: '#0f0f1a',
  backgroundSecondary: '#1a1a2e',
  backgroundTertiary: '#16162a',
  backgroundInput: '#0f0f1a',
  backgroundCard: '#2a2a4e',
  backgroundCodeBlock: '#0a0a18',
  backgroundTerminal: '#000',

  // Text colors
  textPrimary: '#fff',
  textSecondary: '#ccc',
  textChatMessage: '#e0e0e0',
  textMuted: '#888',
  textDim: '#666',
  textDisabled: '#555',
  textError: '#e8a0a0',
  textCodeBlock: '#a0d0ff',
  textTerminal: '#00ff00',

  // Accent colors - Blue (primary)
  accentBlue: '#4a9eff',
  accentBlueLight: '#4a9eff22',
  accentBlueSubtle: '#4a9eff33',
  accentBlueBorder: '#4a9eff44',
  accentBlueBorderStrong: '#4a9eff66',
  accentBlueTransparent40: '#4a9eff40',

  // Accent colors - Green (Claude/success)
  accentGreen: '#22c55e',
  accentGreenLight: '#22c55e22',
  accentGreenBorder: '#22c55e33',
  accentGreenBorderStrong: '#22c55e66',

  // Accent colors - Purple (tool/activity)
  accentPurple: '#a78bfa',
  accentPurpleCode: '#c4a5ff',

  // Accent colors - Orange (warning/prompt)
  accentOrange: '#f59e0b',
  accentOrangeLight: '#f59e0b11',
  accentOrangeSubtle: '#f59e0b22',
  accentOrangeMedium: '#f59e0b33',
  accentOrangeBorder: '#f59e0b44',
  accentOrangeBorderStrong: '#f59e0b66',

  // Accent colors - Red (error/interrupt)
  accentRed: '#ff4a4a',
  accentRedLight: '#ff4a4a11',
  accentRedSubtle: '#ff4a4a22',
  accentRedBorder: '#ff4a4a44',

  // Border colors
  borderPrimary: '#2a2a4e',
  borderSecondary: '#3a3a5e',
  borderSubtle: '#4a4a6e',
  borderTransparent: 'transparent',

  // Header colors
  headerText1: '#f0f0f0',
  headerText2: '#e8e8e8',
  headerText3: '#e0e0e0',

  // Special UI colors
  scrollButtonBackground: '#1a1a2ebb',
  cancelButtonOverlay: 'rgba(255,255,255,0.2)',
  reconnectUrlText: 'rgba(255,255,255,0.7)',

  // Shadow
  shadowColor: '#000',
} as const;
