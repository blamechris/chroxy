// The ONE parse of CONTRIBUTING.md's required-checks roster (#7448/#7499).
//
// Imported by packages/server/tests/contributing-required-checks.test.js and
// executed as a CLI by scripts/check-required-contexts.sh — the review of
// #7499 constructed doc edits on which the previous two independent grammars
// (a JS slice and an awk range) disagreed, one reporting drift the other
// denied. One implementation, or the copies drift.
//
// CLI contract: prints one roster name per line on stdout; exits 1 with a
// REFUSE line on stderr when the roster cannot be parsed — never a partial
// list, never a silent empty.
import { readFile } from 'node:fs/promises'
import { isEntryPoint } from './is-entry-point.mjs'

export const ROSTER_START = 'Required status checks must be green'
export const ROSTER_END = 'wired as required'

export function parseRoster(contributingText) {
  const startAt = soleIndexOf(contributingText, ROSTER_START, 'roster start')
  const endAt = soleIndexOf(contributingText, ROSTER_END, 'roster end')
  if (endAt <= startAt) {
    throw new Error('could not locate the required-checks bullet (anchors reordered)')
  }
  const roster = [...contributingText.slice(startAt, endAt).matchAll(/`([^`]+)`/g)].map(m => m[1])
  if (roster.length < 10) {
    throw new Error(`parsed only ${roster.length} roster entries — the bullet shape has changed`)
  }
  const implausible = roster.filter(n => n.includes('/') || n.includes('~') || n.includes('${{'))
  if (implausible.length > 0) {
    throw new Error(`implausible roster entries (the slice overran the bullet?): ${implausible.join(', ')}`)
  }
  return roster
}

/**
 * The heading that opens the not-required table, and the sentinel that closes
 * it. Both are literal so a doc edit that moves or renames the section fails
 * the parse loudly instead of silently yielding an empty exemption set — an
 * empty set would make the partition guard vacuous, which is the
 * "filter whose terms match nothing" failure in docs/false-safety-guards.md.
 */
export const EXEMPT_START = '#### Jobs that run on a PR and are deliberately not required'
export const EXEMPT_END = '<!-- end not-required table -->'

/**
 * The index of `needle` in `text`, refusing when it appears anything other than
 * exactly once.
 *
 * `indexOf` silently takes the FIRST match, so a phrase that later appears
 * twice — in prose, in a second heading, in an example — slices a region the
 * author never meant and the parse succeeds against the wrong text. That is the
 * failure Copilot flagged on #7643 against a broader `EXEMPT_START`, and it
 * survives narrowing the anchor: a heading can be duplicated too. Refusing on
 * ambiguity is the fail-loud property these anchors exist for, and it costs
 * nothing to state.
 */
function soleIndexOf(text, needle, what) {
  const first = text.indexOf(needle)
  if (first === -1) throw new Error(`could not locate the ${what} anchor (${JSON.stringify(needle)})`)
  if (text.indexOf(needle, first + 1) !== -1) {
    throw new Error(`the ${what} anchor appears more than once (${JSON.stringify(needle)}) — the slice would be ambiguous`)
  }
  return first
}

/**
 * The check names in CONTRIBUTING.md's "deliberately not required" table.
 *
 * One entry per PR-visible job that is NOT a merge gate, read as the FIRST
 * backticked cell of each table row. The remaining cells (workflow, reason)
 * carry backticks of their own — issue numbers, file names — so taking only the
 * first per row is what keeps a reason like `#7491` out of the name set.
 *
 * That does assume the check name is the first backticked span in its row. A
 * row with the columns swapped, or with an empty first cell, is MIS-PARSED
 * rather than refused — this function cannot tell a workflow name from a check
 * name. It is not the last line of defence and does not pretend to be: the
 * partition rules compare whatever comes back against the real jobs, so a
 * mis-parsed row surfaces as a phantom plus an unclassified job, which is a
 * legible failure rather than a silent pass.
 *
 * Fails closed on the shapes that mean "this parse did not work": missing
 * anchors, a table that yielded nothing, or a name that cannot be a check
 * context. It never returns a partial list.
 *
 * THE FLOOR IS ONE ROW, NOT FIVE, and the difference matters. A `< 5` floor was
 * written here first, on the reasoning that a plausible table has several rows.
 * It is wrong in the direction that breaks a CORRECT change: promoting rows to
 * the required roster is the whole intended lifecycle of this table, and taking
 * it from ten rows to four — six promotions, exactly what #7639 contemplates —
 * is a right answer that a `< 5` floor turns into a hard failure with a message
 * about the table "shape" having changed (#7643 review).
 *
 * A floor that fires on a correct edit is not a safety net; it is a tax on
 * doing the thing the document is for. What the floor must actually catch is a
 * parse that produced nothing, and `< 1` catches exactly that. Everything
 * stronger is already covered by the partition rules in
 * ci-required-check-partition.test.js, which compare this list against the real
 * jobs rather than against a guess about how long it ought to be.
 */
export function parseExemptions(contributingText) {
  const startAt = soleIndexOf(contributingText, EXEMPT_START, 'not-required table start')
  const endAt = soleIndexOf(contributingText, EXEMPT_END, 'not-required table end')
  if (endAt <= startAt) {
    throw new Error('could not locate the not-required table (anchors reordered)')
  }

  const names = []
  for (const line of contributingText.slice(startAt, endAt).split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    // The header row and the `| --- |` separator carry no backticked cell.
    const m = /`([^`]+)`/.exec(line)
    if (m) names.push(m[1])
  }

  if (names.length < 1) {
    throw new Error('parsed no not-required entries — the table is empty or its shape has changed')
  }
  const implausible = names.filter(n => n.includes('/') || n.includes('~') || n.includes('${{'))
  if (implausible.length > 0) {
    throw new Error(`implausible not-required entries (the slice overran the table?): ${implausible.join(', ')}`)
  }
  return names
}

if (isEntryPoint(import.meta.url)) {
  try {
    const text = await readFile(new URL('../../CONTRIBUTING.md', import.meta.url), 'utf8')
    process.stdout.write(parseRoster(text).join('\n') + '\n')
  } catch (err) {
    process.stderr.write(`REFUSE: ${err.message}\n`)
    process.exit(1)
  }
}
