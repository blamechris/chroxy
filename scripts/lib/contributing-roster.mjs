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
  const startAt = contributingText.indexOf(ROSTER_START)
  const endAt = contributingText.indexOf(ROSTER_END)
  if (startAt === -1 || endAt <= startAt) {
    throw new Error('could not locate the required-checks bullet (anchors missing or reordered)')
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
export const EXEMPT_START = 'deliberately not required'
export const EXEMPT_END = '<!-- end not-required table -->'

/**
 * The check names in CONTRIBUTING.md's "deliberately not required" table.
 *
 * One entry per PR-visible job that is NOT a merge gate, read as the FIRST
 * backticked cell of each table row. The remaining cells (workflow, reason)
 * carry backticks of their own — issue numbers, file names — so taking only the
 * first per row is what keeps a reason like `#7491` out of the name set.
 *
 * Fails closed on every shape it does not understand: missing anchors, a table
 * that parsed to nothing, or a name that cannot be a check context. It never
 * returns a partial list.
 *
 * THE `< 5` FLOOR IS REDUNDANT TODAY, and is kept deliberately rather than
 * because a mutant proved it. Emptying the table was run against this parser
 * both with the floor and without it, and BOTH are red: the partition rules in
 * ci-required-check-partition.test.js independently report all ten jobs as
 * unclassified. So the floor is an inert mutant above a fail-closed default,
 * not a missing assertion — the distinction docs/false-safety-guards.md asks
 * for, recorded here so the next reader does not "prove" it with a case that
 * actually exercises the partition rules. What it buys is the same contract
 * `parseRoster` gives its own CLI consumer: a FUTURE caller that reads
 * exemptions WITHOUT partition rules behind it inherits the refusal instead of
 * a silent empty list.
 */
export function parseExemptions(contributingText) {
  const startAt = contributingText.indexOf(EXEMPT_START)
  const endAt = contributingText.indexOf(EXEMPT_END)
  if (startAt === -1 || endAt <= startAt) {
    throw new Error('could not locate the not-required table (anchors missing or reordered)')
  }

  const names = []
  for (const line of contributingText.slice(startAt, endAt).split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    // The header row and the `| --- |` separator carry no backticked cell.
    const m = /`([^`]+)`/.exec(line)
    if (m) names.push(m[1])
  }

  if (names.length < 5) {
    throw new Error(`parsed only ${names.length} not-required entries — the table shape has changed`)
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
