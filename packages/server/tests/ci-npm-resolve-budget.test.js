import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  readWorkflows,
  assertReaderSane,
  stepRun,
  jobTimeout,
  commandUses,
  withoutHeredocBodies,
  stripShellComment,
  hasUnclosedQuoting,
  DEFAULT_JOB_TIMEOUT_MINUTES,
} from './helpers/workflow-reader.js'

/**
 * #7661 — #7613 established a rule by hand and nothing enforced it.
 *
 * `server-lint` is the only job in ci.yml that resolves npm twice — `npm ci` at
 * the root, then `npm install --package-lock-only` in packages/server for the
 * lockfile freshness check — and it sat inside the same `timeout-minutes: 5`
 * every other lint-tier job carries. On a cold `~/.npm` that is not slow, it is
 * a CANCELLED REQUIRED CHECK, and a cancellation renders as a plain failure. It
 * fired on two PRs in one night. #7660 raised the job to 10 minutes.
 *
 * The fix was one number in one job. Adding a second `npm ci` to any of the
 * eight remaining five-minute jobs reproduces the whole thing, and the failure
 * reads as a flake rather than as a misconfiguration, so it can burn several
 * retries before anyone traces it back.
 *
 * THE RULE: a job needs at least MINUTES_PER_NPM_RESOLVE of budget for every
 * npm resolve it performs.
 *
 * Two points calibrate it and both are load-bearing rather than slack. Eight
 * jobs run exactly one resolve inside five minutes today, so the constant
 * cannot go up without going red; `server-lint` runs two inside ten, so it
 * cannot go down. The linear form is the simplest rule through both, and it
 * extends to a third resolve without anyone re-deriving the reasoning. It is a
 * FLOOR ON THE BUDGET, not an estimate of the runtime: steady-state
 * `server-lint` is 37-43 seconds.
 *
 * A job that declares no `timeout-minutes` gets GitHub's six-hour default,
 * which clears every floor this rule can produce. That is correct — those jobs
 * have no budget problem — and it is also the one direction the rule cannot
 * make fail-closed by arithmetic, so `jobTimeout` carries a positive control
 * below rather than being trusted.
 *
 * WHAT COUNTS AS A RESOLVE, and why the list is shaped the way it is. `npm ci`
 * and `npm install` contact the registry and build a dependency tree; `npm run`
 * and `npm test` run a script and contact nothing. So the classifier needs to
 * read the SUBCOMMAND, and it does that with a DENYLIST of the subcommands
 * known not to resolve — anything else counts.
 *
 * That is the opposite polarity from the sibling predicate in
 * `ci-scripts-tests-registration.test.js`, which keeps an EMPTY allowlist of
 * interpreter flags and accepts false orphans. The polarity is not a style
 * choice; it follows from which mistake is silent. There, over-counting
 * invocations means missing an orphaned test suite, so it errs toward reporting
 * one. Here, UNDER-counting resolves means a two-resolve job reads as one and
 * the rule waves through exactly the misconfiguration it exists to catch.
 * Over-counting is a red build, which someone reads. So an unrecognised
 * subcommand counts as a resolve, and so does an `npm` with no subcommand at
 * all.
 *
 * WHAT THIS DOES NOT MEASURE, stated so no one reads it as more than it is. It
 * counts resolve COMMANDS, not registry round trips: two `npm ci` runs in the
 * same directory, or a resolve behind an `if` that is usually false, both count
 * as what they are spelled as. A budget floor derived from spellings is what a
 * static guard can offer; the runtime is what the job's own history shows.
 */

/** Minutes of budget each npm resolve in a job requires. See the header. */
const MINUTES_PER_NPM_RESOLVE = 5

/**
 * npm subcommands that do NOT resolve a dependency tree.
 *
 * Deliberately short. Every name here is a script runner — `npm test` is
 * `npm run test`, `run-script` is `run`'s own canonical spelling — and adding a
 * name that DOES resolve would make this guard silently blind to it, which is
 * the failure it exists to prevent. A subcommand that belongs here and is
 * missing costs a false red, which is loud and is fixed by one line plus the
 * reason it contacts nothing.
 *
 * Measured across all seven workflow files: the only subcommands spelled
 * anywhere are `ci`, `install`, `run` and `test`.
 */
const NON_RESOLVING_NPM_SUBCOMMANDS = new Set(['run', 'run-script', 'test'])

/**
 * Floors, not counts — loose enough to survive honest growth and shrinkage,
 * tight enough that a detector which has stopped detecting cannot clear them.
 * Every rule below quantifies over what the detector found, so a detector that
 * finds nothing passes every one of them over an empty set and reports a clean
 * green. Measured 2026-09-09: 57 npm invocations, 22 resolves, 6 quoted
 * mentions, 25 jobs with an explicit timeout.
 */
const MIN_NPM_INVOCATIONS = 35
const MIN_NPM_RESOLVES = 14
const MIN_QUOTED_NPM_MENTIONS = 4
const MIN_TIMED_JOBS = 18

/** Every `run:` body in a job, in order. */
const runBodies = job => job.steps.map(stepRun).filter(b => typeof b === 'string')

/** Every classified `npm` use in a job. */
const npmUses = job => runBodies(job).flatMap(body => commandUses(body, 'npm'))

/**
 * The subcommand of an npm invocation: the first argument that is not a flag.
 *
 * `undefined` when there is none — a bare `npm`, or one whose arguments were
 * quoted and therefore unreadable. Both count as resolves at the call site; see
 * the header on which direction is silent.
 */
const subcommandOf = use => use.args.find(a => !a.startsWith('-'))

/** How many npm resolves this job performs. */
function npmResolves(job) {
  return npmUses(job).filter(
    u => u.kind === 'invocation' && !NON_RESOLVING_NPM_SUBCOMMANDS.has(subcommandOf(u))
  ).length
}

/**
 * The budget a job actually has, in minutes.
 *
 * `NaN` for a declared-but-unreadable value, deliberately: NaN fails every
 * comparison, so a timeout nobody can parse goes RED here instead of quietly
 * satisfying a floor.
 */
const budgetOf = job => {
  const declared = jobTimeout(job)
  return declared === undefined ? DEFAULT_JOB_TIMEOUT_MINUTES : declared
}

/** Every job whose budget is below what its npm resolves require. */
function budgetViolations(workflows) {
  const bad = []
  for (const w of workflows) {
    for (const job of w.jobs) {
      const resolves = npmResolves(job)
      if (resolves === 0) continue
      const required = resolves * MINUTES_PER_NPM_RESOLVE
      if (budgetOf(job) >= required) continue
      bad.push(
        `${w.name}:${job.id} resolves npm ${resolves}x on a ${jobTimeout(job)}-minute budget ` +
          `(needs >=${required})`
      )
    }
  }
  return bad
}

const REAL = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url))

describe('every npm resolve is paid for in the job budget (#7613, #7660, #7661)', () => {
  let workflows

  before(async () => {
    workflows = await readWorkflows()
  })

  it('CONTROL: the reader is still reading these files', () => {
    assertReaderSane(workflows)
  })

  it('CONTROL: the timeout accessor still finds the budgets that ARE declared', () => {
    // The one direction the rule cannot make fail-closed by arithmetic: a
    // `jobTimeout` that silently stopped matching returns undefined for every
    // job, every job then reads as GitHub's six-hour default, and the floor
    // passes for anything at all.
    const timed = workflows.flatMap(w => w.jobs).filter(j => jobTimeout(j) !== undefined)
    assert.ok(
      timed.length >= MIN_TIMED_JOBS,
      `expected >=${MIN_TIMED_JOBS} jobs with an explicit timeout-minutes, found ${timed.length} — ` +
        'jobTimeout() has stopped matching, and every job would then read as unlimited'
    )
    const ci = workflows.find(w => w.name === 'ci.yml')
    const serverLint = ci.jobs.find(j => j.id === 'server-lint')
    assert.equal(
      jobTimeout(serverLint),
      10,
      'server-lint is the job #7660 raised to 10 minutes; a different number here means either ' +
        'the accessor is reading the wrong line or someone has undone that fix'
    )
  })

  it('CONTROL: the detector still finds npm invocations, and resolves among them', () => {
    const uses = workflows.flatMap(w => w.jobs).flatMap(npmUses)
    const invocations = uses.filter(u => u.kind === 'invocation')
    assert.ok(
      invocations.length >= MIN_NPM_INVOCATIONS,
      `expected >=${MIN_NPM_INVOCATIONS} npm invocations across the workflows, found ` +
        `${invocations.length} — the detector is broken, and every rule below quantifies over it`
    )
    const resolves = workflows.flatMap(w => w.jobs).reduce((n, j) => n + npmResolves(j), 0)
    assert.ok(
      resolves >= MIN_NPM_RESOLVES,
      `expected >=${MIN_NPM_RESOLVES} npm resolves across the workflows, found ${resolves} — the ` +
        'subcommand classifier is discarding real resolves, which is the direction that waves a ' +
        'violation through'
    )
  })

  it('CONTROL: quoted mentions are still being masked out, not counted', () => {
    // If the quote mask stopped masking, these six `echo` lines would cut back
    // to an empty segment at their own quoted `&&` and read as INVOCATIONS —
    // so a zero here is not "nothing to see", it is the mask having failed
    // open. That is the whole reason the count is floored rather than assumed.
    const quoted = workflows
      .flatMap(w => w.jobs)
      .flatMap(npmUses)
      .filter(u => u.kind === 'quoted')
    assert.ok(
      quoted.length >= MIN_QUOTED_NPM_MENTIONS,
      `expected >=${MIN_QUOTED_NPM_MENTIONS} npm mentions inside quoted strings, found ` +
        `${quoted.length} — the quote mask is no longer masking, and prose is being read as ` +
        'configuration'
    )
  })

  it('every npm use in every workflow is CLASSIFIED — an unknown shape is not a zero', () => {
    // The bucket that keeps the undercount honest. `sudo npm ci`, `then npm ci`,
    // `xargs npm ci` all put a word in front of the command name, and nothing
    // here guesses whether that word runs its operand — guessing wrong in the
    // lenient direction is a resolve that vanishes silently. A spelling nobody
    // anticipated goes red here and gets classified by a person.
    const unclassified = workflows.flatMap(w =>
      w.jobs.flatMap(j => npmUses(j).filter(u => u.kind === 'unclassified').map(u => `${w.name}:${j.id}: ${u.line.trim()}`))
    )
    assert.deepEqual(
      unclassified,
      [],
      'npm appears in a command-like position this guard cannot classify. Decide whether each one ' +
        'invokes npm and teach commandUses(), or rewrite the step — do not leave it unread.'
    )
  })

  it('CONTROL: no run-body line leaves a quote open, so the per-line mask applies', () => {
    // `maskQuotedData` works one line at a time, and a string that opens on one
    // line and closes on the next would be read as code on the second. Nothing
    // in these files does that today; asserting it is what stops "the model
    // does not apply here" from being indistinguishable from "this line is
    // clean".
    const open = workflows.flatMap(w =>
      w.jobs.flatMap(j =>
        runBodies(j)
          .flatMap(b => withoutHeredocBodies(b.split('\n')).map(stripShellComment))
          .filter(hasUnclosedQuoting)
          .map(l => `${w.name}:${j.id}: ${l.trim()}`)
      )
    )
    assert.deepEqual(open, [], 'a run-body line ends inside a quote; maskQuotedData reads the NEXT line as code')
  })

  it('server-lint resolves npm TWICE — its own error message is prose, not a third', () => {
    // The live negative fixture, and it is not hypothetical: the first pass at
    // the #7660 measurement counted three, because
    //
    //   echo "::error::… Run 'cd packages/server && npm install --package-lock-only' …"
    //
    // cuts at the quoted `&&` to an empty segment, which is exactly the shape a
    // command-word test accepts. A guard that reads prose as configuration is
    // satisfiable by prose.
    const ci = workflows.find(w => w.name === 'ci.yml')
    const serverLint = ci.jobs.find(j => j.id === 'server-lint')
    const uses = npmUses(serverLint)
    assert.equal(npmResolves(serverLint), 2, 'server-lint should resolve npm exactly twice')
    const quoted = uses.filter(u => u.kind === 'quoted')
    assert.equal(quoted.length, 1)
    assert.match(
      quoted[0].line,
      /--package-lock-only/,
      'the quoted mention should be the lockfile-staleness error message'
    )
    assert.deepEqual(
      uses.filter(u => u.kind === 'invocation').map(subcommandOf).sort(),
      ['ci', 'install', 'run', 'run'],
      'the four real npm invocations, of which two resolve'
    )
  })

  it('every job has at least five minutes of budget per npm resolve', () => {
    assert.deepEqual(
      budgetViolations(workflows),
      [],
      `each job listed resolves npm more often than its timeout-minutes pays for. Raise the ` +
        `budget to ${MINUTES_PER_NPM_RESOLVE} minutes per resolve, or drop a resolve — #7613 is ` +
        'what the second one costs on a cold cache.'
    )
  })
})

describe('the budget rule goes RED — one mutation at a time (#7661)', () => {
  const dirs = []

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  /**
   * A copy of the real workflows with each `[find, replace]` applied to ci.yml.
   *
   * The same idiom as `ci-scripts-tests-registration.test.js`: each pair is
   * asserted to land EXACTLY once, because a chained replace whose pattern has
   * drifted still produces a file, and the case then passes against a mutation
   * that was never applied.
   */
  async function mutated(pairs) {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-npm-budget-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const ci = join(dir, 'ci.yml')
    let text = readFileSync(ci, 'utf8')
    for (const [find, replace] of pairs) {
      const occurrences = text.split(find).length - 1
      assert.ok(
        occurrences === 1,
        `the mutation did not land: ci.yml contains ${occurrences} occurrences of ` +
          `${JSON.stringify(find.slice(0, 90))}, expected exactly 1 — it has drifted from what ` +
          'this case edits, and the case would otherwise pass for the wrong reason'
      )
      text = text.replace(find, replace)
    }
    writeFileSync(ci, text)
    return readWorkflows(pathToFileURL(`${dir}/`))
  }

  // app-typecheck: five minutes, one resolve (`npm ci`), and its last step is
  // the only `npx tsc --noEmit` in the file — a unique anchor to mutate.
  const TSC_STEP = '        run: npx tsc --noEmit'
  const TYPECHECK_TIMEOUT =
    '    name: App Type Check\n' +
    '    needs: runner-target\n' +
    '    runs-on: ${{ fromJSON(needs.runner-target.outputs.runner) }}  # SELF_HOSTED_OR_HOSTED (see header)\n' +
    '    timeout-minutes: 5'

  it('CONTROL: an unmutated copy has no violations, so the rule is not deny-everything', async () => {
    assert.deepEqual(budgetViolations(await readWorkflows(pathToFileURL(REAL))), [])
  })

  it('a SECOND resolve added to a five-minute job', async () => {
    // #7613 itself, reproduced in the job next door.
    const wf = await mutated([
      [TSC_STEP, '        run: |\n          npm install --package-lock-only\n          npx tsc --noEmit'],
    ])
    assert.deepEqual(budgetViolations(wf), [
      'ci.yml:app-typecheck resolves npm 2x on a 5-minute budget (needs >=10)',
    ])
  })

  it("server-lint's budget returned to its pre-#7660 five minutes", async () => {
    const wf = await mutated([
      [
        '    # required check whose observed failure mode is a false red.\n    timeout-minutes: 10',
        '    # required check whose observed failure mode is a false red.\n    timeout-minutes: 5',
      ],
    ])
    assert.deepEqual(budgetViolations(wf), [
      'ci.yml:server-lint resolves npm 2x on a 5-minute budget (needs >=10)',
    ])
  })

  it('a timeout nobody can parse is a violation, not a job without a budget', async () => {
    const wf = await mutated([
      [TYPECHECK_TIMEOUT, TYPECHECK_TIMEOUT.replace('timeout-minutes: 5', 'timeout-minutes: five')],
    ])
    assert.deepEqual(budgetViolations(wf), [
      'ci.yml:app-typecheck resolves npm 1x on a NaN-minute budget (needs >=5)',
    ])
  })

  it('an `npm install` inside an error MESSAGE does not count — the acceptance fixture, moved', async () => {
    // The same shape as server-lint's live one, planted in a five-minute job
    // where counting it would immediately trip the rule. This is the case that
    // fails if the quote mask is ever removed.
    const wf = await mutated([
      [
        TSC_STEP,
        '        run: |\n' +
          '          echo "::error::stale. Run \'cd packages/app && npm install --package-lock-only\' and commit."\n' +
          '          npx tsc --noEmit',
      ],
    ])
    assert.deepEqual(budgetViolations(wf), [])
  })

  it('a command-word shape the detector cannot classify is reported, not counted as zero', async () => {
    const wf = await mutated([[TSC_STEP, '        run: sudo npm ci']])
    const unclassified = wf
      .flatMap(w => w.jobs.flatMap(j => npmUses(j)))
      .filter(u => u.kind === 'unclassified')
    assert.equal(unclassified.length, 1)
    assert.match(unclassified[0].line, /sudo npm ci/)
    // And it did NOT quietly become a resolve, in either direction.
    assert.deepEqual(budgetViolations(wf), [])
  })
})

describe("the resolve detector's own reading goes RED (#7661)", () => {
  const resolvesIn = body =>
    commandUses(body, 'npm').filter(
      u => u.kind === 'invocation' && !NON_RESOLVING_NPM_SUBCOMMANDS.has(subcommandOf(u))
    ).length

  const cases = [
    ['npm ci', 1],
    ['npm install', 1],
    ['npm install --package-lock-only', 1],
    ['npm ci --omit=dev', 1],
    ['npm run build', 0],
    ['npm run-script build', 0],
    ['npm test', 0],
    ['npm run build -w @chroxy/store-core', 0],
    ['npm ci\nnpm run build\nnpm test', 1],
    ['npm ci && npm install', 2],
    ['cd packages/server && npm ci', 1],
    ['out=$(npm ci)', 1],
    ['out="$(npm ci)"', 1],
    ['echo "run npm ci first"', 0],
    ["echo 'npm ci'", 0],
    ['echo "a && npm ci"', 0],
    ['# npm ci', 0],
    ['echo hi  # npm ci', 0],
    ['cat <<EOF\nnpm ci\nEOF', 0],
    ['node scripts/lint-workflow-npm-env.mjs', 0],
    ['echo "npmcache=npm" >> "$GITHUB_OUTPUT"', 0],
  ]

  for (const [body, expected] of cases) {
    it(`${JSON.stringify(body)} → ${expected}`, () => {
      assert.equal(resolvesIn(body), expected)
    })
  }

  it('an UNRECOGNISED subcommand counts as a resolve — the loud direction', () => {
    // `npm update` and `npm dedupe` both resolve. Neither is spelled in this
    // repo, and neither needs to be enumerated for the rule to hold: the
    // denylist names what is known NOT to resolve, and everything else counts.
    assert.equal(resolvesIn('npm update'), 1)
    assert.equal(resolvesIn('npm dedupe'), 1)
  })

  it('a bare `npm`, or one whose arguments are unreadable, counts as a resolve', () => {
    assert.equal(resolvesIn('npm'), 1)
    assert.equal(resolvesIn('npm "ci"'), 1)
  })

  it('CONTROL: the classifier is not answering "resolve" to everything', () => {
    // Without this the cases above are satisfied by a function that returns the
    // invocation count and never reads a subcommand at all — the deny-nothing
    // shape, one polarity over (#7273).
    assert.equal(resolvesIn('npm run a\nnpm run b\nnpm test\nnpm run-script c'), 0)
  })
})
