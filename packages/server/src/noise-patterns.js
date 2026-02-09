/**
 * Noise pattern definitions for terminal output filtering.
 * Used by OutputParser to identify and suppress non-semantic content.
 */

/**
 * @typedef {Object} NoisePattern
 * @property {RegExp} pattern - Regex to test against trimmed line
 * @property {string} description - Human-readable description of what this filters
 * @property {(trimmed: string) => boolean} [condition] - Optional guard function that must return true
 */
/**
 * Ordered baseline noise filters applied to each trimmed line before stateful parsing.
 * State-dependent patterns (below) are evaluated after these have run.
 * @type {NoisePattern[]}
 */
export const NOISE_PATTERNS = [
  {
    pattern: /^\[(?:parser|ws|cli|tunnel|pty|pty-session|SIGINT)\]\s/,
    description: 'Server log lines (prevents recursive amplification)'
  },
  {
    pattern: /^Press Ctrl\+C to stop/i,
    description: 'Server output fragments from tmux scrollback'
  },
  {
    pattern: /^Press\s+(up|enter|escape|ctrl)/i,
    condition: (trimmed) => trimmed.length < 60,
    description: 'CLI chrome: prompts for user actions'
  },
  {
    pattern: /^Or connect manually:/i,
    description: 'Connection instruction text'
  },
  {
    pattern: /^URL:\s+wss?:\/\//i,
    description: 'Connection URL display'
  },
  {
    pattern: /^Token:\s+\w+/i,
    description: 'API token display'
  },
  {
    pattern: /^Scan this QR code/i,
    description: 'QR code instruction text'
  },
  {
    pattern: /^[▄▀█\s]+$/,
    condition: (trimmed) => trimmed.length > 10,
    description: 'QR code block characters'
  },
  {
    pattern: /^[━─╌]{3,}/,
    description: 'Divider lines (all dashes)'
  },
  {
    pattern: /^[─━n\d]+$/,
    condition: (trimmed) => /[─━]/.test(trimmed),
    description: 'Lines mostly dashes with text mixed in'
  },
  {
    pattern: /^\[[\w-]+\]\s*\d+:/,
    description: 'tmux status bar (session name in brackets)'
  },
  {
    pattern: /\[claude-co/,
    description: 'tmux status bar fragment'
  },
  {
    pattern: /\[[\w-]+\]\s+\d+:[\w.-]+[*#!\-]?\s{2,}/,
    description: 'tmux status bar with window name (non-anchored)'
  },
  {
    pattern: /^"[\u2800-\u28FF✻✶✳✽✢·•⏺]/,
    description: 'Quoted pane titles from tmux with spinner chars'
  },
  {
    pattern: /^"\*?\s*Claude\s*Code"/,
    description: 'Quoted Claude Code pane title'
  },
  {
    pattern: /^"Christophers-/,
    description: 'Quoted hostname pane title'
  },
  {
    pattern: /^\*\s*Claude\s*Code/,
    description: 'Active window indicator with name'
  },
  {
    pattern: /^\$[\d.]+(\s*\||$)/,
    description: 'Token/cost line prefix'
  },
  {
    pattern: /tokens?\s*current:/i,
    description: 'Token count status line'
  },
  {
    pattern: /latest:\s*[\d.]+/i,
    condition: (trimmed) => !/^⏺/.test(trimmed),
    description: 'Version "latest" line'
  },
  {
    pattern: /current:\s*[\d.]+/i,
    condition: (trimmed) => !/^⏺/.test(trimmed),
    description: 'Version "current" line'
  },
  {
    pattern: /til compact/i,
    description: 'Context compaction progress'
  },
  {
    pattern: /^\d+\s*tokens?$/i,
    description: 'Bare token count'
  },
  {
    pattern: /\d+tokens/i,
    description: 'Token count fragment'
  },
  {
    pattern: /^\d+\.?\d*k?\s*tokens?\)?$/i,
    description: 'Token counts with optional closing paren'
  },
  {
    pattern: /\d+s\s*·\s*[↓↑]?\s*\d/,
    condition: (trimmed) => /tokens/i.test(trimmed),
    description: 'Timing/token status lines with arrows'
  },
  {
    pattern: /thought\s+for\s+\d+s\)/i,
    description: 'Thinking timing fragments'
  },
  {
    pattern: /^\(No content\)/i,
    description: 'No content marker from Claude Code UI'
  },
  {
    pattern: /^\d+\.\d+\.\d+$/,
    description: 'Bare version numbers'
  },
  {
    pattern: /^ctrl\+g/i,
    description: 'Keyboard shortcut hints'
  },
  {
    pattern: /\/ide\s+for/i,
    description: 'IDE command hints'
  },
  {
    pattern: /^[╭╮╰╯│┌┐└┘├┤┬┴┼\s]+$/,
    description: 'Empty box-drawing fragments'
  },
  {
    pattern: /^│.*│$/,
    description: 'Welcome screen box content'
  },
  {
    pattern: /^[▐▛▜▌▝▘█░▒▓]/,
    description: 'Welcome banner block elements (ASCII art logo)'
  },
  {
    pattern: /Claude\s*Code\s*v\d/i,
    condition: (trimmed) => !/^⏺/.test(trimmed),
    description: 'Claude Code version line from banner'
  },
  {
    pattern: /(?:Opus|Sonnet|Haiku)\s+\d/i,
    condition: (trimmed) => !/^⏺/.test(trimmed),
    description: 'Model name with version from banner'
  },
  {
    pattern: /Claude\s*(?:Max|Pro|Free)/i,
    condition: (trimmed) => !/^⏺/.test(trimmed),
    description: 'Claude plan name from banner'
  },
  {
    pattern: /^Try "/,
    description: 'Placeholder prompt suggestion'
  },
  {
    pattern: /\d+\.\d+%/,
    condition: (trimmed) => !/^⏺/.test(trimmed),
    description: 'Percentage/compact status line'
  },
  {
    pattern: /^start\s*of\s*a\s*new/i,
    condition: (trimmed) => !/^⏺/.test(trimmed),
    description: 'New conversation banner text'
  },
  {
    pattern: /^new\s*conversation/i,
    condition: (trimmed) => !/^⏺/.test(trimmed),
    description: 'New conversation banner text'
  },
  {
    pattern: /^[╰└]─{2,}/,
    description: 'Tool block end boundaries that leak outside TOOL_USE state'
  },
  {
    pattern: /⎿\s*(Running|Completed|Done|Failed)/i,
    description: 'Tool status lines'
  },
  {
    pattern: /[↓↑]\s*\d*$/,
    condition: (trimmed) => trimmed.length < 25,
    description: 'Status bar fragments with scroll arrows'
  },
  {
    pattern: /^\/Users\/\w+$/,
    description: 'Path-only lines from welcome banner'
  },
  {
    pattern: /PTY\s*Scrollback/i,
    description: 'PTY scrollback marker'
  },
  {
    pattern: /^\[Pasted text #\d+/,
    description: 'Paste markers from Claude Code paste handling'
  },
  {
    pattern: /^Baked\s+for\s+\d/i,
    description: 'Completion timing lines'
  },
  {
    pattern: /conversation\s+compacted/i,
    description: 'Context compaction notification'
  },
  {
    pattern: /⎿\s*\w+\s+\d+\s*(lines?|chars?|bytes?)/i,
    description: 'Tool result summaries (lines read/written)'
  },
  {
    pattern: /^tokens\)?$/i,
    description: 'Standalone "tokens" word'
  },
  {
    pattern: /compact\s+\d+\s*tokens/i,
    description: 'CUP-split compact status line'
  },
  {
    pattern: /msgs?:\s*\d+/i,
    description: 'Message count status'
  },
  {
    pattern: /tsc:\s*The\s*TypeScript/i,
    description: 'TypeScript compiler output leakage'
  },
]

/**
 * @typedef {Object} StateDependentPattern
 * @property {RegExp} pattern - Regex to test against trimmed line
 * @property {(trimmed: string, state: string) => boolean} condition - Guard function that must return true
 * @property {string} description - Human-readable description of what this filters
 */
/**
 * Additional, state-aware noise filters that are applied after NOISE_PATTERNS.
 * These patterns depend on the current parser state and should be kept separate
 * from the basic patterns so the base filters run first, then these refinements.
 * @type {StateDependentPattern[]}
 */
export const STATE_DEPENDENT_PATTERNS = [
  {
    pattern: /^[a-zA-Z\d\s.·…]+$/,
    condition: (trimmed, state) => {
      return state !== 'response' &&
        trimmed.length <= 5 &&
        !/^[❯⏺]/.test(trimmed)
    },
    description: 'Very short non-marker lines (terminal redraw artifacts)'
  },
  {
    pattern: /.+/,
    condition: (trimmed, state) => {
      if (trimmed.length >= 20) return false
      const tokens = trimmed.split(/\s+/)
      return tokens.length >= 2 && tokens.every(t => t.length <= 1 || /^\d{1,3}$/.test(t))
    },
    description: 'CUP-split status fragments (single-char tokens)'
  },
  {
    pattern: /^[\d\s.()+-]+$/,
    condition: (trimmed, state) => {
      return state !== 'response' && trimmed.length < 20
    },
    description: 'Numeric-only fragments with punctuation'
  },
  {
    pattern: /⎿/,
    condition: (trimmed, state) => {
      return state !== 'tool_use' && state !== 'response' &&
        trimmed.length < 60 &&
        !/^(Read|Write|Edit|Bash|Search|Glob|Grep|TodoRead|TodoWrite|Task|Skill|WebFetch|WebSearch|NotebookEdit)\(/.test(trimmed)
    },
    description: 'General ⎿ lines outside tool/response state'
  },
  {
    pattern: /^\d+\s+files?\s+changed\b/i,
    condition: (trimmed, state) => trimmed.length < 50 && !/^⏺/.test(trimmed),
    description: 'Git diff summary (files changed)'
  },
  {
    pattern: /^\d+\s+files?\s+\+\d+\s+-\d+\b/i,
    condition: (trimmed, state) => trimmed.length < 50 && !/^⏺/.test(trimmed),
    description: 'Git diff summary (with additions/deletions)'
  },
  {
    pattern: /^(merge|commit|push|pull|rebase|checkout)\s/i,
    condition: (trimmed, state) => {
      return state !== 'response' && trimmed.length < 30
    },
    description: 'Autosuggest ghost text (git commands)'
  },
]
