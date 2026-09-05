import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { readWorkflows, assertReaderSane, jobName, workflowTriggers } from './helpers/workflow-reader.js'
import { parseRoster, parseExemptions } from '../../../scripts/lib/contributing-roster.mjs'

/**
 * #7639 — the required-check roster is only half a record, and the other half
 * did not exist.
 *
 * `contributing-required-checks.test.js` (#7448) asserts ONE direction: every
 * name in CONTRIBUTING.md's roster is a real ci.yml job. That catches a renamed
 * or deleted job — a context nothing will ever produce again. It cannot catch
 * the opposite, and the opposite is what keeps happening: a job is ADDED,
 * nobody decides whether it should gate, and it runs forever as an advisory
 * check whose red and whose green are the same observable outcome at the merge
 * button.
 *
 * That is not hypothetical. It has been filed four separate times, once per
 * job, by four different reviews: #7199 (`Release PR Subject`), #7216
 * (`Renovate Config`), #7544 and #7639 (`Scripts Tests`). Four issues reporting
 * one defect is the signature of a missing invariant, not of four mistakes —
 * the first cause in docs/false-safety-guards.md, a hand-maintained list beside
 * a growing set.
 *
 * THE INVARIANT. Every job in a workflow that triggers on `pull_request`
 * produces a check-run context on every PR, so every one of them is either a
 * merge gate or deliberately not one. The roster and the not-required table
 * must PARTITION that set: together they cover it, and they do not overlap. A
 * job added to any workflow fails this file until someone writes a row for it.
 *
 * WHY THE SUBJECT IS "TRIGGERS ON pull_request" AND NOT "IS IN ci.yml".
 * `repo-relay.yml` also runs on `pull_request` and contributes the `notify`
 * context; a subject scoped to one file would silently exclude it — the
 * one-directory-wide mistake #7637 made. Derived, not listed: `readWorkflows()`
 * discovers files with `readdir`, so a new PR-triggered workflow is in scope
 * the moment it lands. Measured against reality rather than assumed: on PR
 * #7638's head, GitHub reported exactly 23 check runs, and this derivation
 * yields exactly those 23 contexts.
 *
 * A SKIPPED JOB IS STILL IN SCOPE, on purpose. Branch protection treats a
 * skipped required check as satisfied (#7216 established this, and it is why
 * `Desktop Rust Tests` can be both required and fork-conditional), so a
 * conditional job is a perfectly ordinary gate. Excluding jobs by their `if:`
 * would exempt exactly the ones whose conditions are hardest to reason about.
 *
 * WHAT THIS FILE CANNOT DO is read live branch protection — CI's GITHUB_TOKEN
 * has no repo-admin scope, and pretending otherwise would be the
 * cannot-check-treated-as-nothing-to-check failure. This guard proves the two
 * WRITTEN lists partition the real jobs; `scripts/check-required-contexts.sh`
 * proves the roster matches what is live. Neither substitutes for the other.
 */

/**
 * Floors, loose on purpose. Their job is to catch a reader or a parse that has
 * stopped working — which yields zero, over which every rule below passes
 * vacuously — not to pin today's numbers. The exact roster count lives in
 * contributing-required-checks.test.js, where the count IS the subject.
 */
const MIN_PR_JOBS = 15
const MIN_PR_WORKFLOWS = 2

/**
 * The whole rule, as a pure function over three name lists.
 *
 * Extracted rather than inlined so each branch can be proven to REPORT on a
 * synthetic input. The real tree is (and should stay) a clean partition, so on
 * the real tree every one of these returns empty — and a rule that returns
 * empty because it is broken is indistinguishable from one that returns empty
 * because the tree is clean. That is the whole defect class this file belongs
 * to, so the controls below are not optional decoration.
 *
 * `basenameCollisions()` in ci-scripts-tests-registration.test.js is the same
 * move for the same reason.
 */
export function partitionGaps({ prJobs, roster, exempt }) {
  const classified = new Set([...roster, ...exempt])
  const jobNames = new Set(prJobs.map(j => j.name))
  return {
    // A PR-visible job nobody has classified — the #7199/#7216/#7544/#7639 shape.
    unclassified: prJobs.filter(j => !classified.has(j.name)).map(j => `${j.name} (${j.workflow})`),
    // A not-required row naming a context no workflow produces — a stale row
    // that reads as a considered decision (#7191 family).
    phantoms: exempt.filter(n => !jobNames.has(n)),
    // A name in both lists: the record contradicts itself about whether it gates.
    both: roster.filter(n => exempt.includes(n)),
    // Duplicate rows, in either list.
    dupes: [...roster, ...exempt].filter((n, i, a) => a.indexOf(n) !== i),
    // Two jobs sharing one context, so one cannot be classified separately.
    collidingJobs: prJobs.map(j => j.name).filter((n, i, a) => a.indexOf(n) !== i),
  }
}

/** Every PR-visible job as `{name, workflow}`, from already-read workflows. */
export function prVisibleJobs(workflows) {
  return workflows
    .filter(w => workflowTriggers(w.text).includes('pull_request'))
    .flatMap(w => w.jobs.map(j => ({ name: jobName(j), workflow: w.name })))
}

const REAL = new URL('../../../.github/workflows/', import.meta.url)
const CONTRIBUTING = new URL('../../../CONTRIBUTING.md', import.meta.url)

describe('required-check roster partitions the PR-visible jobs (#7639)', () => {
  let prJobs
  let roster
  let exempt
  let prWorkflows

  before(async () => {
    const workflows = await readWorkflows()
    // Shared positive control: a broken reader finds nothing, and nothing
    // satisfies every rule in this file.
    assertReaderSane(workflows)

    prWorkflows = workflows.filter(w => workflowTriggers(w.text).includes('pull_request'))
    prJobs = prVisibleJobs(workflows)

    const contributing = await readFile(CONTRIBUTING, 'utf8')
    // Both parsers throw rather than return a partial or empty list, so a
    // mangled CONTRIBUTING.md fails this hook instead of emptying the subject.
    roster = parseRoster(contributing)
    exempt = parseExemptions(contributing)
  })

  // ---- positive controls on the derived subject ----

  it('finds enough PR-triggered workflows and jobs to be checking anything', () => {
    assert.ok(
      prWorkflows.length >= MIN_PR_WORKFLOWS,
      `expected >=${MIN_PR_WORKFLOWS} workflows triggered by pull_request, found ${prWorkflows.length} ` +
        `(${prWorkflows.map(w => w.name).join(', ') || 'none'}) — the trigger reader is probably broken`
    )
    assert.ok(
      prJobs.length >= MIN_PR_JOBS,
      `expected >=${MIN_PR_JOBS} PR-visible jobs, found ${prJobs.length} — the job reader is probably broken`
    )
    assert.ok(roster.length > 0 && exempt.length > 0, 'both CONTRIBUTING.md lists must be non-empty')
  })

  it('keeps repo-relay.yml in scope, not just ci.yml', () => {
    // The specific regression this subject definition exists to prevent: a
    // guard scoped to one file. `notify` is the only context from another
    // workflow today, so it is the canary for the whole widening.
    assert.ok(
      prWorkflows.some(w => w.name === 'ci.yml'),
      'expected ci.yml among the pull_request-triggered workflows'
    )
    assert.ok(
      prJobs.some(j => j.workflow === 'repo-relay.yml'),
      'expected at least one PR-visible job from repo-relay.yml — the subject has narrowed to ci.yml'
    )
  })

  it('excludes workflows that cannot run on a pull request', () => {
    // The other direction of the subject: a nightly or tag-only workflow
    // produces no PR context, so demanding a row for its jobs would push the
    // table toward noise and train people to add rows without deciding.
    const names = prWorkflows.map(w => w.name)
    for (const off of ['maestro-nightly.yml', 'release.yml', 'stale.yml']) {
      assert.ok(!names.includes(off), `${off} does not run on pull_request and must not be in scope`)
    }
  })

  // ---- the rule, on the real tree ----

  it('classifies every PR-visible job as required or deliberately not required', () => {
    assert.deepEqual(
      partitionGaps({ prJobs, roster, exempt }).unclassified,
      [],
      'these jobs run on every PR but are in neither CONTRIBUTING.md list, so nobody has decided ' +
        'whether they gate a merge — add each to the required roster or to the not-required table ' +
        'with a reason (#7639)'
    )
  })

  it('lists nothing in the not-required table that is not a PR-visible job', () => {
    assert.deepEqual(partitionGaps({ prJobs, roster, exempt }).phantoms, [])
  })

  it('does not list the same check as both required and not required', () => {
    assert.deepEqual(partitionGaps({ prJobs, roster, exempt }).both, [])
  })

  it('lists no duplicate rows in either list', () => {
    assert.deepEqual(partitionGaps({ prJobs, roster, exempt }).dupes, [])
  })

  it('gives every PR-visible job a distinct check context', () => {
    assert.deepEqual(partitionGaps({ prJobs, roster, exempt }).collidingJobs, [])
  })

  it('accounts for every PR-visible job and nothing else', () => {
    // Implied by the rules above, and asserted directly because it is the one
    // statement a reader of a failure message can check by counting.
    assert.equal(
      roster.length + exempt.length,
      prJobs.length,
      `roster (${roster.length}) + not-required (${exempt.length}) should equal the ` +
        `${prJobs.length} PR-visible check contexts`
    )
  })
})

/**
 * Each branch of `partitionGaps` proven to REPORT.
 *
 * On the real tree every branch returns empty, so without these a deleted
 * branch — or one that can only ever return empty — is invisible. #7273 is the
 * inverse and equally fatal: a check that denies everything, whose negative
 * tests all pass for the wrong reason. Both directions are covered here.
 */
describe('partitionGaps reports each defect it exists to find (#7639)', () => {
  const JOBS = [
    { name: 'Server Tests', workflow: 'ci.yml' },
    { name: 'notify', workflow: 'repo-relay.yml' },
  ]

  it('CONTROL: a clean partition reports nothing, so the rule is not deny-everything', () => {
    const gaps = partitionGaps({ prJobs: JOBS, roster: ['Server Tests'], exempt: ['notify'] })
    assert.deepEqual(gaps, {
      unclassified: [],
      phantoms: [],
      both: [],
      dupes: [],
      collidingJobs: [],
    })
  })

  it('reports a job in neither list, naming its workflow', () => {
    const gaps = partitionGaps({
      prJobs: [...JOBS, { name: 'Brand New Job', workflow: 'ci.yml' }],
      roster: ['Server Tests'],
      exempt: ['notify'],
    })
    assert.deepEqual(gaps.unclassified, ['Brand New Job (ci.yml)'])
  })

  it('reports a not-required row that names no real job', () => {
    const gaps = partitionGaps({ prJobs: JOBS, roster: ['Server Tests'], exempt: ['notify', 'Renamed Away'] })
    assert.deepEqual(gaps.phantoms, ['Renamed Away'])
  })

  it('reports a check listed as both required and not required', () => {
    const gaps = partitionGaps({ prJobs: JOBS, roster: ['Server Tests', 'notify'], exempt: ['notify'] })
    assert.deepEqual(gaps.both, ['notify'])
  })

  it('reports a duplicated row', () => {
    const gaps = partitionGaps({ prJobs: JOBS, roster: ['Server Tests'], exempt: ['notify', 'notify'] })
    assert.deepEqual(gaps.dupes, ['notify'])
  })

  it('reports two jobs sharing one check context', () => {
    const gaps = partitionGaps({
      prJobs: [...JOBS, { name: 'notify', workflow: 'ci.yml' }],
      roster: ['Server Tests'],
      exempt: ['notify'],
    })
    assert.deepEqual(gaps.collidingJobs, ['notify'])
  })
})

/**
 * The WIRING, proven against mutated copies of the real workflow tree.
 *
 * The synthetic cases above prove the rule reports; these prove the rule is
 * actually fed the real files. A guard can have a correct rule and read the
 * wrong subject — #7637 was exactly that — and no amount of synthetic input
 * catches it. Every mutation lands on a `mkdtemp` COPY; the real tree is never
 * written to.
 */
describe('the partition rule reads the real workflow tree (#7639)', () => {
  const dirs = []
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  /** A copy of the real workflows with `[find, replace]` applied to one file. */
  async function mutated(file, pairs) {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-partition-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const target = join(dir, file)
    let text = readFileSync(target, 'utf8')
    for (const [find, replace] of pairs) {
      const occurrences = text.split(find).length - 1
      // Collapsed to a boolean before asserting: comparing two ~86 KB strings
      // puts BOTH into the AssertionError payload, which is what wedged the
      // runner in #7340.
      assert.ok(
        occurrences === 1,
        `the mutation did not land: ${file} contains ${occurrences} occurrences of ` +
          `${JSON.stringify(find.slice(0, 90))}, expected exactly 1 — it has drifted from what ` +
          'this case edits, and the case would otherwise pass for the wrong reason'
      )
      text = text.replace(find, replace)
    }
    writeFileSync(target, text)
    return readWorkflows(pathToFileURL(`${dir}/`))
  }

  let roster
  let exempt
  before(async () => {
    const contributing = await readFile(CONTRIBUTING, 'utf8')
    roster = parseRoster(contributing)
    exempt = parseExemptions(contributing)
  })

  it('CONTROL: an unmutated copy is a clean partition', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-partition-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const prJobs = prVisibleJobs(await readWorkflows(pathToFileURL(`${dir}/`)))
    assert.deepEqual(partitionGaps({ prJobs, roster, exempt }).unclassified, [])
  })

  it('a job added to ci.yml is reported until it is classified', async () => {
    const wf = await mutated('ci.yml', [
      ['\n  style-lint:\n', '\n  brand-new-job:\n    name: Brand New Job\n    runs-on: ubuntu-latest\n\n  style-lint:\n'],
    ])
    const gaps = partitionGaps({ prJobs: prVisibleJobs(wf), roster, exempt })
    assert.deepEqual(gaps.unclassified, ['Brand New Job (ci.yml)'])
  })

  it('a job added to the OTHER PR-triggered workflow is reported too', async () => {
    // The widening #7637 taught: a subject scoped to ci.yml would miss this.
    const wf = await mutated('repo-relay.yml', [
      ['\n  notify:\n', '\n  second-relay-job:\n    runs-on: ubuntu-latest\n\n  notify:\n'],
    ])
    const gaps = partitionGaps({ prJobs: prVisibleJobs(wf), roster, exempt })
    assert.deepEqual(gaps.unclassified, ['second-relay-job (repo-relay.yml)'])
  })

  it('a RENAMED job is reported, and its old row becomes a phantom', async () => {
    const wf = await mutated('ci.yml', [['    name: Style Lint\n', '    name: Style Linting\n']])
    const gaps = partitionGaps({ prJobs: prVisibleJobs(wf), roster, exempt })
    assert.deepEqual(gaps.unclassified, ['Style Linting (ci.yml)'])
    assert.deepEqual(gaps.phantoms, ['Style Lint'])
  })

  it('a workflow that STOPS triggering on pull_request drops out of scope', async () => {
    // The dangerous direction: this must not silently shrink the subject to
    // nothing. It is reported as a phantom row, not as a clean tree.
    const wf = await mutated('repo-relay.yml', [['\n  pull_request:\n', '\n  push:\n']])
    const gaps = partitionGaps({ prJobs: prVisibleJobs(wf), roster, exempt })
    assert.deepEqual(gaps.phantoms, ['notify'])
  })
})
