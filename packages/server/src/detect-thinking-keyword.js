/**
 * Detect Claude Code "thinking keywords" in a user prompt.
 *
 * The native Claude Code CLI's interactive REPL scans for magic keywords
 * (`think`, `think hard`, `think harder`, `megathink`, `ultrathink`) and
 * escalates the model's `maxThinkingTokens` budget for that turn. The
 * `query()` path Chroxy's SdkSession uses does NOT do this — the scanner
 * lives in the REPL, not the SDK. Issue #4306 makes the same affordance
 * work through Chroxy: detect the keyword server-side, bump
 * `maxThinkingTokens` for the turn via the existing escalation path.
 *
 * Matching rules:
 *   - case-insensitive
 *   - whole-word match (word boundaries) so `unthinkingly` does NOT match
 *   - longest match wins so `think harder` is preferred over `think`
 *
 * Budget mapping mirrors the native CLI rough buckets:
 *   - `think`         →  4_000   (low)
 *   - `think hard`    → 10_000   (medium)
 *   - `think harder`  → 32_000   (high — same as SdkSession's `high` level)
 *   - `megathink`     → 32_000   (alias often documented alongside `think harder`)
 *   - `ultrathink`    → 128_000  (max — same as SdkSession's `max` level)
 *
 * @typedef {Object} DetectedThinkingKeyword
 * @property {string} keyword - The matched keyword (lowercased, canonical form)
 * @property {number} budget  - Token budget to pass to setMaxThinkingTokens
 *
 * @param {string} text
 * @returns {DetectedThinkingKeyword | null}
 */
export function detectThinkingKeyword(text) {
  if (typeof text !== 'string' || text.length === 0) return null

  // Longest first so `think harder` wins over `think hard` wins over `think`.
  // Each entry is `[canonicalKeyword, regex, budget]`. The regex uses
  // word-boundary anchors on both sides; the multi-word entries allow a
  // run of horizontal whitespace (space/tab only — NOT `\s`) between
  // words so `think  harder` (double space) still matches but
  // `think\n\nharder` (paragraph boundary) does not. See #4402: `\s+`
  // matched arbitrary newline runs and false-positived on unrelated
  // thoughts the user happened to type on consecutive lines.
  const PATTERNS = [
    ['ultrathink', /\bultrathink\b/i, 128_000],
    ['megathink', /\bmegathink\b/i, 32_000],
    ['think harder', /\bthink[ \t]+harder\b/i, 32_000],
    ['think hard', /\bthink[ \t]+hard\b/i, 10_000],
    ['think', /\bthink\b/i, 4_000],
  ]

  for (const [keyword, regex, budget] of PATTERNS) {
    if (regex.test(text)) return { keyword, budget }
  }
  return null
}

/**
 * Token-budget map keyed by canonical keyword. Useful when callers already
 * know the keyword (e.g. dashboard wants to render the badge) and just need
 * the budget without re-running the regex sweep.
 */
export const THINKING_KEYWORD_BUDGETS = Object.freeze({
  'think': 4_000,
  'think hard': 10_000,
  'think harder': 32_000,
  'megathink': 32_000,
  'ultrathink': 128_000,
})
