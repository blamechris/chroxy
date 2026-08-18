/**
 * strip-comments.mjs — blank out JS/TS comments, preserving every offset.
 *
 * ## Why this is a parser and not a regex loop
 *
 * This started life as a hand-written character scanner, extracted from
 * `lint-claude-family-explicit.mjs` (#5891) when `lint-entry-point-guard.mjs`
 * (#7235) needed the same thing. Review of #7247 proved that scanner unsound in
 * BOTH directions, on real files in this repo, because it could not tell a
 * regex literal from a comment delimiter:
 *
 *   - `u.replace(/\/*$/, '')` — the `\/` leaves a `/`, the next char is `*`, and
 *     the scanner reads `/*` as a BLOCK COMMENT OPEN. Everything to the next
 *     `*​/` or EOF is blanked, so any code after it is invisible to the caller.
 *     That is a silent false negative: a guard hidden behind an ordinary
 *     trailing-slash trim would never be found.
 *   - `/(["])/g` — the `"` inside the character class put the scanner into a
 *     phantom STRING state, so it stopped blanking comments for the rest of the
 *     file. That is a false positive: ordinary prose then reads as code.
 *
 * Measured across the 1903 files the entry-point lint walks: 83 files differed
 * from the truth, 40 of them hiding real code and 51 leaking comment text. Both
 * numbers are the false-safety class `docs/false-safety-guards.md` is about, in
 * a module whose entire job is to let a guard read source correctly.
 *
 * Distinguishing `/` as regex-start from `/` as division cannot be done by
 * scanning characters — it needs the grammar. So this asks a real parser.
 * TypeScript's is used rather than acorn's because the callers walk `.ts`/`.tsx`
 * as well as `.js`, and acorn cannot parse those. Over those same 1903 files it
 * produces zero parse failures and takes ~2.4s.
 *
 * ## Contract
 *
 * The result is the SAME LENGTH as the input, with comment spans replaced by
 * spaces and newlines preserved, so every index and line number a caller
 * computes on the result is valid on the original. That invariant is asserted,
 * not assumed: a violation throws rather than returning subtly-shifted text,
 * because a caller reporting `file:line` off a shifted offset is wrong in a way
 * nothing downstream can detect.
 *
 * String and template literals are deliberately LEFT INTACT. Every caller wants
 * that: a lint fixture embedded in a template literal is text the lint should
 * still see. A caller that needs strings blanked too should say so explicitly
 * rather than assume it.
 *
 * Every lint in `packages/server/scripts/` uses this one as of #7248 — there is
 * no other implementation in the repo. Both of the copies this replaced were
 * regex-blind in the way described above, in opposite directions:
 * `lint-config-dir.mjs`'s was not string-aware and HID code after a URL literal;
 * `lint-session-opt-forwarding.mjs`'s desynced on a quote inside a character
 * class and LEAKED comment text as code.
 */

import ts from 'typescript'

const SCRIPT_KIND_BY_EXT = [
  ['.tsx', ts.ScriptKind.TSX],
  ['.jsx', ts.ScriptKind.JSX],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.ts', ts.ScriptKind.TS],
]

/** TSX and JSX parse differently from plain TS/JS, so the extension matters. */
function scriptKindFor(fileName) {
  for (const [ext, kind] of SCRIPT_KIND_BY_EXT) {
    if (fileName.endsWith(ext)) return kind
  }
  return ts.ScriptKind.JS
}

/**
 * Every comment range in `text`.
 *
 * Comments are trivia, so they hang off token positions rather than appearing
 * in the tree. Walking `getChildren()` reaches every TOKEN, not just every
 * node — `forEachChild` skips punctuation, and a comment can sit in front of a
 * closing brace — and both the leading and trailing side of each position are
 * collected, because a same-line `// like this` after an expression is trailing
 * trivia of the thing before it, not leading trivia of the thing after.
 */
function commentRanges(text, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKindFor(fileName),
  )
  const seen = new Set()
  const ranges = []
  const collect = (pos) => {
    const found = [
      ...(ts.getLeadingCommentRanges(text, pos) || []),
      ...(ts.getTrailingCommentRanges(text, pos) || []),
    ]
    for (const range of found) {
      const key = `${range.pos}:${range.end}`
      if (seen.has(key)) continue
      seen.add(key)
      ranges.push(range)
    }
  }
  const walk = (node) => {
    collect(node.getFullStart())
    collect(node.getEnd())
    for (const child of node.getChildren(sourceFile)) walk(child)
  }
  walk(sourceFile)
  return ranges.sort((a, b) => a.pos - b.pos)
}

/**
 * Replace comment spans with spaces, keeping newlines, so the result lines up
 * with the input character for character.
 *
 * @param {string} src
 * @param {string} [fileName] - used only to pick the parser's script kind
 * @returns {string} the same length as `src`, with comment spans blanked
 * @throws if the parser produced ranges that would change the text's length
 */
export function stripComments(src, fileName = 'input.js') {
  let out = ''
  let cursor = 0
  for (const range of commentRanges(src, fileName)) {
    // Ranges can nest or repeat across the leading/trailing collection above;
    // anything already consumed is skipped rather than double-counted.
    if (range.pos < cursor) continue
    out += src.slice(cursor, range.pos)
    // Built by slicing, never from a code-point array: `[...src]` splits by code
    // point while the parser's offsets are UTF-16, so a single emoji anywhere
    // above a comment would shift every subsequent index.
    out += src.slice(range.pos, range.end).replace(/[^\n]/g, ' ')
    cursor = range.end
  }
  out += src.slice(cursor)

  if (out.length !== src.length) {
    throw new Error(
      `strip-comments: blanking ${fileName} changed its length (${src.length} -> ${out.length}). `
      + 'Offsets would be wrong, so every line number derived from this is wrong.',
    )
  }
  return out
}
