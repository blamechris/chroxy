import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  SCHEDULED_TASK_HEALTH_TAGS,
  deriveScheduledTaskHealth,
  deriveScheduledTaskHealthTag,
} from '@chroxy/protocol'

// #6871 — ANTI-DRIFT GUARD for scheduled-task health reporting.
//
// A scheduled task fires an agent session with nobody watching, so "how is this
// task doing?" is a safety readout, not decoration. Two surfaces report it: the
// `chroxy schedule` CLI (#6868) and the dashboard panel (#6871). Both are
// supposed to consume ONE derivation — `deriveScheduledTaskHealth` in
// @chroxy/protocol — precisely so they cannot drift into disagreeing about the
// same task.
//
// This file pins that in two layers:
//   1. A GOLDEN TABLE over the shared helper. Any change to the mapping (a new
//      tag, a changed precedence, a status that starts reporting OK) fails here
//      and must be made deliberately.
//   2. A SOURCE PARITY check against the CLI's `healthTag()`, which activates
//      automatically once #6868/PR #7013 lands `src/cli/schedule-cmd.js` on this
//      branch. Until then it reports as skipped rather than silently passing.

const here = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = join(here, '..', 'src', 'cli', 'schedule-cmd.js')

/**
 * The canonical mapping, written out longhand. This is the contract both
 * surfaces render; it intentionally duplicates the helper's logic so a change to
 * the helper cannot quietly redefine "healthy".
 */
const GOLDEN = [
  // [ task, expected tag ]
  [{ enabled: true, lastRun: { status: 'success' } }, 'OK'],
  [{ enabled: true, lastRun: { status: 'error' } }, 'ERROR'],
  [{ enabled: true, lastRun: { status: 'skipped' } }, 'SKIPPED'],
  [{ enabled: true, lastRun: { status: 'timeout' } }, 'TIMEOUT'],
  [{ enabled: true, lastRun: { status: 'refused' } }, 'REFUSED'],
  [{ enabled: true, lastRun: null }, 'NEVER RUN'],
  // Paused wins over ANY recorded run — a paused task will not fire again.
  [{ enabled: false, lastRun: { status: 'success' } }, 'PAUSED'],
  [{ enabled: false, lastRun: null }, 'PAUSED'],
  [{ enabled: false, lastRun: { status: 'error' } }, 'PAUSED'],
]

describe('scheduled-task health — golden mapping', () => {
  it('maps every engine-emittable status to its canonical tag', () => {
    for (const [task, expected] of GOLDEN) {
      assert.equal(
        deriveScheduledTaskHealthTag(task),
        expected,
        `${JSON.stringify(task)} must report ${expected}`,
      )
    }
  })

  it('exports exactly the seven tags the surfaces render', () => {
    assert.deepEqual(
      [...SCHEDULED_TASK_HEALTH_TAGS].sort(),
      ['ERROR', 'NEVER RUN', 'OK', 'PAUSED', 'REFUSED', 'SKIPPED', 'TIMEOUT'],
    )
  })

  it('every golden tag is a declared tag (no undeclared value can reach a renderer)', () => {
    for (const [, expected] of GOLDEN) {
      assert.ok(SCHEDULED_TASK_HEALTH_TAGS.includes(expected), `${expected} is not declared`)
    }
  })

  it('an UNRECOGNIZED future status degrades to ERROR, never to OK', () => {
    // The one-directional failure that matters: a status this module has never
    // heard of must not fall through to something reassuring.
    for (const status of ['cancelled', 'partial', 'unknown', '', 'SUCCESS', 'ok']) {
      assert.equal(deriveScheduledTaskHealthTag({ enabled: true, lastRun: { status } }), 'ERROR', status)
    }
  })

  it('is total — a malformed or absent task never throws and never reports OK', () => {
    for (const bad of [null, undefined, {}, { enabled: true }, { enabled: true, lastRun: 'nope' }, { lastRun: {} }, 42, 'x']) {
      const tag = deriveScheduledTaskHealthTag(bad)
      assert.ok(SCHEDULED_TASK_HEALTH_TAGS.includes(tag), `${JSON.stringify(bad)} → ${tag}`)
      assert.notEqual(tag, 'OK', `${JSON.stringify(bad)} must not report OK`)
    }
  })
})

describe('scheduled-task health — only OK is healthy', () => {
  it('isHealthy is true for exactly one tag', () => {
    const healthy = GOLDEN.filter(([task]) => deriveScheduledTaskHealth(task).isHealthy)
    assert.equal(healthy.length, 1)
    assert.equal(deriveScheduledTaskHealthTag(healthy[0][0]), 'OK')
  })

  it('tone `ok` is reserved for the healthy tag', () => {
    for (const [task, expected] of GOLDEN) {
      const health = deriveScheduledTaskHealth(task)
      if (expected === 'OK') assert.equal(health.tone, 'ok')
      else assert.notEqual(health.tone, 'ok', `${expected} must not style as healthy`)
    }
  })

  it('QUARANTINE downgrades even a successful task — the record can lie about it', () => {
    // The engine's quarantine write is best-effort (the store is usually the
    // thing that broke), so a quarantined task may still carry a `success`
    // lastRun. It must never present as healthy.
    const health = deriveScheduledTaskHealth({ enabled: true, lastRun: { status: 'success' } }, { quarantined: true })
    assert.equal(health.tag, 'OK', 'the TAG stays CLI-identical (quarantine is engine state, not task state)')
    assert.equal(health.quarantined, true)
    assert.equal(health.isHealthy, false)
    assert.equal(health.tone, 'bad')
  })

  it('a non-quarantined task is not marked quarantined', () => {
    const health = deriveScheduledTaskHealth({ enabled: true, lastRun: { status: 'success' } })
    assert.equal(health.quarantined, false)
    assert.equal(health.isHealthy, true)
  })
})

describe('scheduled-task health — CLI source parity (#6868 / PR #7013)', () => {
  it('the CLI healthTag() maps the same statuses to the same tags', (t) => {
    if (!existsSync(CLI_PATH)) {
      t.skip('src/cli/schedule-cmd.js is not on this branch yet (#6868 / PR #7013 pending) — parity re-checks automatically once it lands')
      return
    }
    const src = readFileSync(CLI_PATH, 'utf-8')
    const fnStart = src.indexOf('function healthTag')

    // The CLI may have DROPPED its local healthTag() in favour of importing the
    // shared helper. That is the stated follow-up for whoever merges #7013
    // second, and it is the ideal end state — it eliminates drift by
    // construction instead of by comparison. So it must not read as a failure.
    //
    // It previously would have: with no `function healthTag`, indexOf returns -1,
    // `slice(-1)` yields the file's LAST CHARACTER, `body` becomes '', every
    // extraction below matches nothing, and the pair-count assertion reports
    // "the surfaces have drifted" at precisely the moment drift became
    // impossible. Assert the import instead.
    if (fnStart === -1) {
      assert.ok(
        src.includes('deriveScheduledTaskHealthTag'),
        'the CLI has no local healthTag() — it must then import deriveScheduledTaskHealthTag from @chroxy/protocol, or it has no health mapping at all',
      )
      assert.match(
        src,
        /from\s+'@chroxy\/protocol'/,
        'the CLI must take its health mapping from the shared @chroxy/protocol module',
      )
      return
    }

    const fn = src.slice(fnStart)
    // A real extraction guard. `assert.ok(fn.length > 0)` could never fire (a
    // slice from a found index is always non-empty), so it asserted nothing —
    // this checks the thing that actually has to hold for the regexes below to
    // mean anything: that the function body was delimited at all.
    const bodyEnd = fn.indexOf('\n}\n')
    assert.ok(
      bodyEnd > 0,
      'could not find the end of the CLI healthTag() body — the status/tag extraction below would silently match nothing and pass vacuously',
    )
    const body = fn.slice(0, bodyEnd + 1)

    // Extract the tags the CLI can return, and the status→tag pairs it declares.
    const returned = new Set([...body.matchAll(/return '([^']+)'/g)].map((m) => m[1]))
    const pairs = [...body.matchAll(/case '([a-z]+)':\s*\n\s*return '([^']+)'/g)]

    // 1. The CLI's tag vocabulary must be a subset of the shared declared set —
    //    a tag the shared helper does not know about is drift.
    for (const tag of returned) {
      assert.ok(
        SCHEDULED_TASK_HEALTH_TAGS.includes(tag),
        `CLI returns tag '${tag}' which is not in SCHEDULED_TASK_HEALTH_TAGS — the surfaces have drifted. Update the shared helper in @chroxy/protocol/scheduled-task-health.ts (and this guard) together.`,
      )
    }

    // 2. Every status→tag case in the CLI must agree with the shared helper.
    assert.ok(pairs.length >= 4, `expected the CLI's status switch to be parseable, got ${pairs.length} pairs`)
    for (const [, status, tag] of pairs) {
      assert.equal(
        deriveScheduledTaskHealthTag({ enabled: true, lastRun: { status } }),
        tag,
        `CLI maps lastRun.status '${status}' → '${tag}' but the shared helper disagrees`,
      )
    }

    // 3. The precedence the CLI encodes must match: paused first, then never-run.
    assert.match(body, /!task\.enabled\)\s*return 'PAUSED'/, "CLI must check !enabled → PAUSED first")
    assert.match(body, /!task\.lastRun\)\s*return 'NEVER RUN'/, "CLI must check !lastRun → NEVER RUN second")

    // 4. The CLI's default arm must be ERROR (never a friendlier fallback).
    assert.match(body, /default:\s*\n\s*return 'ERROR'/, "CLI's default arm must be ERROR")
  })
})
