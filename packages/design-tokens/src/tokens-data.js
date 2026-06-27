/**
 * Canonical Chroxy design tokens (chat redesign epic #6389, Phase 0 #6390).
 *
 * SINGLE SOURCE OF TRUTH for the dashboard theme. `theme.css` and
 * `tokens.ts` in packages/dashboard are GENERATED from this map by
 * `generateThemeCss()` / `generateTokensTs()` (see ./index.js) — the
 * pipeline is inverted from the old "theme.css -> tokens.ts" direction.
 * Edit tokens HERE, then run `npm run generate-tokens` in packages/dashboard.
 *
 * The existing color/spacing/typography/font values are the navy "Default"
 * theme verbatim (the redesign keeps navy); the new groups below add the
 * structural tokens (chat reading size, line heights, radii, motion).
 *
 * Each group is { title, vars: [[cssVarName, value], ...] }.
 */

export const TOKEN_GROUPS = [
  {
    title: "Backgrounds",
    vars: [
      ["bg-primary", "#0f0f1a"],
      ["bg-secondary", "#1a1a2e"],
      ["bg-tertiary", "#16162a"],
      ["bg-card", "#2a2a4e"],
      ["bg-input", "#0f0f1a"],
      ["bg-terminal", "#000000"],
      ["bg-header", "#151528"],
      ["bg-session-bar", "#12121f"],
      ["bg-code-block", "#0a0a18"],
      ["bg-tool-bubble", "#161625"],
      ["bg-permission", "#1e1a30"],
      ["bg-question", "#1a2530"],
      ["bg-plan-banner", "#2a1a40"],
      ["bg-modal", "#1a1a2e"],
    ],
  },
  {
    title: "Text",
    vars: [
      ["text-primary", "#ffffff"],
      ["text-secondary", "#cccccc"],
      ["text-muted", "#888888"],
      ["text-dim", "#666666"],
      ["text-disabled", "#555555"],
      ["text-error", "#e8a0a0"],
      ["text-system", "#b0b0b0"],
      ["text-link", "#4a9eff"],
      ["text-emphasis", "#b0b8d0"],
      ["text-heading", "#f0f0f0"],
      ["text-blockquote", "#999999"],
    ],
  },
  {
    title: "Accents",
    vars: [
      ["accent-blue", "#4a9eff"],
      ["accent-green", "#22c55e"],
      ["accent-purple", "#a78bfa"],
      ["accent-orange", "#f59e0b"],
      ["accent-red", "#ff4a4a"],
      ["accent-cyan", "#22d3ee"], // #6426: distinct hue for the read/search/web retrieval family (vs thinking-blue)
    ],
  },
  {
    title: "Accent opacity variants",
    vars: [
      ["accent-blue-light", "#4a9eff22"],
      ["accent-blue-subtle", "#4a9eff33"],
      ["accent-blue-border", "#4a9eff44"],
      ["accent-blue-border-strong", "#4a9eff66"],
      ["accent-green-light", "#22c55e22"],
      ["accent-green-border", "#22c55e33"],
      ["accent-green-border-strong", "#22c55e66"],
      ["accent-purple-light", "#a78bfa22"],
      ["accent-purple-subtle", "#a78bfa33"],
      ["accent-purple-border-strong", "#a78bfa66"],
      ["accent-purple-code", "#c4a5ff"],
      ["accent-orange-light", "#f59e0b11"],
      ["accent-orange-subtle", "#f59e0b22"],
      ["accent-orange-medium", "#f59e0b33"],
      ["accent-orange-border", "#f59e0b44"],
      ["accent-orange-border-strong", "#f59e0b66"],
      ["accent-red-light", "#ff4a4a11"],
      ["accent-red-subtle", "#ff4a4a22"],
      ["accent-red-border", "#ff4a4a44"],
    ],
  },
  {
    title: "Tailwind-scale (distinct base hexes, not opacity variants of the brand hex)",
    vars: [
      ["accent-orange-500", "#f97316"],
      ["accent-yellow-500", "#eab308"],
      ["accent-red-500", "#ef4444"],
    ],
  },
  {
    title: "Borders",
    vars: [
      ["border-primary", "#2a2a4e"],
      ["border-secondary", "#3a3a5e"],
      ["border-subtle", "#4a4a6e"],
      ["border-focus", "#4a9eff"],
      ["border-permission", "#4a3a7a"],
      ["border-question", "#2a5a7a"],
    ],
  },
  {
    title: "Banner borders",
    vars: [
      ["banner-border-subtle", "#252540"],
    ],
  },
  {
    title: "Warning (amber-yellow, distinct from --accent-orange)",
    vars: [
      ["warning-fg", "#fbbf24"],
      ["warning-bg-subtle", "#fbbf2422"],
    ],
  },
  {
    title: "Status indicators",
    vars: [
      ["status-connected", "#22c55e"],
      ["status-disconnected", "#ef4444"],
      ["status-connecting", "#eab308"],
      ["status-restarting", "#f59e0b"],
    ],
  },
  {
    title: "Syntax highlighting",
    vars: [
      ["syntax-keyword", "#c4a5ff"],
      ["syntax-string", "#4eca6a"],
      ["syntax-comment", "#7a7a7a"],
      ["syntax-number", "#ff9a52"],
      ["syntax-function", "#4a9eff"],
      ["syntax-operator", "#e0e0e0"],
      ["syntax-punctuation", "#888888"],
      ["syntax-plain", "#a0d0ff"],
      ["syntax-type", "#4a9eff"],
      ["syntax-property", "#4eca6a"],
    ],
  },
  {
    title: "Diff",
    vars: [
      ["diff-add-bg", "#1a2e1a"],
      ["diff-remove-bg", "#2e1a1a"],
      ["diff-add-text", "#4eca6a"],
      ["diff-remove-text", "#ff5b5b"],
    ],
  },
  {
    title: "Scrollbar",
    vars: [
      ["scrollbar-track", "transparent"],
      ["scrollbar-thumb", "#333355"],
      ["scrollbar-thumb-hover", "#444466"],
    ],
  },
  {
    title: "Fonts",
    vars: [
      ["font-mono", "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, Consolas, monospace"],
      ["font-ui", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"],
    ],
  },
  {
    title: "Typography scale",
    vars: [
      ["text-xs", "10px"],
      ["text-sm", "12px"],
      ["text-base", "13px"],
      ["text-md", "14px"],
      ["text-lg", "16px"],
    ],
  },
  {
    title: "Spacing (4px base grid)",
    vars: [
      ["space-1", "4px"],
      ["space-2", "8px"],
      ["space-3", "12px"],
      ["space-4", "16px"],
      ["space-6", "24px"],
      ["space-8", "32px"],
    ],
  },
  {
    title: "Typography — chat reading size (chat redesign #6390)",
    vars: [
      ["text-chat", "15px"],
    ],
  },
  {
    title: "Line heights (chat redesign #6390)",
    vars: [
      ["leading-tight", "1.35"],
      ["leading-normal", "1.5"],
      ["leading-chat", "1.6"],
      ["leading-code", "1.5"],
    ],
  },
  {
    title: "Radii (chat redesign #6390)",
    vars: [
      ["radius-xs", "4px"],
      ["radius-sm", "6px"],
      ["radius-md", "10px"],
      ["radius-lg", "14px"],
      ["radius-pill", "999px"],
    ],
  },
  {
    title: "Motion — durations (chat redesign #6390)",
    vars: [
      ["dur-fast", "150ms"],
      ["dur-base", "200ms"],
      ["dur-slow", "280ms"],
    ],
  },
  {
    title: "Motion — easings (chat redesign #6390)",
    vars: [
      ["ease-out", "cubic-bezier(0.2, 0.8, 0.2, 1)"],
      ["ease-standard", "cubic-bezier(0.4, 0, 0.2, 1)"],
    ],
  },
  {
    title: "Motion — loop timings (chat redesign #6390)",
    vars: [
      ["rail-heartbeat", "1200ms"],
      ["rail-breathe", "2400ms"],
      ["caret-blink", "1100ms"],
      ["waiting-pulse", "1600ms"],
    ],
  },
]

/** Flat, ordered list of every [cssVarName, value] across all groups. */
export const ALL_TOKENS = TOKEN_GROUPS.flatMap((g) => g.vars)
