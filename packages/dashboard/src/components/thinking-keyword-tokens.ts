/**
 * Tokenise input text for the InputBar "thinking keyword" highlight overlay
 * (#4306). The dashboard renders an `aria-hidden` mirror div behind the
 * textarea; each matched keyword is wrapped in a styled `<span>` so the user
 * sees their `ultrathink` / `think harder` etc. light up inline — matching
 * the native Claude Code REPL UX.
 *
 * The matching rules MUST mirror the server-side `detectThinkingKeyword`
 * (packages/server/src/detect-thinking-keyword.js):
 *
 *   - case-insensitive
 *   - whole-word match (word boundaries)
 *   - LONGEST match wins per position so `think harder` is preferred over
 *     `think hard` is preferred over `think`. The single regex below does
 *     this naturally because regex alternation is ordered and we list the
 *     longest patterns first.
 *
 * If the server-side detection changes (new keyword, different budget map,
 * different boundary rules), this helper must change in lockstep — otherwise
 * the dashboard would highlight a word the server doesn't escalate, or vice
 * versa, both of which silently lie to the user.
 */

export type ThinkingKeywordToken =
  | { kind: 'text'; text: string }
  | { kind: 'keyword'; text: string }

/**
 * Build the matcher once at module load — the regex is global so successive
 * `exec()` calls walk forward through the input. Flags:
 *   - `g`  — global (advance lastIndex on each match)
 *   - `i`  — case-insensitive
 *
 * The `\s+` between the multi-word entries collapses any run of whitespace
 * (spaces, tabs, newlines) so `think  harder` and `think\nharder` still
 * match the same way they do server-side.
 */
const THINKING_KEYWORD_RE = /\b(?:ultrathink|megathink|think\s+harder|think\s+hard|think)\b/gi

/**
 * Split `text` into an ordered list of tokens. Adjacent text runs are not
 * merged; the only invariant the consumer needs is that concatenating every
 * token's `.text` yields the original input verbatim — required for the
 * overlay to line up with the textarea's visible text.
 *
 * Returns `[{ kind: 'text', text: '' }]` for an empty string so the mirror
 * div always has at least one child node (otherwise the empty container
 * collapses below the line-height baseline and the textarea's first line
 * sits a pixel off from the overlay).
 */
export function tokenizeThinkingKeywords(text: string): ThinkingKeywordToken[] {
  if (typeof text !== 'string' || text.length === 0) {
    return [{ kind: 'text', text: '' }]
  }

  const tokens: ThinkingKeywordToken[] = []
  // `exec()`-based loop instead of `String.matchAll` because we also need
  // the gap-text (the run between consecutive matches) — `matchAll` would
  // give us match arrays but not the inter-match slices without bookkeeping
  // we'd need either way.
  const re = new RegExp(THINKING_KEYWORD_RE.source, THINKING_KEYWORD_RE.flags)
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', text: text.slice(lastIndex, match.index) })
    }
    tokens.push({ kind: 'keyword', text: match[0] })
    lastIndex = match.index + match[0].length
    // Defend against zero-length matches — shouldn't be possible with the
    // current regex (no `*` or `?` quantifiers on the alternation as a
    // whole) but a future edit could regress this and produce an infinite
    // loop. Cheap belt-and-braces.
    if (match[0].length === 0) re.lastIndex++
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', text: text.slice(lastIndex) })
  }
  return tokens
}
