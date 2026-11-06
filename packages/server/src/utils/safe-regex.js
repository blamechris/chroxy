/**
 * A cheap pre-filter for regular expressions that come from outside, applied
 * BEFORE a pattern is accepted. It is NOT the safety mechanism.
 *
 * No static screen can prove that a backtracking pattern is fast (overlapping
 * repeats separated by a literal, adjacent bounded repeats, repeats hidden in
 * non-capturing groups all defeat one). What keeps the daemon responsive is that
 * the pattern is never run on the event loop: `utils/bounded-regex.js` runs it in
 * a worker with a per-match deadline and a cap on the tested text, and a match
 * that runs out its deadline counts as no match.
 *
 * What this screen still refuses, because it is cheap and almost never wanted:
 *   - a pattern over `MAX_PATTERN_LENGTH` characters;
 *   - a backreference (`\1`..`\9`, `\k<name>`), read from the parse so that an
 *     escaped backslash followed by a digit (`\\1`) is not mistaken for one;
 *   - the classic nested shape: a group repeated without a bound (`*`, `+`,
 *     `{n,}`) whose body BEGINS with an unbounded repeat, such as `(a+)+`,
 *     `(.*a)*` or `(\s*x)+`.
 * Everything else, including other patterns that can backtrack badly, is accepted
 * and left to the time bound.
 */
export const MAX_PATTERN_LENGTH = 200

class Refused extends Error {}

/**
 * @param {unknown} source
 * @returns {boolean} true when the pattern passes the pre-filter
 */
export function isSafeRegexSource(source) {
  if (typeof source !== 'string') return false
  if (source.length > MAX_PATTERN_LENGTH) return false
  try {
    const end = parseAlternation(source, 0, 0)
    return end.i === source.length
  } catch {
    return false
  }
}

function parseQuantifier(src, i) {
  const c = src[i]
  let unbounded = false
  let any = true
  let j = i + 1
  if (c === '*' || c === '+') {
    unbounded = true
  } else if (c === '?') {
    // optional
  } else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i))
    if (!m) return { next: i, unbounded: false, any: false }
    j = i + m[0].length
    unbounded = m[2] !== undefined && m[3] === ''
  } else {
    return { next: i, unbounded: false, any: false }
  }
  if (src[j] === '?') j++ // lazy
  return { next: j, unbounded, any }
}

/**
 * Parse alternatives until the closing ')' or the end. Returns the index reached
 * and whether some alternative BEGINS with an unbounded repeat.
 */
function parseAlternation(src, start, depth) {
  let i = start
  let startsUnbounded = false
  let first = true // the next atom is the first of its alternative
  while (i < src.length) {
    const c = src[i]
    if (c === ')') {
      if (depth === 0) throw new Refused()
      return { i, startsUnbounded }
    }
    if (c === '|') { first = true; i++; continue }
    let atomStartsUnbounded = false
    if (c === '(') {
      let j = i + 1
      if (src[j] === '?') {
        // (?: ... ), (?<name> ... ), or a lookaround (?= ?! ?<= ?<!): all parse as a group.
        const m = /^\?(:|=|!|<=|<!|<[A-Za-z_]\w*>)/.exec(src.slice(j))
        if (!m) throw new Refused()
        j += m[0].length
      }
      const inner = parseAlternation(src, j, depth + 1)
      if (src[inner.i] !== ')') throw new Refused()
      atomStartsUnbounded = inner.startsUnbounded
      i = inner.i + 1
    } else if (c === '[') {
      let j = i + 1
      if (src[j] === '^') j++
      for (; j < src.length && src[j] !== ']'; j++) if (src[j] === '\\') j++
      if (j >= src.length) throw new Refused()
      i = j + 1
    } else if (c === '\\') {
      const next = src[i + 1]
      // A backreference is a backslash that is NOT itself escaped (this walk
      // consumes `\\` as one atom) followed by 1-9, or \k<.
      if ((next >= '1' && next <= '9') || (next === 'k' && src[i + 2] === '<')) throw new Refused()
      i += 2
    } else {
      i++
    }
    const q = parseQuantifier(src, i)
    if (q.unbounded && atomStartsUnbounded) throw new Refused()
    if (first && (q.unbounded || atomStartsUnbounded)) startsUnbounded = true
    first = false
    i = q.next
  }
  if (depth !== 0) throw new Refused()
  return { i, startsUnbounded }
}
