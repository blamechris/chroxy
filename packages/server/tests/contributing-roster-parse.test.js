import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRoster,
  parseExemptions,
  ROSTER_START,
  ROSTER_END,
  EXEMPT_START,
  EXEMPT_END,
} from '../../../scripts/lib/contributing-roster.mjs'

/**
 * The REFUSAL branches of CONTRIBUTING.md's two parsers (#7643).
 *
 * Both are read by three consumers — contributing-required-checks.test.js,
 * ci-required-check-partition.test.js and scripts/check-required-contexts.sh —
 * and every one of them quantifies over whatever comes back. A parser that
 * returned a PARTIAL or EMPTY list instead of throwing would leave all three
 * reporting a clean green over a document they never really read: the
 * cannot-check-treated-as-nothing-to-check failure in
 * docs/false-safety-guards.md.
 *
 * Until this file existed those branches were exercised only by the happy-path
 * read of the repo's real CONTRIBUTING.md — which is to say, not at all
 * (Copilot, reviewing #7643). Every case here is a synthetic document, because
 * a shape the real document does not currently have is exactly the one no
 * repo-reading test can prove is handled.
 *
 * Each `assert.throws` pins the MESSAGE, not just the fact of throwing: a
 * refusal that fires for the wrong reason is how a case silently degrades into
 * a weaker one.
 */

/** A minimal document both parsers accept, as the base for each mutation. */
const ROSTER_NAMES = [
  'Server Tests', 'Server Lint', 'Server Windows Tests', 'Protocol Tests',
  'Store Core Tests', 'Store Core Type Check', 'Dashboard Tests',
  'Dashboard Type Check', 'Design Tokens Tests', 'App Tests', 'App Type Check',
]

function doc({ roster = ROSTER_NAMES, rows = null, start = ROSTER_START, end = ROSTER_END,
               exemptStart = EXEMPT_START, exemptEnd = EXEMPT_END, extra = '' } = {}) {
  const names = roster.map(n => `\`${n}\``).join(', ')
  const table = (rows ?? [
    ['Style Lint', 'ci.yml', 'ratchet only'],
    ['notify', 'repo-relay.yml', 'not a gate'],
  ]).map(([n, w, why]) => `| \`${n}\` | \`${w}\` | ${why} |`).join('\n')
  return `# Contributing

- **${start}.** These checks block the merge: ${names}. That is the set ${end}.

${extra}${exemptStart}

| Check | Workflow | Why |
| --- | --- | --- |
${table}

${exemptEnd}
`
}

describe('parseRoster refuses rather than returning a partial list (#7643)', () => {
  it('CONTROL: a well-formed document parses, so the rules are not deny-everything', () => {
    assert.deepEqual(parseRoster(doc()), ROSTER_NAMES)
  })

  it('refuses a missing start anchor', () => {
    assert.throws(() => parseRoster(doc({ start: 'Some other heading entirely' })), /roster start anchor/)
  })

  it('refuses a missing end anchor', () => {
    assert.throws(() => parseRoster(doc({ end: 'something else' })), /roster end anchor/)
  })

  it('refuses a DUPLICATED anchor rather than silently slicing the first', () => {
    // `indexOf` takes the first match, so a phrase repeated in prose or a second
    // heading slices a region the author never meant — and the parse SUCCEEDS
    // against the wrong text. Flagged by Copilot on #7643.
    assert.throws(
      () => parseRoster(doc({ extra: `Prose mentioning ${ROSTER_START} again.\n\n` })),
      /roster start anchor appears more than once/
    )
  })

  it('refuses when the anchors are reordered', () => {
    const d = `${ROSTER_END} ... \`A\`, \`B\` ... ${ROSTER_START}`
    assert.throws(() => parseRoster(d), /reordered/)
  })

  it('refuses a roster that parsed too few entries to be the real bullet', () => {
    assert.throws(() => parseRoster(doc({ roster: ['Server Tests', 'App Tests'] })), /parsed only 2 roster entries/)
  })

  it('refuses entries that cannot be check contexts — the slice overran the bullet', () => {
    const withPath = [...ROSTER_NAMES, 'scripts/lint.sh']
    assert.throws(() => parseRoster(doc({ roster: withPath })), /implausible roster entries/)
  })

  it('refuses a matrix-templated entry, which names a context nothing produces', () => {
    const templated = [...ROSTER_NAMES, 'Build ${{ matrix.os }}']
    assert.throws(() => parseRoster(doc({ roster: templated })), /implausible roster entries/)
  })
})

describe('parseExemptions refuses rather than returning a partial list (#7643)', () => {
  it('CONTROL: a well-formed table parses, so the rules are not deny-everything', () => {
    assert.deepEqual(parseExemptions(doc()), ['Style Lint', 'notify'])
  })

  it('refuses a missing start anchor', () => {
    assert.throws(() => parseExemptions(doc({ exemptStart: '#### Something Else' })), /not-required table start anchor/)
  })

  it('refuses a missing end sentinel', () => {
    assert.throws(() => parseExemptions(doc({ exemptEnd: '<!-- other -->' })), /not-required table end anchor/)
  })

  it('refuses a DUPLICATED start anchor', () => {
    assert.throws(
      () => parseExemptions(doc({ extra: `${EXEMPT_START}\n\n` })),
      /not-required table start anchor appears more than once/
    )
  })

  it('refuses when the sentinel precedes the heading', () => {
    const d = `${EXEMPT_END}\n\n${EXEMPT_START}\n\n| \`A\` | \`b\` | c |\n`
    assert.throws(() => parseExemptions(d), /reordered/)
  })

  it('refuses an EMPTY table — the shape changed or the parse failed', () => {
    assert.throws(() => parseExemptions(doc({ rows: [] })), /parsed no not-required entries/)
  })

  it('accepts a legitimately SHRUNK table — promoting rows is the intended lifecycle', () => {
    // The floor was `< 5` first, and 10 -> 4 rows (six promotions, exactly what
    // #7639 contemplates) is a CORRECT edit it turned into a hard failure. A
    // floor that fires on a right answer is a tax, not a net.
    assert.deepEqual(parseExemptions(doc({ rows: [['notify', 'repo-relay.yml', 'not a gate']] })), ['notify'])
  })

  it('refuses an entry that cannot be a check context', () => {
    assert.throws(
      () => parseExemptions(doc({ rows: [['scripts/thing.sh', 'ci.yml', 'x']] })),
      /implausible not-required entries/
    )
  })

  it('takes only the FIRST backticked cell, so a reason cannot leak a name', () => {
    // Reasons routinely carry backticked issue refs and file names; reading
    // every span would put `#7491` into the set of check contexts.
    assert.deepEqual(
      parseExemptions(doc({ rows: [['Claude Hooks Tests', 'ci.yml', 'pending `#7491`, see `ci.yml`']] })),
      ['Claude Hooks Tests']
    )
  })

  it('skips the header and separator rows, which carry no backticked cell', () => {
    // Guards the other direction: a parse that took every `|` line would report
    // "Check" and "---" as exempt check names.
    const names = parseExemptions(doc())
    assert.ok(!names.includes('Check'), 'the header row must not become an entry')
    assert.ok(!names.some(n => n.includes('---')), 'the separator row must not become an entry')
  })
})
