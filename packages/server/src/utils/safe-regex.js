/**
 * A conservative screen for regular expressions that come from outside and are
 * run on the event loop.
 *
 * JavaScript's matcher backtracks, and a pattern with a repeated group that can
 * match the same text in more than one way, or with adjacent unbounded repeats
 * of overlapping items, takes exponential or high-polynomial time on a short
 * hostile input — while it runs, nothing else in the process does. There is no
 * way to interrupt a `.test()`, so the pattern is screened before it is ever
 * compiled.
 *
 * WHAT THIS GUARANTEES: a pattern is accepted only if none of the following
 * holds. It is a screen over a parse of the pattern, not a proof of linear time,
 * and it errs towards refusing:
 *   - longer than `MAX_PATTERN_LENGTH` characters;
 *   - a backreference (`\1`, `\k<name>`) or a lookaround group;
 *   - a group repeated without a bound (`*`, `+`, `{n,}`) whose body contains
 *     any quantifier (including `?` and `{n,m}`) or an alternation;
 *   - a bounded repeat of a group that contains an unbounded repeat (`(.*a){12}`);
 *   - two unbounded repeats (`*`, `+`, `{n,}`) with nothing mandatory between
 *     them (optional items in between do not count as mandatory): `a*a*`,
 *     `\s*\s*x`, `a+b*c+`.
 * Plain literals, anchors, character classes, a single unbounded repeat per
 * stretch of the pattern, bounded repeats, optional items and unrepeated
 * alternations pass.
 */
export const MAX_PATTERN_LENGTH = 200

class Refused extends Error {}

/**
 * @param {unknown} source
 * @returns {boolean} true when the pattern may be compiled and run
 */
export function isSafeRegexSource(source) {
  if (typeof source !== 'string') return false
  if (source.length > MAX_PATTERN_LENGTH) return false
  if (/\\[1-9]|\\k</.test(source)) return false
  if (/\(\?<?[=!]/.test(source)) return false
  try {
    const end = parseAlternation(source, 0, 0)
    // An unmatched ')' leaves input unread: not a pattern this screen understands.
    return end.i === source.length
  } catch (err) {
    if (err instanceof Refused) return false
    return false
  }
}

/** Parse a quantifier at `i`; returns { next, unbounded, optional, any } */
function parseQuantifier(src, i) {
  const c = src[i]
  let unbounded = false
  let optional = false
  let any = true
  let j = i + 1
  if (c === '*') { unbounded = true; optional = true } else if (c === '+') { unbounded = true } else if (c === '?') { optional = true } else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i))
    if (!m) return { next: i, unbounded: false, optional: false, any: false }
    j = i + m[0].length
    const min = Number(m[1])
    unbounded = m[2] !== undefined && m[3] === ''
    optional = min === 0
  } else {
    return { next: i, unbounded: false, optional: false, any: false }
  }
  if (src[j] === '?') j++ // lazy
  return { next: j, unbounded, optional, any }
}

/**
 * Parse alternatives until the closing ')' or the end. Returns the index reached
 * and whether the body held a quantifier or an alternation.
 */
function parseAlternation(src, start, depth) {
  let i = start
  let busy = false // body contains a quantifier or an alternation
  let pending = false // an unbounded repeat with nothing mandatory since
  let unbounded = false // body contains an unbounded repeat
  while (i < src.length) {
    const c = src[i]
    if (c === ')') {
      if (depth === 0) throw new Refused()
      return { i, busy, unbounded }
    }
    if (c === '|') { busy = true; pending = false; i++; continue }
    // One atom.
    let atomBusy = false
    let atomUnbounded = false
    if (c === '(') {
      let j = i + 1
      if (src[j] === '?') {
        // (?: ... ) or (?<name> ... ); lookarounds were refused up front.
        const m = /^\?(:|<[A-Za-z_][\w]*>)/.exec(src.slice(j))
        if (!m) throw new Refused()
        j += m[0].length
      }
      const inner = parseAlternation(src, j, depth + 1)
      if (src[inner.i] !== ')') throw new Refused()
      atomBusy = inner.busy
      atomUnbounded = inner.unbounded
      i = inner.i + 1
    } else if (c === '[') {
      let j = i + 1
      if (src[j] === '^') j++
      for (; j < src.length && src[j] !== ']'; j++) if (src[j] === '\\') j++
      if (j >= src.length) throw new Refused()
      i = j + 1
    } else if (c === '\\') {
      i += 2
    } else {
      i++
    }
    const q = parseQuantifier(src, i)
    if (q.any) busy = true
    if (q.unbounded && atomBusy) throw new Refused()
    // A bounded repeat of a group that itself holds an unbounded repeat multiplies
    // the work per iteration: `(.*a){12}$`.
    if (q.any && !q.unbounded && c === '(' && atomUnbounded) throw new Refused()
    if (q.unbounded) {
      unbounded = true
      if (pending) throw new Refused()
      pending = true
    } else if (!q.optional && !(c === '^' || c === '$')) {
      pending = false
    }
    if (atomBusy) busy = true
    if (atomUnbounded) unbounded = true
    i = q.next
  }
  if (depth !== 0) throw new Refused()
  return { i, busy, unbounded }
}
