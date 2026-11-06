/**
 * A conservative screen for regular expressions that come from outside and are
 * run on the event loop.
 *
 * JavaScript's matcher backtracks, and a pattern with a repeated group that can
 * match the same text in more than one way takes exponential time on a short
 * hostile input — while it runs, nothing else in the process does. There is no
 * way to interrupt a `.test()`, so the pattern is screened before it is ever
 * compiled. This accepts a pattern only when none of the following appears:
 *
 *   - more than `MAX_PATTERN_LENGTH` characters;
 *   - a backreference (`\1`, `\k<name>`);
 *   - a lookaround group;
 *   - a quantified group (`(...)*`, `(...)+`, `(...){n,}`) whose body contains a
 *     quantifier or an alternation — the nested-quantifier and overlapping-
 *     alternation shapes behind exponential backtracking.
 *
 * It is a screen, not a proof: it refuses some harmless patterns, which is the
 * safe direction. Plain literals, anchors, character classes, bounded repeats of
 * a single item and unquantified alternations all pass.
 */
export const MAX_PATTERN_LENGTH = 200

/**
 * @param {unknown} source
 * @returns {boolean} true when the pattern may be compiled and run
 */
export function isSafeRegexSource(source) {
  if (typeof source !== 'string') return false
  if (source.length > MAX_PATTERN_LENGTH) return false
  if (/\\[1-9]|\\k</.test(source)) return false
  if (/\(\?<?[=!]/.test(source)) return false

  // Walk the pattern once, tracking groups. Escapes and character classes are
  // skipped so their contents are not read as syntax.
  const stack = []
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') { i++; continue }
    if (inClass) { if (ch === ']') inClass = false; continue }
    if (ch === '[') { inClass = true; continue }
    if (ch === '(') { stack.push({ risky: false }); continue }
    if (ch === '*' || ch === '+' || ch === '{' || ch === '|') {
      // A quantifier or alternation marks every enclosing group as risky to repeat.
      if (ch !== '{' || /^\{\d+(,\d*)?\}/.test(source.slice(i))) {
        for (const g of stack) g.risky = true
      }
      continue
    }
    if (ch === ')') {
      const group = stack.pop()
      const next = source[i + 1]
      const repeated = next === '*' || next === '+' || (next === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(i + 1))) || next === '?'
      if (group?.risky && repeated && next !== '?') return false
      // The group itself, repeated or not, counts as a quantified item for its parents.
      if (repeated) for (const g of stack) g.risky = true
    }
  }
  return true
}
