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

const invokedAsCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (invokedAsCli) {
  try {
    const text = await readFile(new URL('../../CONTRIBUTING.md', import.meta.url), 'utf8')
    process.stdout.write(parseRoster(text).join('\n') + '\n')
  } catch (err) {
    process.stderr.write(`REFUSE: ${err.message}\n`)
    process.exit(1)
  }
}
