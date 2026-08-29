import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseJobs, code } from './helpers/workflow-reader.js'

/**
 * #7448 — CONTRIBUTING.md's required-checks roster must stay true.
 *
 * The roster is a hand-written list beside a growing set (the exact pattern in
 * docs/false-safety-guards.md), and it had already drifted once before this
 * guard existed: `Server Windows Tests` was live-required while the doc filed
 * it under "other CI jobs run too".
 *
 * What CAN be checked in CI, is: every listed name is a real ci.yml job (a
 * renamed job would otherwise leave a stale name in BOTH the doc and the live
 * protection — the #7191 family, where the required context is never produced
 * again and every PR wedges), plus the #7448 addition itself. What CANNOT be
 * checked here is the live branch-protection set — reading it needs repo-admin
 * scope that CI's GITHUB_TOKEN does not have, and pretending otherwise would be
 * the cannot-check-treated-as-nothing-to-check failure. That half lives in
 * scripts/check-required-contexts.sh (local, exits 2 — never 0 — when blind).
 */

const ROSTER_START = 'Required status checks must be green'
const ROSTER_END = 'wired as required'

describe('CONTRIBUTING required-checks roster (#7448)', () => {
  let roster
  let jobNames

  before(async () => {
    const contributing = await readFile(new URL('../../../CONTRIBUTING.md', import.meta.url), 'utf8')
    const startAt = contributing.indexOf(ROSTER_START)
    const endAt = contributing.indexOf(ROSTER_END)
    assert.ok(startAt !== -1 && endAt > startAt, 'could not locate the required-checks bullet in CONTRIBUTING.md')
    roster = [...contributing.slice(startAt, endAt).matchAll(/`([^`]+)`/g)].map(m => m[1])

    const ciYml = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    jobNames = parseJobs(ciYml)
      .map(j => code(j.body).map(l => /^\s{4}name:\s*(.+?)\s*$/.exec(l)).find(Boolean))
      .filter(Boolean)
      .map(m => m[1])
  })

  // ---- positive controls ----
  it('parses a non-trivial roster and the ci.yml job names', () => {
    assert.ok(roster.length >= 12, `expected >=12 roster entries, got ${roster.length}: ${roster.join(', ')}`)
    assert.ok(jobNames.length >= 10, `expected >=10 ci.yml job names, got ${jobNames.length}`)
  })

  it('lists no duplicates', () => {
    const dupes = roster.filter((n, i) => roster.indexOf(n) !== i)
    assert.deepEqual(dupes, [], `duplicated roster entries: ${dupes.join(', ')}`)
  })

  it('every listed check is a real ci.yml job name', () => {
    const phantoms = roster.filter(n => !jobNames.includes(n))
    assert.deepEqual(
      phantoms,
      [],
      'CONTRIBUTING.md lists required checks that are not ci.yml job names — a renamed or ' +
        `deleted job leaves a context nothing produces (#7191 family): ${phantoms.join(', ')}`
    )
  })

  it('carries the #7448 addition', () => {
    assert.ok(
      roster.includes('Design Tokens Tests'),
      "CONTRIBUTING.md's roster must list 'Design Tokens Tests' (#7448)"
    )
  })
})
