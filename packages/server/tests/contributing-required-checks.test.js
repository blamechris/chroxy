import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseJobs, code } from './helpers/workflow-reader.js'
import { parseRoster } from '../../../scripts/lib/contributing-roster.mjs'

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

describe('CONTRIBUTING required-checks roster (#7448)', () => {
  let roster
  let jobNames

  before(async () => {
    // The parse is scripts/lib/contributing-roster.mjs — the SAME implementation
    // scripts/check-required-contexts.sh executes, so the two guards cannot
    // disagree about what the roster says (#7499 review, finding: the previous
    // awk copy diverged from this slice on plausible doc edits).
    const contributing = await readFile(new URL('../../../CONTRIBUTING.md', import.meta.url), 'utf8')
    roster = parseRoster(contributing)

    const ciYml = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    // A job's check context is its display name when `name:` is present, else
    // its job id — and YAML quoting is cosmetic, so strip it (a quoted
    // `name: "X"` is the same context as `name: X`).
    jobNames = parseJobs(ciYml).map(j => {
      const m = code(j.body).map(l => /^\s{4}name:\s*(.+?)\s*$/.exec(l)).find(Boolean)
      const raw = m ? m[1] : j.id
      return raw.replace(/^(['"])(.*)\1$/, '$2')
    })
  })

  // ---- positive controls ----
  it('parses exactly the 13 required contexts and the ci.yml job names', () => {
    // EXACT on purpose, not a floor: the #7499 review proved a floor of 12 let
    // any single entry vanish silently — the precise drift this file exists to
    // prevent. The count IS the subject here, so changing the required set
    // must force a same-PR edit of this line. (Contrast the deliberately
    // loose floors in ci-npm-cache-routing.test.js, where the count is NOT
    // the subject and pinning it would misattribute unrelated refactors.)
    assert.equal(roster.length, 13, `expected exactly 13 roster entries, got ${roster.length}: ${roster.join(', ')}`)
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

  it('carries the #7448 addition and the drift that motivated it', () => {
    assert.ok(
      roster.includes('Design Tokens Tests'),
      "CONTRIBUTING.md's roster must list 'Design Tokens Tests' (#7448)"
    )
    // The entry whose omission motivated #7448 — pinned by name so its
    // deletion can never again ride out on a green suite.
    assert.ok(
      roster.includes('Server Windows Tests'),
      "CONTRIBUTING.md's roster must list 'Server Windows Tests' (live-required; its omission is the drift #7448 documents)"
    )
  })

  it('no roster entry or job name is a matrix template', () => {
    // `name: X ${{ matrix.arch }}` is a literal here but GitHub expands it —
    // the real contexts are the expanded forms, so a roster entry matching the
    // template names a context nothing ever produces (#7191 family: every PR
    // wedges while this suite reports the roster clean).
    const templated = [...roster, ...jobNames].filter(n => n.includes('${{'))
    assert.deepEqual(templated, [], `matrix-templated names cannot be required contexts: ${templated.join(', ')}`)
  })
})
