import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  SCHEDULED_TASK_HEALTH_TAGS,
  SCHEDULED_TASK_LAST_RUN_STATUSES,
  SCHEDULED_TASK_LAST_RUN_STATUS_VALUES,
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
  // #7038 — a deliberate operator Stop. Its own tag, and deliberately NOT `bad`:
  // the whole defect was that an intentional interrupt was indistinguishable
  // from a provider crash, and leaving it styled like ERROR reinstates that at
  // the tone layer. It is still not healthy — only `OK` ever is.
  [{ enabled: true, lastRun: { status: 'interrupted' } }, 'INTERRUPTED'],
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

  it('exports exactly the eight tags the surfaces render', () => {
    assert.deepEqual(
      [...SCHEDULED_TASK_HEALTH_TAGS].sort(),
      ['ERROR', 'INTERRUPTED', 'NEVER RUN', 'OK', 'PAUSED', 'REFUSED', 'SKIPPED', 'TIMEOUT'],
    )
  })

  // @chroxy/protocol declares the engine's `lastRun.status` roster TWICE, in two
  // files, and both are public exports of the package:
  //
  //   - `SCHEDULED_TASK_LAST_RUN_STATUSES`      (scheduled-task-health.ts)
  //   - `SCHEDULED_TASK_LAST_RUN_STATUS_VALUES` (schemas/server/scheduler.ts)
  //
  // Both document themselves as mirroring `scheduled-task-store.js`'s
  // `LAST_RUN_STATUSES`, so at most one of them can be right when they differ.
  // Nothing imported the second one, which is exactly why it drifted unnoticed
  // when `interrupted` was added (#7038): a roster with no consumer has no test,
  // and a stale-but-exported constant is worse than an absent one — the next
  // consumer to reach for it (a status filter, a `z.enum` built from it) inherits
  // a set that silently omits a status the engine really does persist.
  //
  // Pin them to each other so the NEXT status cannot land in only one half. This
  // is the same failure mode #7024/#7129 closed for the CLI, one file over.
  it('both exported lastRun-status rosters declare the same set (#7038)', () => {
    assert.deepEqual(
      [...SCHEDULED_TASK_LAST_RUN_STATUS_VALUES].sort(),
      [...SCHEDULED_TASK_LAST_RUN_STATUSES].sort(),
      'the two exported status rosters in @chroxy/protocol have drifted — both claim to mirror ' +
        "scheduled-task-store.js's LAST_RUN_STATUSES, so a status added to one must be added to the other " +
        '(scheduled-task-health.ts AND schemas/server/scheduler.ts).',
    )
  })

  it('an INTERRUPTED run is warn-toned, never `ok` and never styled like a crash (#7038)', () => {
    const health = deriveScheduledTaskHealth({ enabled: true, lastRun: { status: 'interrupted' } })
    assert.equal(health.tag, 'INTERRUPTED')
    assert.equal(health.tone, 'warn', 'a deliberate Stop is not a fault — styling it `bad` re-merges it with a crash')
    assert.equal(health.isHealthy, false, 'the work did not complete; only OK is healthy')
    assert.notEqual(
      deriveScheduledTaskHealthTag({ enabled: true, lastRun: { status: 'error' } }),
      'INTERRUPTED',
      'a real error must not borrow the interrupt tag',
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

/**
 * The `lastRun.status` values the CLI is required to declare an EXPLICIT `case`
 * for, DERIVED from the shared status list rather than written out longhand.
 *
 * Derivation is the point. A status added to `SCHEDULED_TASK_LAST_RUN_STATUSES`
 * lands in this set automatically, so the CLI cannot quietly leave it to the
 * `default:` arm and report `ERROR` for something the dashboard reports by name.
 *
 * A status may be excused from an explicit CLI case for exactly ONE reason: the
 * SHARED HELPER also routes it to `'ERROR'`, so the CLI's `default: return
 * 'ERROR'` already agrees with it and a case would be pure noise. That is why
 * the exemption is COMPUTED off `deriveScheduledTaskHealthTag` rather than kept
 * as a hand-written allowlist — today it resolves to exactly `{error}`.
 *
 * A hand-maintained exemption list would be a hole in this guard, not a
 * convenience. It hands a maintainer a one-line way to make a red go away
 * WITHOUT teaching the CLI anything, and if the shared helper gives the new
 * status its own tag, that one line reinstates #7024 verbatim — the CLI reports
 * `ERROR` while the dashboard reports the real tag, and this guard reports
 * green. Deriving the exemption makes that impossible to express: a status can
 * only ride the `default:` arm when both surfaces land on the same tag anyway.
 *
 * ── ADDING A NEW ENGINE STATUS (e.g. #7038) ──────────────────────────────────
 * Adding a status to `SCHEDULED_TASK_LAST_RUN_STATUSES` and giving it its own
 * tag in `deriveScheduledTaskHealthTag` turns the parity test below RED **on
 * purpose**, and the failure message names the missing status. There is exactly
 * ONE correct response: teach the CLI `case '<status>': return '<TAG>'` (and add
 * a GOLDEN row above). A status the shared helper deliberately leaves on its own
 * `default:` arm needs no CLI change and goes green on its own — the derivation
 * below already excuses it, so that case is not even a red.
 */
const CLI_DEFAULT_ARM_STATUSES = new Set(
  [...SCHEDULED_TASK_LAST_RUN_STATUSES].filter(
    (status) => deriveScheduledTaskHealthTag({ enabled: true, lastRun: { status } }) === 'ERROR',
  ),
)

const CLI_REQUIRED_CASE_STATUSES = [...SCHEDULED_TASK_LAST_RUN_STATUSES]
  .filter((status) => !CLI_DEFAULT_ARM_STATUSES.has(status))
  .sort()

/**
 * The source scrape the parity check runs on the CLI, factored out of the test
 * so a self-test can prove it actually DISCRIMINATES.
 *
 * A source-scraping guard that silently matches nothing is worse than no guard
 * at all, and a green run cannot tell the two apart — so the extraction has to
 * be exercised against a known-good and a known-drifted fixture, not only
 * against whatever the real file happens to contain today.
 *
 * @param {string} src
 * @returns {{found: boolean, delimited: boolean, body: string, pairs: string[][], statuses: string[], returned: Set<string>}}
 */
function extractHealthTagCases(src) {
  const empty = { found: false, delimited: false, body: '', pairs: [], statuses: [], returned: new Set() }
  const fnStart = src.indexOf('function healthTag')
  if (fnStart === -1) return empty
  const fn = src.slice(fnStart)
  // A real extraction guard. `assert.ok(fn.length > 0)` could never fire (a
  // slice from a found index is always non-empty), so it asserted nothing —
  // this checks the thing that actually has to hold for the regexes below to
  // mean anything: that the function body was delimited at all.
  const bodyEnd = fn.indexOf('\n}\n')
  if (bodyEnd <= 0) return { ...empty, found: true }
  const body = fn.slice(0, bodyEnd + 1)
  const pairs = [...body.matchAll(/case '([a-z]+)':\s*\n\s*return '([^']+)'/g)].map((m) => [m[1], m[2]])
  return {
    found: true,
    delimited: true,
    body,
    pairs,
    statuses: pairs.map(([status]) => status),
    returned: new Set([...body.matchAll(/return '([^']+)'/g)].map((m) => m[1])),
  }
}

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

    const { delimited, body, pairs, statuses, returned } = extractHealthTagCases(src)
    assert.ok(
      delimited,
      'could not find the end of the CLI healthTag() body — the status/tag extraction below would silently match nothing and pass vacuously',
    )

    // 1. The CLI's tag vocabulary must be a subset of the shared declared set —
    //    a tag the shared helper does not know about is drift.
    for (const tag of returned) {
      assert.ok(
        SCHEDULED_TASK_HEALTH_TAGS.includes(tag),
        `CLI returns tag '${tag}' which is not in SCHEDULED_TASK_HEALTH_TAGS — the surfaces have drifted. Update the shared helper in @chroxy/protocol/scheduled-task-health.ts (and this guard) together.`,
      )
    }

    // 2. The CLI must declare an explicit `case` for EXACTLY the statuses that
    //    need one — no more, no fewer. (#7024)
    //
    //    `assert.ok(pairs.length >= 4)` stood here, and a count cannot express
    //    this. It catches a MISMATCHED mapping but not an OMITTED one: swap
    //    `case 'refused'` for a perfectly correct `case 'error'` and the count
    //    still reads 4, every surviving pair still agrees with the shared helper
    //    below, and the CLI silently reports ERROR for a refused task while the
    //    dashboard reports REFUSED — exactly the one-directional drift this file
    //    exists to catch, waved straight through.
    //
    //    See CLI_REQUIRED_CASE_STATUSES for what to do when this goes red after
    //    a new engine status is added: teach the CLI a case, one line, not a
    //    mystery failure.
    //
    //    A DUPLICATE case is named first and on its own. The set comparison
    //    below sorts and compares, so a duplicate reaches it as an unreadable
    //    array diff (`[refused, success, success, timeout]` vs the expected
    //    four) rather than as "you declared 'success' twice" — and an assertion
    //    that can only ever fire *after* another one has already failed is not
    //    an assertion at all, which is exactly the `assert.ok(fn.length > 0)`
    //    mistake this file just finished removing.
    const duplicates = [...new Set(statuses.filter((s, i) => statuses.indexOf(s) !== i))]
    assert.deepEqual(
      duplicates,
      [],
      `the CLI's healthTag() declares duplicate case(s) for [${duplicates.join(', ')}] — the second is dead code and the switch does not mean what it reads like`,
    )
    assert.deepEqual(
      [...statuses].sort(),
      CLI_REQUIRED_CASE_STATUSES,
      `the CLI's healthTag() must declare an explicit case for exactly [${CLI_REQUIRED_CASE_STATUSES.join(', ')}] ` +
        `(the engine's SCHEDULED_TASK_LAST_RUN_STATUSES minus the ones routed through its default arm: ` +
        `[${[...CLI_DEFAULT_ARM_STATUSES].join(', ')}]). A status missing here falls through to 'ERROR' while the ` +
        `shared helper reports its own tag — silent, one-directional drift.`,
    )

    // 3. Every status→tag case in the CLI must agree with the shared helper.
    for (const [status, tag] of pairs) {
      assert.equal(
        deriveScheduledTaskHealthTag({ enabled: true, lastRun: { status } }),
        tag,
        `CLI maps lastRun.status '${status}' → '${tag}' but the shared helper disagrees`,
      )
    }

    // 4. The precedence the CLI encodes must match: paused first, then never-run.
    assert.match(body, /!task\.enabled\)\s*return 'PAUSED'/, "CLI must check !enabled → PAUSED first")
    assert.match(body, /!task\.lastRun\)\s*return 'NEVER RUN'/, "CLI must check !lastRun → NEVER RUN second")

    // 5. The CLI's default arm must be ERROR (never a friendlier fallback).
    assert.match(body, /default:\s*\n\s*return 'ERROR'/, "CLI's default arm must be ERROR")
  })

  // POSITIVE CONTROL for the scrape above (#7024).
  //
  // The parity check is only as good as its extraction, and "it passed" is the
  // same observation whether the guard verified the CLI or matched nothing at
  // all. So run the SAME extractor over two fixtures whose verdicts must differ,
  // and pin the difference. This is what makes the green above mean something.
  it('the extractor discriminates: a dropped case is caught, and the old count guard would not have caught it', () => {
    const COMPLETE = `function healthTag(task) {
  if (!task.enabled) return 'PAUSED'
  if (!task.lastRun) return 'NEVER RUN'
  switch (task.lastRun.status) {
    case 'success':
      return 'OK'
    case 'refused':
      return 'REFUSED'
    case 'skipped':
      return 'SKIPPED'
    case 'timeout':
      return 'TIMEOUT'
    case 'interrupted':
      return 'INTERRUPTED'
    default:
      return 'ERROR'
  }
}
`
    // The drift #7024 describes, in its ONLY form that survives a count check:
    // `refused` loses its case, and a legitimate explicit `error` case replaces
    // it. Same number of cases, every remaining mapping correct — and a refused
    // task now tags ERROR in the CLI while the dashboard says REFUSED.
    const DRIFTED = COMPLETE.replace("    case 'refused':\n      return 'REFUSED'\n", "    case 'error':\n      return 'ERROR'\n")
    assert.notEqual(DRIFTED, COMPLETE, 'the drift fixture must actually differ, or this control proves nothing')

    const good = extractHealthTagCases(COMPLETE)
    const bad = extractHealthTagCases(DRIFTED)

    // (a) The extractor finds a delimited body and real cases in BOTH — it is
    //     not silently matching nothing, which is the failure mode that would
    //     make every assertion here vacuous.
    assert.ok(good.delimited && bad.delimited, 'the extractor must delimit both fixtures')
    assert.ok(good.pairs.length > 0 && bad.pairs.length > 0, 'the extractor must find cases in both fixtures')

    // (b) The known-GOOD fixture satisfies the tightened assertion.
    assert.deepEqual(
      [...good.statuses].sort(),
      CLI_REQUIRED_CASE_STATUSES,
      "the known-good fixture no longer matches CLI_REQUIRED_CASE_STATUSES — if a status was just added to SCHEDULED_TASK_LAST_RUN_STATUSES, teach the COMPLETE fixture above the same `case` you are teaching the real CLI, or this control stops controlling anything",
    )

    // (c) The known-DRIFTED fixture is caught by the tightened assertion...
    assert.notDeepEqual([...bad.statuses].sort(), CLI_REQUIRED_CASE_STATUSES)
    assert.ok(!bad.statuses.includes('refused'), 'the drifted fixture must be missing the refused case')

    // (d) ...but sails past BOTH of the checks that used to stand here: the
    //     count is unchanged, and every declared mapping still agrees with the
    //     shared helper. That is the whole defect, demonstrated rather than
    //     asserted.
    assert.equal(bad.pairs.length, good.pairs.length, 'the drift must be count-neutral, or it is not the gap #7024 describes')
    assert.ok(bad.pairs.length >= 4, 'the old `pairs.length >= 4` guard would have passed on the drifted source')
    for (const [status, tag] of bad.pairs) {
      assert.equal(
        deriveScheduledTaskHealthTag({ enabled: true, lastRun: { status } }),
        tag,
        `the drifted fixture's surviving mappings must all still agree with the shared helper — '${status}' does not`,
      )
    }

    // (e) And the user-visible consequence the guard now prevents: the drifted
    //     CLI would tag a refused task ERROR where the shared helper says
    //     REFUSED.
    assert.equal(deriveScheduledTaskHealthTag({ enabled: true, lastRun: { status: 'refused' } }), 'REFUSED')
    assert.match(bad.body, /default:\s*\n\s*return 'ERROR'/, 'a refused task in the drifted CLI falls through to this ERROR arm')
  })
})
