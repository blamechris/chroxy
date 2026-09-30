import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWorkflows, assertReaderSane, jobName, parseJobs, stepRun, stepInput, code, valuelessKey } from './helpers/workflow-reader.js'

/**
 * #8160 — release.yml's Test Suite ran the server package's `npm test` on the
 * same `ubuntu-24.04` image as ci.yml's Server Tests job, but without the
 * ripgrep prerequisite that job installs (#7295). One server test file
 * hard-fails — not skips — in CI when `rg` is missing:
 * `tests/built-in-tools/grep-argv-injection.test.js` (`requireRgOrSkip`); the
 * #7978 oracle in `tests/permission-floor-grep-glob.test.js` has the same
 * hard-fail in its describe-level `before` hook, which cancels every test
 * under that describe rather than failing each one individually. Merging
 * #8157 tagged v0.11.1 and dispatched release.yml (run 36669663799);
 * Test Suite failed with ten counted failures, all of them in
 * grep-argv-injection.test.js, plus the #7978 oracle's hook failure and its
 * cancelled tests — and every downstream job (GitHub release, `:0.11.1`
 * image, desktop artifacts) was skipped as a result. The tag exists; nothing
 * was ever published.
 *
 * Both workflows now call ONE shared definition, `.github/actions/ensure-ripgrep`
 * (a local composite action — nothing here forbids one: CONTRIBUTING.md's
 * "third-party actions are pinned to full commit SHAs" governs actions
 * fetched from elsewhere, and a `uses: ./...` reference has no SHA to pin,
 * it resolves to whatever commit checked out the workflow itself), so the two
 * copies this file used to be cannot drift apart again the way they already
 * did once.
 *
 * THE INVARIANT THIS FILE HOLDS: every job, in every workflow, whose steps
 * invoke the server test suite must install ripgrep FIRST — via that action —
 * or be a documented exemption. Discovered by walking every
 * `.github/workflows/*.yml` file rather than naming a job, per
 * docs/false-safety-guards.md's "hardcoded list beside a growing set": a new
 * job added later that runs `npm test` in `packages/server` without the
 * ripgrep step must fail this file the moment it lands, not silently ship the
 * #8160 defect again under a different job name or a different invocation
 * spelling.
 *
 * THE ONE CURRENT EXEMPTION is real, not an oversight. `ci.yml`'s
 * `Server Windows Tests` job runs the derived Windows test set through
 * `scripts/run-windows-tests.mjs`, never `npm test`, and both rg-dependent
 * files already skip themselves on `process.platform === 'win32'` (see
 * `POSIX_ONLY` in grep-argv-injection.test.js and the describe-level `skip:`
 * in permission-floor-grep-glob.test.js) — the hard-fail-in-CI branch this
 * step exists for is never reached on that runner. `RIPGREP_EXEMPT` below
 * records that, the same way CONTRIBUTING.md's not-required table records a
 * PR-visible job that deliberately does not gate a merge
 * (ci-required-check-partition.test.js). The exemption also checks the job's
 * ACTUAL `runs-on:` — with any trailing comment stripped per line first, so a
 * comment cannot forge or deny it — not just its name (#8164 review, #8164
 * second review).
 *
 * PATTERN, deliberately followed rather than reinvented: this reads workflow
 * YAML through the shared hand-rolled reader in ./helpers/workflow-reader.js
 * (used by ci-required-check-partition.test.js and friends), not through
 * `js-yaml` directly. `js-yaml` IS already a server dependency and is used
 * directly in ci-main-push-concurrency.test.js for a much simpler question
 * (the workflow-level trigger set); the hand-rolled reader exists because a
 * `run:` step's SCRIPT BODY needs YAML-block-scalar-aware reading (`stepRun`)
 * that a generic YAML parse alone does not hand you shaped for shell analysis
 * — see that module's own docblock. Reusing it here means a fix to the reader
 * benefits this guard too, instead of this file drifting its own copy.
 */

const REAL = new URL('../../../.github/workflows/', import.meta.url)
const REAL_PATH = fileURLToPath(REAL)

const STEPS_KEY = valuelessKey('steps')
const DEFAULTS_KEY = valuelessKey('defaults')
const RUN_MAPPING_KEY = valuelessKey('run')

/**
 * A job's `defaults.run.working-directory`, or undefined.
 *
 * Mirrors `jobShell`'s `defaults:` -> `run:` -> KEY traversal in
 * helpers/workflow-reader.js exactly (same anchoring, same reason: a job-level
 * default is read from the keys BEFORE `steps:`, so a step's own `name:` or a
 * `working-directory:` mentioned only in prose can't be mistaken for it). Kept
 * local rather than folded into that shared, heavily-pinned module: this is
 * the one property only this file needs, and every other exported reader in
 * that module has its own dedicated case in ci-workflow-reader.test.js, which
 * a same-shaped addition there would also need.
 *
 * ci.yml's `server-tests` and `server-tests-windows` jobs both rely on this —
 * neither has `working-directory: packages/server` on its test-invoking step,
 * only on the job's `defaults:` block — so a checker that only read step-level
 * `working-directory` would never see either as scoped to packages/server.
 */
function jobDefaultWorkingDirectory(jobBody) {
  const stepsAt = jobBody.findIndex(l => STEPS_KEY.test(l))
  const lines = code(jobBody.slice(0, stepsAt === -1 ? jobBody.length : stepsAt))
  const defaultsAt = lines.findIndex(l => DEFAULTS_KEY.test(l))
  if (defaultsAt === -1) return undefined
  const defaultsIndent = /^(\s*)/.exec(lines[defaultsAt])[1].length

  let runIndent = null
  for (let i = defaultsAt + 1; i < lines.length; i++) {
    const indent = /^(\s*)/.exec(lines[i])[1].length
    if (indent <= defaultsIndent) break
    if (runIndent === null) {
      if (RUN_MAPPING_KEY.test(lines[i])) runIndent = indent
      continue
    }
    if (indent <= runIndent) break
    const m = /^\s*working-directory:\s*(.*)$/.exec(lines[i])
    if (m) return m[1].replace(/\s+#.*$/, '').trim()
  }
  return undefined
}

/**
 * A job's `runs-on:` value, with any trailing `# comment` stripped from EACH
 * contributing line BEFORE joining — not from the already-joined value
 * `workflow-reader.js`'s own `runsOnOf()` produces, which has lost the
 * per-line boundary by the time it returns (#8164 second review).
 *
 * That distinction is load-bearing, not cosmetic. A comment can contain the
 * very words an exemption regex tests for — "not windows-latest, this one's
 * still ubuntu" reads as a match for `windows-latest` to anything that scans
 * the raw joined text — and a fail-open exemption would then read PROSE as
 * CONFIGURATION, the same class of bug docs/false-safety-guards.md
 * catalogues for a comment quoting a guard's own matched strings. Stripping
 * per line, before the join, is what keeps a comment on one label from
 * bleeding into the next: `runsOnOf()`'s own join collapses newlines to
 * spaces, so stripping AFTER joining could not tell where one line's comment
 * ends and the next line's real content begins.
 *
 * Mirrors `runsOnOf()`'s traversal (same indent-based termination, same
 * blank/comment-line skip) so the two must always agree on WHICH lines
 * contribute — they differ only in whether a trailing comment survives on
 * each one. A block-sequence `runs-on:` still keeps every one of its labels;
 * only a `# ...` suffix on a line is removed, per the same whitespace-preceded
 * `#` rule `stepInput()` and `jobName()` already apply.
 */
function cleanRunsOn(jobBody) {
  const at = jobBody.findIndex(l => /^\s*runs-on:/.test(l))
  if (at === -1) return ''
  const keyIndent = /^(\s*)/.exec(jobBody[at])[1].length
  const strip = line => line.replace(/\s+#.*$/, '')
  const parts = [strip(jobBody[at])]
  for (let i = at + 1; i < jobBody.length; i++) {
    const line = jobBody[i]
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    if (/^(\s*)/.exec(line)[1].length <= keyIndent) break
    parts.push(strip(line))
  }
  return parts.join(' ')
}

/**
 * Fold every spelling of the SAME working directory to one canonical value,
 * so a discovery check can compare with `===` instead of re-deriving
 * equivalence at every call site.
 *
 *   - surrounding YAML quotes are cosmetic: `"./packages/server"` ==
 *     `./packages/server` (#8164 second review) — stripped FIRST, since a
 *     quoted value wraps the whole thing, before any of the folds below run
 *   - a trailing slash is cosmetic: `packages/server/` == `packages/server`
 *   - a leading `./` is cosmetic: `./packages/server` == `packages/server`
 *   - `${{ github.workspace }}` IS the repo root — GitHub's own docs define it
 *     that way, the same thing a bare `.` means — so
 *     `working-directory: ${{ github.workspace }}/packages/server` (at
 *     STEP level or job `defaults.run.working-directory`) resolves the same
 *     as `packages/server` (#8164 review: unhandled before this, so either
 *     spelling silently fell out of scope and the job was never discovered
 *     as running the server suite at all — not "discovered and wrongly
 *     exempted", just invisible)
 *   - `.` / `./` / empty all fold to the single value `.` (repo root)
 */
function normaliseWd(wd) {
  if (wd === undefined) return undefined
  let v = wd.trim()
  v = v.replace(/^(['"])(.*)\1$/, '$2')
  v = v.replace(/^\$\{\{\s*github\.workspace\s*\}\}\/?/, '')
  v = v.replace(/^\.\//, '')
  v = v.replace(/\/$/, '')
  return v === '.' || v === '' ? '.' : v
}

/**
 * A `run:` body invokes the bare `test` script — never a script name with a
 * CONTINUATION, such as `test:integration:k8s`, `test-e2e`, `tests`, or
 * `test.js` — under any of npm's real spellings: `test`, `tst`, `t`
 * (aliases of the plain test script), or `install-test`/`it`,
 * `install-ci-test`/`cit`/`sit`, `clean-install-test` (the install-then-test
 * family, which also always runs the `test` script). Arbitrary flags/values
 * are allowed on EITHER side of the script name (`npm test --prefix
 * packages/server`, `npm --prefix packages/server test`, `npm run test
 * --workspace=packages/server`, …) so flag position doesn't matter.
 *
 * `(?![\w:.-])` after the script name is the boundary that does the real
 * work, and it is NOT "whitespace or end of string" — that was the previous
 * (and the original) shape, and both regressed on anything that follows a
 * script name with a SHELL METACHARACTER rather than whitespace: `npm test;
 * rc=$?`, `npm test&& echo ok`, `npm test|tee log.txt`, `out=$(npm test)`,
 * `npm test>log`, and `bash -c "npm test"` all matched before either fix and
 * were silently missed by both `(?!:)` (the very first version) and `(?=\s|$)`
 * (the #8164 first-review widening) — none of `;`, `&`, `|`, `)`, `>`, or `"`
 * is whitespace or end-of-string, so a step whose script legitimately runs
 * `npm test` as part of a larger command line stopped being discovered
 * (#8164 second review). The fix is to name what must NOT follow — a script-
 * name continuation character (word char, `:`, `.`, or `-`) — rather than
 * what must: everything else, metacharacters included, is fair game.
 *
 * This repo's own workflows today only ever spell it `npm test`, scoped by a
 * step- or job-level `working-directory:` (grep-verified across every
 * `.github/workflows/*.yml`: none of the other spellings above invoke the
 * server suite yet). The wider forms exist so the NEXT job that spells it
 * differently is still caught, per docs/false-safety-guards.md's "hardcoded
 * list beside a growing set" — and each is proven below with its own
 * synthetic-input case (`serverTestInvocations recognizes every real
 * npm-test spelling`).
 *
 * The tradeoff this accepts, stated rather than assumed: allowing ARBITRARY
 * tokens between `npm` and the script name (rather than only a fixed
 * `(?:run\s+)?`) means a sufficiently contrived multi-line run body could, in
 * principle, contain an unrelated standalone `test` token after some other
 * `npm` invocation and be misread as a server-test invocation. That is the
 * SAFE direction for this guard to err in — a false positive here means
 * "install ripgrep before a step that may not have needed it," never a
 * silent miss of a step that does (docs/false-safety-guards.md's own
 * "over-inclusive is the safe direction" reasoning for exactly this
 * asymmetry).
 */
const NPM_TEST_RE = /\bnpm\b(?:\s+\S+)*?\s+(?:test|tst|t|it|install-test|cit|sit|clean-install-test|install-ci-test)(?![\w:.-])/

/**
 * The run body itself scopes the invocation to `packages/server` or
 * `@chroxy/server` (the workspace's own package name — the repo's root
 * `package.json` uses exactly this idiom for its own scripts), independent
 * of any `working-directory:`. Recognizes:
 *
 *   - `-w`, `--workspace`, or `--prefix` naming either spelling, in the
 *     `=value` or ` value` form, optionally quoted and optionally prefixed
 *     with `./` or `${{ github.workspace }}/`
 *   - `-C` naming `packages/server` (a directory-change flag some npm-like
 *     tooling accepts the same way `--prefix` does)
 *   - `-ws` / `--workspaces` (ALL workspaces, server included)
 *   - `cd packages/server` / `cd ./packages/server` earlier in the same run
 *     body, optionally quoted
 *
 * The PREVIOUS pattern (`(?:-w|--workspace=?)\s+packages\/server\b`) required
 * whitespace even for the `=` spelling, so `--workspace=packages/server`
 * never matched despite the comment above it claiming it did (#8164 review —
 * the bug was in the comment's claim, not in anything the old code was asked
 * to prove: nothing exercised that spelling before then). `(?:=|\s+)` treats
 * `=` and whitespace as the two real separators npm accepts, never requiring
 * both at once.
 *
 * `(?![\w.-])` after each package spelling excludes a NAME CONTINUATION —
 * `packages/server-foo` and `@chroxy/server-x` are real, different packages,
 * not the server package with noise after it, and must not match (proven
 * below as a control).
 */
const SCOPE_SERVER_RE =
  /(?:-w|--workspace|--prefix|-C)(?:=|\s+)['"]?(?:\.\/|\$\{\{\s*github\.workspace\s*\}\}\/)?(?:packages\/server|@chroxy\/server)(?![\w.-])|(?:^|\s)(?:-ws|--workspaces)(?![\w-])|\bcd\s+['"]?(?:\.\/)?packages\/server(?![\w.-])/

/**
 * The Windows-only derived test runner (#7270) — `ci.yml`'s
 * `server-tests-windows` job invokes this instead of `npm test` directly, and
 * it still runs the whole `packages/server/tests/**\/*.test.js` set (minus
 * `WINDOWS_EXEMPT`), so it is a server-test invocation by this file's
 * definition even though it does not match `NPM_TEST_RE`.
 */
const WINDOWS_RUNNER_RE = /run-windows-tests\.mjs/

/**
 * Every job, across every workflow, with a step that invokes the server test
 * suite — as `{workflow, job, kind, runsOn, hasRipgrepBefore}`.
 *
 * `hasRipgrepBefore` is resolved HERE, in the same pass, because it needs the
 * job's own step list at the exact index the invocation was found at — a
 * second consumer re-deriving it from just a job name would be exactly the
 * copy this repo's doctrine warns against. `runsOn` is `cleanRunsOn(job.body)`
 * — comment-stripped per line — so an exemption can be checked against the
 * job's ACTUAL runner, never a comment about it (#8164 review, #8164 second
 * review) — see `RIPGREP_EXEMPT`.
 */
export function serverTestInvocations(workflows) {
  const found = []
  for (const w of workflows) {
    for (const job of w.jobs) {
      const defaultWd = normaliseWd(jobDefaultWorkingDirectory(job.body))
      const runsOn = cleanRunsOn(job.body)
      job.steps.forEach((stepLines, stepIndex) => {
        const runBody = stepRun(stepLines)
        if (runBody === undefined) return

        const hasRipgrepBefore = job.steps
          .slice(0, stepIndex)
          .some(prior => (stepInput(prior, 'uses') || '').startsWith('./.github/actions/ensure-ripgrep'))

        if (WINDOWS_RUNNER_RE.test(runBody)) {
          found.push({ workflow: w.name, job: jobName(job), kind: 'windows-derived-runner', runsOn, hasRipgrepBefore })
          return
        }

        if (!NPM_TEST_RE.test(runBody)) return
        const stepWd = normaliseWd(stepInput(stepLines, 'working-directory'))
        const effectiveWd = stepWd !== undefined ? stepWd : defaultWd
        const scoped = effectiveWd === 'packages/server' || SCOPE_SERVER_RE.test(runBody)
        if (scoped) found.push({ workflow: w.name, job: jobName(job), kind: 'npm-test', runsOn, hasRipgrepBefore })
      })
    }
  }
  return found
}

/**
 * Documented exemptions: a `{workflow, job, runsOn, reason}` row allowed to
 * run the server test suite without `ensure-ripgrep` before it. Anything
 * discovered that is neither ripgrep-first NOR matched by a row here is a gap
 * (#8160 all over again, just with a new job name).
 *
 * `runsOn` is a REQUIRED `RegExp` alongside `{workflow, job}`, not an
 * optional refinement (#8164 review) — `ripgrepGaps` refuses to exempt
 * anything for a row that omits it (#8164 second review: a missing `runsOn`
 * used to fall back to "match on name alone", which is the exact loophole
 * this field exists to close, just moved one level down into the fallback
 * path instead of removed). ci.yml's real Windows job routes its runner
 * through `runner-target`'s `winrunner` OUTPUT (`runs-on: ${{
 * fromJSON(needs.runner-target.outputs.winrunner) }}`), which resolves at RUN
 * TIME to either `["self-hosted","Windows","X64","chroxy-win"]` or
 * `"windows-latest"` (see ci.yml's `resolve` step) — a static YAML read
 * cannot evaluate that expression, so this matches the literal `winrunner`
 * reference instead (grep-verified: it is the only job in ci.yml whose
 * `runs-on:` mentions it), with the literal `windows-latest` / `chroxy-win`
 * spellings also accepted for a future Windows job that skips the routing
 * indirection. Matched against `cleanRunsOn()`'s comment-stripped value, so a
 * comment claiming (or denying) Windows cannot forge — or defeat — the match.
 */
export const RIPGREP_EXEMPT = [
  {
    workflow: 'ci.yml',
    job: 'Server Windows Tests',
    runsOn: /winrunner|windows-latest|chroxy-win|\bWindows\b/,
    reason:
      'runs the derived Windows test set via scripts/run-windows-tests.mjs, not `npm test`; both ' +
      'rg-dependent files self-skip on win32 (POSIX_ONLY in grep-argv-injection.test.js, the ' +
      'describe-level skip in permission-floor-grep-glob.test.js), so the hard-fail-in-CI path ' +
      'this step exists for is never reached there.',
  },
]

/**
 * The whole rule, as a pure function over the discovered invocations — proven
 * to REPORT on synthetic input below, the same move
 * ci-required-check-partition.test.js's `partitionGaps` makes and for the same
 * reason: on the real tree this returns empty, and empty-because-broken must
 * not read the same as empty-because-clean.
 *
 * `exemptOf` is FAIL-CLOSED on `runsOn`: `e.runsOn instanceof RegExp &&
 * e.runsOn.test(...)`, not `!e.runsOn || ...` (#8164 second review). The old
 * form treated a row with NO `runsOn` as exempting on `{workflow, job}` name
 * alone — which is precisely the loophole item 4 of the first review closed
 * for the row that HAS one, reopened for any row that doesn't. There is no
 * longer a way to write an exemption that skips the runner check.
 */
export function ripgrepGaps(invocations, exempt = RIPGREP_EXEMPT) {
  const exemptOf = inv =>
    exempt.find(
      e => e.workflow === inv.workflow && e.job === inv.job && e.runsOn instanceof RegExp && e.runsOn.test(inv.runsOn || '')
    )
  return {
    // A discovered job with no ripgrep step before it and no exemption row.
    missing: invocations.filter(i => !i.hasRipgrepBefore && !exemptOf(i)).map(i => `${i.job} (${i.workflow})`),
    // An exempt row naming a job this pass never discovered — a stale
    // exemption (job renamed/removed, or it started carrying the step anyway)
    // that reads as a considered decision when it no longer is one.
    staleExemptions: exempt
      .filter(e => !invocations.some(i => i.workflow === e.workflow && i.job === e.job))
      .map(e => `${e.job} (${e.workflow})`),
  }
}

describe('every workflow job that runs the server test suite installs ripgrep first (#8160)', () => {
  let workflows
  let invocations

  before(async () => {
    workflows = await readWorkflows()
    // Shared positive control: a broken reader finds nothing, and nothing
    // below is checking anything real.
    assertReaderSane(workflows)
    invocations = serverTestInvocations(workflows)
  })

  // ---- positive controls on the derived subject ----

  it('finds server-test-running jobs in both ci.yml and release.yml — otherwise this guard checks nothing', () => {
    // Loose floor, like assertReaderSane's own: today there are exactly three
    // (ci.yml Server Tests, ci.yml Server Windows Tests, release.yml Test
    // Suite). >=2 catches a reader or a regex that has stopped matching
    // anything without pinning today's count as an invariant.
    assert.ok(
      invocations.length >= 2,
      `expected >=2 server-test-running jobs across all workflows, found ${invocations.length} ` +
        '(the discovery regex is probably broken)'
    )
    assert.ok(
      // NOT satisfiable by the exempt Windows job alone (#8164 review) — a
      // reader that only ever found the exempt row would pass the floor
      // above yet check nothing that actually gates anything.
      invocations.some(i => i.workflow === 'ci.yml' && !RIPGREP_EXEMPT.some(e => e.workflow === i.workflow && e.job === i.job)),
      'expected at least one NON-exempt server-test-running job in ci.yml (e.g. Server Tests) — ' +
        'the Windows exemption alone must not satisfy this floor'
    )
    assert.ok(
      invocations.some(i => i.workflow === 'release.yml'),
      'expected at least one server-test-running job in release.yml — the #8160 job itself'
    )
  })

  it('discovers exactly the three real server-test-running jobs — no more, no less (#8164 second review)', () => {
    // The PRECISE version of the floor above: the widened NPM_TEST_RE and
    // SCOPE_SERVER_RE must not have picked up anything ELSE in the real tree
    // (a lint step mentioning "test" in prose, a differently-scoped `npm
    // test` elsewhere, …). If this ever needs to change, it should change on
    // PURPOSE, in the same PR that adds or removes a real job.
    const discovered = invocations.map(i => `${i.job} (${i.workflow})`).sort()
    assert.deepEqual(discovered, ['Server Tests (ci.yml)', 'Server Windows Tests (ci.yml)', 'Test Suite (release.yml)'])
  })

  it('excludes the k8s integration job, which runs a single unrelated file, not the server suite', () => {
    assert.ok(
      !invocations.some(i => i.workflow === 'nightly-k8s-integration.yml'),
      'nightly-k8s-integration.yml runs only tests/integration/k8s-sidecar-roundtrip.test.js via ' +
        'test:integration:k8s, never the ./tests/**/*.test.js glob — it must not be discovered as ' +
        'a server-test-running job'
    )
  })

  // ---- the rule, on the real tree ----

  it('every discovered job installs ripgrep first, or is a documented exemption', () => {
    assert.deepEqual(
      ripgrepGaps(invocations).missing,
      [],
      'these jobs run the server test suite but have no ensure-ripgrep step before it, so the ' +
        '#7295 execution proof and the #7978 oracle will hard-fail in CI (#8160) — add ' +
        '`uses: ./.github/actions/ensure-ripgrep` before the test step, or add a reasoned row to ' +
        'RIPGREP_EXEMPT'
    )
  })

  it('every documented exemption still names a job this pass actually discovers', () => {
    assert.deepEqual(ripgrepGaps(invocations).staleExemptions, [])
  })
})

/**
 * Each branch of `ripgrepGaps` proven to REPORT, on synthetic input — decoupled
 * from YAML parsing entirely, the same split ci-required-check-partition.test.js
 * uses for `partitionGaps`.
 */
describe('ripgrepGaps reports each defect it exists to find (#8160)', () => {
  it('CONTROL: ripgrep-first + a documented exemption reports nothing', () => {
    const invocations = [
      { workflow: 'ci.yml', job: 'Server Tests', kind: 'npm-test', hasRipgrepBefore: true },
      {
        workflow: 'ci.yml',
        job: 'Server Windows Tests',
        kind: 'windows-derived-runner',
        runsOn: 'runs-on: ${{ fromJSON(needs.runner-target.outputs.winrunner) }}',
        hasRipgrepBefore: false,
      },
    ]
    const exempt = [{ workflow: 'ci.yml', job: 'Server Windows Tests', runsOn: /winrunner/, reason: 'test fixture' }]
    assert.deepEqual(ripgrepGaps(invocations, exempt), { missing: [], staleExemptions: [] })
  })

  it('reports a job with no ripgrep step and no exemption, naming its workflow', () => {
    const invocations = [{ workflow: 'release.yml', job: 'Test Suite', kind: 'npm-test', hasRipgrepBefore: false }]
    assert.deepEqual(ripgrepGaps(invocations, []).missing, ['Test Suite (release.yml)'])
  })

  it('does not report a job with the step even absent an exemption row', () => {
    const invocations = [{ workflow: 'release.yml', job: 'Test Suite', kind: 'npm-test', hasRipgrepBefore: true }]
    assert.deepEqual(ripgrepGaps(invocations, []).missing, [])
  })

  it('reports a stale exemption naming a job that was never discovered', () => {
    const exempt = [{ workflow: 'ci.yml', job: 'Renamed Away', reason: 'x' }]
    assert.deepEqual(ripgrepGaps([], exempt).staleExemptions, ['Renamed Away (ci.yml)'])
  })

  it('does NOT let an exemption row WITHOUT a runsOn pattern exempt anything (#8164 second review)', () => {
    // The fail-closed proof: a row naming the right {workflow, job} but no
    // `runsOn` at all must not exempt — the old `!e.runsOn ||` fallback would
    // have let this through.
    const invocations = [{ workflow: 'ci.yml', job: 'Server Windows Tests', kind: 'npm-test', runsOn: 'runs-on: windows-latest', hasRipgrepBefore: false }]
    const exempt = [{ workflow: 'ci.yml', job: 'Server Windows Tests', reason: 'no runsOn on this row' }]
    assert.deepEqual(ripgrepGaps(invocations, exempt).missing, ['Server Windows Tests (ci.yml)'])
  })

  it('does NOT let a same-named job on a different runner inherit the REAL Windows exemption (#8164 review, #8164 second review)', () => {
    // The exact shape of the loophole item 4 (first review) named: a job
    // sharing the exempt row's {workflow, job} but actually running on Linux
    // must still be reported, not waved through on name alone. Uses the REAL
    // RIPGREP_EXEMPT (the default parameter), not a local stand-in, so this
    // proves the PRODUCTION row's own runsOn guard holds (#8164 second
    // review) — a local copy could pass while the real row regressed.
    const invocations = [
      {
        workflow: 'ci.yml',
        job: 'Server Windows Tests',
        kind: 'npm-test',
        runsOn: 'runs-on: ubuntu-24.04',
        hasRipgrepBefore: false,
      },
    ]
    assert.deepEqual(ripgrepGaps(invocations).missing, ['Server Windows Tests (ci.yml)'])
  })

  it('a runs-on COMMENT mentioning Windows does not satisfy the REAL exemption (#8164 second review)', () => {
    // cleanRunsOn() strips the comment before this ever reaches ripgrepGaps,
    // so a job named exactly like the exempt row, genuinely running on
    // ubuntu with a comment that happens to say "windows", is still reported.
    const yml =
      'name: probe\n' +
      'on: push\n' +
      'jobs:\n' +
      '  probe:\n' +
      '    name: Server Windows Tests\n' +
      '    runs-on: ubuntu-24.04 # not windows, despite the job name\n' +
      '    steps:\n' +
      '      - uses: actions/checkout@v4\n' +
      '      - name: Test server\n' +
      '        run: npm test\n' +
      '        working-directory: packages/server\n'
    const workflow = { name: 'ci.yml', text: yml, jobs: parseJobs(yml, 'ci.yml') }
    const invocations = serverTestInvocations([workflow])
    assert.deepEqual(ripgrepGaps(invocations).missing, ['Server Windows Tests (ci.yml)'])
  })
})

/**
 * `serverTestInvocations` proven against every real npm-test spelling the
 * #8164 review (both passes) named, decoupled from the real workflow tree
 * via a small synthetic single-job workflow per case (built with the SAME
 * `parseJobs` the real reader uses, so this exercises the actual parsing
 * path, not a hand-rolled stand-in for it).
 */
describe('serverTestInvocations recognizes every real npm-test spelling (#8164 review)', () => {
  /**
   * A minimal single-job workflow around one test-invoking step, with or
   * without the ensure-ripgrep step immediately before it and with or without
   * a job- or step-level working directory. Returns the discovered
   * invocations for that one synthetic workflow.
   */
  function probe(runCommand, { workingDirectory, jobDefaultWd, withRipgrep = false } = {}) {
    const defaultsBlock = jobDefaultWd
      ? `    defaults:\n      run:\n        working-directory: ${jobDefaultWd}\n`
      : ''
    const wdLine = workingDirectory ? `        working-directory: ${workingDirectory}\n` : ''
    const ripgrepStep = withRipgrep
      ? '      - name: "Ensure ripgrep is installed"\n        uses: ./.github/actions/ensure-ripgrep\n'
      : ''
    const yml =
      'name: probe\n' +
      'on: push\n' +
      'jobs:\n' +
      '  probe:\n' +
      '    name: Probe Job\n' +
      '    runs-on: ubuntu-latest\n' +
      defaultsBlock +
      '    steps:\n' +
      '      - uses: actions/checkout@v4\n' +
      ripgrepStep +
      '      - name: Test server\n' +
      `        run: ${runCommand}\n` +
      wdLine
    const workflow = { name: 'probe.yml', text: yml, jobs: parseJobs(yml, 'probe.yml') }
    return serverTestInvocations([workflow])
  }

  // ---- bare `test`/`t` script, scoped by a working-directory ----

  for (const cmd of ['npm test', 'npm run test', 'npm t']) {
    it(`recognizes \`${cmd}\` scoped by a step-level working-directory, and goes red without ensure-ripgrep`, () => {
      const missing = ripgrepGaps(probe(cmd, { workingDirectory: 'packages/server' })).missing
      assert.deepEqual(missing, ['Probe Job (probe.yml)'])
      const clean = ripgrepGaps(probe(cmd, { workingDirectory: 'packages/server', withRipgrep: true })).missing
      assert.deepEqual(clean, [])
    })
  }

  // ---- metacharacter-adjacent and alias spellings (#8164 second review) ----

  for (const cmd of [
    'npm tst',
    'npm test; rc=$?',
    'npm test|tee log.txt',
    'npm test&& echo ok',
    'out=$(npm test)',
    'npm cit',
    'npm it',
  ]) {
    it(`recognizes \`${cmd}\` scoped by a step-level working-directory, and goes red without ensure-ripgrep (#8164 second review)`, () => {
      const missing = ripgrepGaps(probe(cmd, { workingDirectory: 'packages/server' })).missing
      assert.deepEqual(missing, ['Probe Job (probe.yml)'])
      const clean = ripgrepGaps(probe(cmd, { workingDirectory: 'packages/server', withRipgrep: true })).missing
      assert.deepEqual(clean, [])
    })
  }

  it('excludes script-name CONTINUATIONS: test-e2e, tests, and test.js are not the bare test script (#8164 second review)', () => {
    for (const cmd of ['npm test-e2e', 'npm tests', 'npm test.js']) {
      const missing = ripgrepGaps(probe(cmd, { workingDirectory: 'packages/server' })).missing
      assert.deepEqual(missing, [], `\`${cmd}\` must not be discovered as the bare test script`)
    }
  })

  // ---- the script itself carries the scope ----

  for (const cmd of [
    'npm test -w packages/server',
    'npm test --workspace packages/server',
    'npm test --workspace=packages/server',
    'npm test -w=packages/server',
    'npm run test --workspace=packages/server',
    'npm test --prefix packages/server',
    'npm --prefix packages/server test',
    'npm test -w @chroxy/server',
    'npm test -C packages/server',
    'npm test --workspaces',
    'npm test -ws',
    'cd packages/server && npm test',
    'cd ./packages/server && npm test',
  ]) {
    it(`recognizes \`${cmd}\`, scoped by the command itself, and goes red without ensure-ripgrep`, () => {
      const missing = ripgrepGaps(probe(cmd)).missing
      assert.deepEqual(missing, ['Probe Job (probe.yml)'])
      const clean = ripgrepGaps(probe(cmd, { withRipgrep: true })).missing
      assert.deepEqual(clean, [])
    })
  }

  it('does NOT scope on a DIFFERENT package that merely starts with the same name (#8164 second review)', () => {
    for (const cmd of ['npm test -w packages/server-foo', 'npm test -w @chroxy/server-x']) {
      const missing = ripgrepGaps(probe(cmd)).missing
      assert.deepEqual(missing, [], `\`${cmd}\` scopes a DIFFERENT package and must not be discovered`)
    }
  })

  // ---- working-directory spellings that must resolve to packages/server ----

  it('resolves a step-level `./packages/server` working-directory, and goes red without ensure-ripgrep', () => {
    const missing = ripgrepGaps(probe('npm test', { workingDirectory: './packages/server' })).missing
    assert.deepEqual(missing, ['Probe Job (probe.yml)'])
    const clean = ripgrepGaps(probe('npm test', { workingDirectory: './packages/server', withRipgrep: true })).missing
    assert.deepEqual(clean, [])
  })

  it('resolves a step-level `${{ github.workspace }}/packages/server` working-directory, and goes red without ensure-ripgrep', () => {
    const wd = '${{ github.workspace }}/packages/server'
    const missing = ripgrepGaps(probe('npm test', { workingDirectory: wd })).missing
    assert.deepEqual(missing, ['Probe Job (probe.yml)'])
    const clean = ripgrepGaps(probe('npm test', { workingDirectory: wd, withRipgrep: true })).missing
    assert.deepEqual(clean, [])
  })

  it('resolves a job-default `./packages/server` working-directory, and goes red without ensure-ripgrep', () => {
    const missing = ripgrepGaps(probe('npm test', { jobDefaultWd: './packages/server' })).missing
    assert.deepEqual(missing, ['Probe Job (probe.yml)'])
    const clean = ripgrepGaps(probe('npm test', { jobDefaultWd: './packages/server', withRipgrep: true })).missing
    assert.deepEqual(clean, [])
  })

  it('resolves a job-default `${{ github.workspace }}/packages/server` working-directory, and goes red without ensure-ripgrep', () => {
    const wd = '${{ github.workspace }}/packages/server'
    const missing = ripgrepGaps(probe('npm test', { jobDefaultWd: wd })).missing
    assert.deepEqual(missing, ['Probe Job (probe.yml)'])
    const clean = ripgrepGaps(probe('npm test', { jobDefaultWd: wd, withRipgrep: true })).missing
    assert.deepEqual(clean, [])
  })

  it('resolves a QUOTED job-default `"./packages/server"` working-directory, and goes red without ensure-ripgrep (#8164 second review)', () => {
    const wd = '"./packages/server"'
    const missing = ripgrepGaps(probe('npm test', { jobDefaultWd: wd })).missing
    assert.deepEqual(missing, ['Probe Job (probe.yml)'])
    const clean = ripgrepGaps(probe('npm test', { jobDefaultWd: wd, withRipgrep: true })).missing
    assert.deepEqual(clean, [])
  })

  it('still excludes a scoped script name even with the widened command regex', () => {
    // The regression this whole widening could have reintroduced: allowing
    // arbitrary tokens between `npm` and the script name must not let
    // `test:integration:k8s` slip through the continuation-character boundary.
    const missing = ripgrepGaps(probe('npm run test:integration:k8s -w packages/server')).missing
    assert.deepEqual(missing, [])
  })
})

/**
 * The WIRING, proven against mutated COPIES of the real workflow tree — never
 * the real files. Proves this file actually goes red the way #8160's
 * acceptance criteria demand: delete the ensure-ripgrep step from release.yml,
 * or from ci.yml, and `missing` reports the job.
 */
describe('the rule reads the real workflow tree, and goes red when the step is removed (#8160)', () => {
  const dirs = []
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  /** A copy of the real workflows with `[find, replace]` applied to one file. */
  async function mutated(file, pairs) {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-ripgrep-'))
    dirs.push(dir)
    cpSync(REAL_PATH, dir, { recursive: true })
    const target = join(dir, file)
    let text = readFileSync(target, 'utf8')
    for (const [find, replace] of pairs) {
      const occurrences = text.split(find).length - 1
      // Collapsed to a boolean before asserting (CLAUDE.md #7340): comparing
      // full-file text puts the whole ~KB payload into the AssertionError.
      assert.ok(
        occurrences === 1,
        `the mutation did not land: ${file} contains ${occurrences} occurrences of ` +
          `${JSON.stringify(find.slice(0, 90))}, expected exactly 1`
      )
      text = text.replace(find, replace)
    }
    writeFileSync(target, text)
    return readWorkflows(pathToFileURL(`${dir}/`))
  }

  it('CONTROL: an unmutated copy discovers real jobs and reports no gaps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-ripgrep-'))
    dirs.push(dir)
    cpSync(REAL_PATH, dir, { recursive: true })
    const invocations = serverTestInvocations(await readWorkflows(pathToFileURL(`${dir}/`)))
    // A broken copy-read path (wrong dir, empty read) would satisfy `missing
    // === []` vacuously — the same "quantifier over an empty set" failure
    // ci-required-check-partition.test.js's own positive controls guard
    // against (#8164 review).
    assert.ok(
      invocations.length >= 1,
      'the copy-read path discovered zero server-test jobs — the read is probably broken, not the tree clean'
    )
    assert.deepEqual(ripgrepGaps(invocations).missing, [])
  })

  it('removing the ensure-ripgrep step from release.yml is reported', async () => {
    const wf = await mutated('release.yml', [
      [
        '      - name: "Ensure ripgrep is installed (required by the #7295 execution proof)"\n' +
          '        uses: ./.github/actions/ensure-ripgrep\n\n',
        '',
      ],
    ])
    const invocations = serverTestInvocations(wf)
    assert.deepEqual(ripgrepGaps(invocations).missing, ['Test Suite (release.yml)'])
  })

  it('removing the ensure-ripgrep step from ci.yml is reported', async () => {
    const wf = await mutated('ci.yml', [
      [
        '      - name: "Ensure ripgrep is installed (required by the #7295 execution proof)"\n' +
          '        uses: ./.github/actions/ensure-ripgrep\n\n',
        '',
      ],
    ])
    const invocations = serverTestInvocations(wf)
    assert.deepEqual(ripgrepGaps(invocations).missing, ['Server Tests (ci.yml)'])
  })
})
