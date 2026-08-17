/**
 * strip-comments.mjs — blank out JS comments, preserving every offset.
 *
 * Extracted verbatim from `lint-claude-family-explicit.mjs` (#5891) when
 * `lint-entry-point-guard.mjs` (#7235) needed the same thing, rather than
 * writing a fourth copy of it in the very PR whose subject is "stop the fourth
 * hand-rolled copy of a thing".
 *
 * Two other lints still carry their own: `lint-config-dir.mjs` returns an ARRAY
 * of stripped lines and is not string-aware, and `lint-session-opt-forwarding.mjs`
 * drops line-comment text entirely rather than blanking it. Neither is a drop-in
 * for this signature, so migrating them is real work with its own review — it is
 * filed rather than smuggled in here.
 *
 * String literals are deliberately LEFT INTACT. Every consumer so far wants that:
 * a lint fixture embedded in a template literal is text the lint should still be
 * able to see, and a construct written inside a string is not a real occurrence
 * of it either way. A consumer that needs strings blanked too should say so
 * explicitly rather than assume it.
 */

/**
 * Replace `//` line comments and block comments with spaces, keeping newlines,
 * so every character index and line number in the result matches the input.
 *
 * @param {string} src
 * @returns {string} the same length as `src`, with comment spans blanked
 */
export function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  let inStr = null
  while (i < n) {
    const ch = src[i]
    if (inStr) {
      out += ch
      if (ch === '\\' && i + 1 < n) { out += src[i + 1]; i += 2; continue }
      if (ch === inStr) inStr = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; out += ch; i++; continue }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      out += '  '; i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++ }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    out += ch
    i++
  }
  return out
}
