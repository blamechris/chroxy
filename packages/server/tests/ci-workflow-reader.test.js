import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseJobs,
  parseSteps,
  stepInput,
  code,
  stepRun,
  jobShell,
  jobName,
  jobTimeout,
  workflowTriggers,
  invokes,
  isCommandPosition,
  withoutHeredocBodies,
  heredocDelimiter,
  maskQuotedData,
  hasUnclosedQuoting,
  stripShellComment,
  assertEveryFileParsed,
  commandUses,
} from './helpers/workflow-reader.js'

/**
 * Unit tests for the shared workflow reader (#7386).
 *
 * The reader is what `ci-cache-key.test.js` and `ci-npm-cache-routing.test.js`
 * both quantify over, so anything it cannot SEE is something those guards
 * silently do not check — the "cannot check this treated as nothing to check"
 * cause in docs/false-safety-guards.md. Their positive controls catch a reader
 * that finds NOTHING; they cannot catch a reader that finds most things.
 *
 * That gap was not hypothetical. Until this file existed, a job whose
 * `runs-on:` used a YAML block sequence parsed to the literal `"runs-on:"`,
 * so `/self-hosted/` never matched and every self-hosted rule skipped the job.
 * A workflow pinned to `[self-hosted, macOS, ARM64]` in block form while
 * hardcoding `cache: npm` — the #7383 defect verbatim — passed all 14 tests
 * green. Reproduced, then fixed, then pinned here.
 *
 * These drive synthetic YAML rather than the repo's real workflows on purpose:
 * a spelling the repo does not currently use is exactly the one no
 * repo-scanning guard can prove it handles.
 */

const BLOCK_SEQUENCE = `
name: probe
on: workflow_dispatch
jobs:
  probe:
    runs-on:
      - self-hosted
      - macOS
      - ARM64
    steps:
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          cache: npm
`

const FLOW_SEQUENCE = `
name: probe
on: workflow_dispatch
jobs:
  probe:
    runs-on: [self-hosted, macOS, ARM64]
    steps:
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          cache: npm
`

describe('workflow reader: runs-on spellings (#7386)', () => {
  it('sees the labels of a FLOW-sequence runs-on', () => {
    const [job] = parseJobs(FLOW_SEQUENCE, 'flow.yml')
    assert.match(job.runsOn, /self-hosted/)
    assert.match(job.runsOn, /ARM64/)
  })

  it('sees the labels of a BLOCK-sequence runs-on', () => {
    // The regression this file exists for. Before the fix this was the string
    // "    runs-on:" and every self-hosted rule skipped the job.
    const [job] = parseJobs(BLOCK_SEQUENCE, 'block.yml')
    assert.match(job.runsOn, /self-hosted/)
    assert.match(job.runsOn, /ARM64/)
  })

  it('agrees between the two spellings of the same label set', () => {
    // The property that matters, stated directly: two ways of writing identical
    // config must not produce different verdicts. This is the assertion that
    // fails if only ONE of the two branches above is ever fixed.
    const block = parseJobs(BLOCK_SEQUENCE, 'block.yml')[0]
    const flow = parseJobs(FLOW_SEQUENCE, 'flow.yml')[0]
    const visible = runsOn => ['self-hosted', 'macOS', 'ARM64'].filter(l => runsOn.includes(l))
    assert.deepEqual(visible(block.runsOn), visible(flow.runsOn))
    assert.deepEqual(visible(block.runsOn), ['self-hosted', 'macOS', 'ARM64'])
  })

  it('stops at the next key rather than swallowing the rest of the job', () => {
    const [job] = parseJobs(BLOCK_SEQUENCE, 'block.yml')
    assert.doesNotMatch(job.runsOn, /setup-node/, 'runs-on must not absorb the steps block')
    assert.doesNotMatch(job.runsOn, /cache/, 'runs-on must not absorb step inputs')
  })

  it('leaves a scalar runs-on and an expression runs-on intact', () => {
    const scalar = parseJobs('jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps: []\n', 'a.yml')[0]
    assert.match(scalar.runsOn, /ubuntu-24\.04/)
    const routed = parseJobs(
      'jobs:\n  a:\n    runs-on: ${{ fromJSON(needs.runner-target.outputs.runner) }}\n    steps: []\n',
      'a.yml'
    )[0]
    assert.match(routed.runsOn, /needs\.runner-target\.outputs\.runner/)
  })

  it('returns an empty runs-on for a job that declares none', () => {
    // Must be the EMPTY string, not the word "runs-on:" — the routing guard's
    // `jobs.every(j => j.runsOn !== '')` sanity check depends on it.
    const [job] = parseJobs('jobs:\n  a:\n    steps: []\n', 'a.yml')
    assert.equal(job.runsOn, '')
  })
})

describe('workflow reader: step + input parsing (#7386)', () => {
  it('splits steps and reads with: inputs', () => {
    const [job] = parseJobs(BLOCK_SEQUENCE, 'block.yml')
    assert.equal(job.steps.length, 1)
    assert.equal(stepInput(job.steps[0], 'cache'), 'npm')
    assert.equal(stepInput(job.steps[0], 'node-version'), '22')
    assert.equal(stepInput(job.steps[0], 'cache-dependency-path'), undefined)
  })

  it('strips a TRAILING comment from an input value', () => {
    // `cache: npm # hosted only` parses as `npm` in YAML. Reading the rest of
    // the line instead yields `npm # hosted only`, which matches no rule — the
    // bypass verified during #7383.
    const yml = `jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/setup-node@x\n        with:\n          cache: npm # hosted only\n`
    const [job] = parseJobs(yml, 'a.yml')
    assert.equal(stepInput(job.steps[0], 'cache'), 'npm')
  })

  it('reads a quoted value up to its closing quote', () => {
    const yml = `jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/setup-node@x\n        with:\n          cache-dependency-path: '**/package-lock.json' # three lockfiles\n`
    const [job] = parseJobs(yml, 'a.yml')
    assert.equal(stepInput(job.steps[0], 'cache-dependency-path'), '**/package-lock.json')
  })

  it('does not read a commented-out input as configuration', () => {
    // ci.yml's comments quote `cache: npm` verbatim in the rationale for having
    // removed it. A guard that reads prose as config is satisfiable by prose.
    const yml = `jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/setup-node@x\n        with:\n          # cache: npm\n          node-version: 22\n`
    const [job] = parseJobs(yml, 'a.yml')
    assert.equal(stepInput(job.steps[0], 'cache'), undefined)
    assert.equal(code(job.steps[0]).some(l => l.includes('cache: npm')), false)
  })

  it('returns no steps for a job with no steps: key', () => {
    assert.deepEqual(parseSteps(['  a:', '    runs-on: ubuntu-24.04']), [])
  })

  it('fails loudly on a file with no jobs: key', () => {
    // "Cannot parse this" must be an error in its own right, not a skip that
    // reports zero jobs and lets every rule pass vacuously.
    assert.throws(() => parseJobs('name: nope\non: push\n', 'nope.yml'), /top-level 'jobs:' key/)
  })
})

describe('parseJobs — job-id lines with trailing comments (#7499)', () => {
  // `  jobid:  # why this job is pinned` is a semantic no-op to GitHub but the
  // job-start regex used to require end-of-line after the colon, so the whole
  // job silently merged into its predecessor — its name vanished from every
  // consumer's view (found while #7499 added a job-NAME consumer; a runs-on
  // comment like ci.yml's own `# LONG-JOB PINNING` on the id line would have
  // done the same to the cache guards).
  const COMMENTED_ID = `
jobs:
  first:
    name: First Job
    runs-on: ubuntu-latest
  second:  # pinned per #7471
    name: Second Job
    runs-on: ubuntu-latest
`

  it('recognizes a commented job-id line as a job start', () => {
    const jobs = parseJobs(COMMENTED_ID, 'commented.yml')
    assert.deepEqual(jobs.map(j => j.id), ['first', 'second'])
    assert.ok(
      jobs[1].body.some(l => l.includes('name: Second Job')),
      "second's body must carry its own name line, not be merged into first"
    )
  })
})

/**
 * A step's keys may be written on its `- ` line or under it. GitHub reads the
 * two identically, so the reader must too — see stepInput's own comment for the
 * #7632 guard that stayed green against exactly the config it forbade.
 */
const KEY_ON_DASH_LINE = `
name: probe
on: workflow_dispatch
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - continue-on-error: true
        uses: some/action@0000000000000000000000000000000000000000
`

const KEY_UNDER_DASH_LINE = `
name: probe
on: workflow_dispatch
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: some/action@0000000000000000000000000000000000000000
        continue-on-error: true
`

describe('workflow reader: step keys on the dash line (#7632)', () => {
  it('reads a key written on the step\'s own `- ` line', () => {
    const [job] = parseJobs(KEY_ON_DASH_LINE, 'dash.yml')
    assert.equal(stepInput(job.steps[0], 'continue-on-error'), 'true')
  })

  it('agrees between the two spellings of the same step config', () => {
    const [onDash] = parseJobs(KEY_ON_DASH_LINE, 'dash.yml')
    const [underDash] = parseJobs(KEY_UNDER_DASH_LINE, 'under.yml')
    assert.equal(
      stepInput(onDash.steps[0], 'continue-on-error'),
      stepInput(underDash.steps[0], 'continue-on-error')
    )
  })

  it('still reads a nested with: input', () => {
    const [job] = parseJobs(BLOCK_SEQUENCE, 'block.yml')
    assert.equal(stepInput(job.steps[0], 'cache'), 'npm')
  })
})

describe('workflow reader: stepRun (#7632)', () => {
  const wrap = body => `
name: probe
on: workflow_dispatch
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
${body}
`
  const firstStep = yml => parseJobs(wrap(yml), 'run.yml')[0].steps[0]

  it('reads a block scalar and dedents it', () => {
    assert.equal(stepRun(firstStep('      - name: go\n        run: |\n          set -e\n          echo hi')), 'set -e\necho hi')
  })

  it('keeps a `#` inside a block scalar, which is a SHELL comment', () => {
    assert.equal(stepRun(firstStep('      - run: |\n          echo one # trailing\n          # whole line')), 'echo one # trailing\n# whole line')
  })

  it('TRUNCATES a plain scalar at a whitespace-preceded `#`, exactly as YAML does', () => {
    // Not a bug being pinned in: reproducing YAML's reading is the entire point.
    // The friendlier reading is what let repo-relay.yml ship an unterminated
    // quote in #7632 — a guard must see what the runner sees, not what the
    // author meant.
    assert.equal(stepRun(firstStep('      - run: echo "see #7632."')), 'echo "see')
  })

  it('reads a quoted scalar up to its closing quote', () => {
    assert.equal(stepRun(firstStep('      - run: "echo hi"')), 'echo hi')
  })

  it('finds a run: written on the step\'s own `- ` line', () => {
    assert.equal(stepRun(firstStep('      - run: |\n          echo hi')), 'echo hi')
  })

  it('stops a block scalar at the next step key', () => {
    assert.equal(stepRun(firstStep('      - run: |\n          echo hi\n        shell: bash')), 'echo hi')
  })

  it('returns undefined for a step with no run:', () => {
    assert.equal(stepRun(firstStep('      - uses: some/action@0000000000000000000000000000000000000000')), undefined)
  })
})

describe('workflow reader: jobShell (#7632)', () => {
  const wrap = job => `
name: probe
on: workflow_dispatch
jobs:
  probe:
${job}
`
  it('reads a job-level defaults.run.shell', () => {
    const [job] = parseJobs(wrap('    runs-on: windows-latest\n    defaults:\n      run:\n        shell: powershell\n    steps:\n      - run: npm ci'), 'j.yml')
    assert.equal(jobShell(job.body), 'powershell')
  })

  it('does not read a shell named only in a COMMENT', () => {
    // ci.yml's server-tests-windows explains its choice in prose containing the
    // literal string "`shell: bash`". A guard satisfiable by prose is no guard.
    const [job] = parseJobs(wrap('    runs-on: windows-latest\n    defaults:\n      run:\n        # shell: bash resolves to WSL bash on this runner\n        shell: powershell\n    steps:\n      - run: npm ci'), 'j.yml')
    assert.equal(jobShell(job.body), 'powershell')
  })

  it('does not mistake a STEP-level shell for the job default', () => {
    const [job] = parseJobs(wrap('    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n        shell: powershell'), 'j.yml')
    assert.equal(jobShell(job.body), undefined)
  })

  it('returns undefined for a job that declares no shell', () => {
    const [job] = parseJobs(wrap('    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci'), 'j.yml')
    assert.equal(jobShell(job.body), undefined)
  })
})

describe('workflow reader: folded (>) run scalars (#7632)', () => {
  const wrap = body => `
name: probe
on: workflow_dispatch
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
${body}
`
  const firstStep = yml => parseJobs(wrap(yml), 'run.yml')[0].steps[0]

  it('FOLDS a > scalar to one line, as the runner receives it', () => {
    // Treating `>` like `|` inverts this module's purpose. Unfolded, these are
    // three statements and `bash -n` passes; folded — which is what GitHub
    // actually hands bash — it is `if true; then echo hi fi`, which dies with
    // "unexpected end of file". The guard would report green on a step that
    // cannot run. Verified equal to js-yaml's reading of the same source.
    assert.equal(
      stepRun(firstStep('      - run: >\n          if true; then\n          echo hi\n          fi')),
      'if true; then echo hi fi'
    )
  })

  it('turns a blank line inside a folded scalar into a newline, not a space', () => {
    assert.equal(stepRun(firstStep('      - run: >\n          echo one\n\n          echo two')), 'echo one\necho two')
  })

  it('keeps a MORE-indented line literal inside a folded scalar', () => {
    assert.equal(
      stepRun(firstStep('      - run: >\n          echo one\n            deeper\n          echo two')),
      'echo one\n  deeper\necho two'
    )
  })

  it('leaves a | scalar unfolded', () => {
    assert.equal(stepRun(firstStep('      - run: |\n          echo one\n          echo two')), 'echo one\necho two')
  })
})

describe('workflow reader: jobShell is anchored to defaults.run (#7632)', () => {
  const wrap = job => `
name: probe
on: workflow_dispatch
jobs:
  probe:
${job}
`
  const shellOf = job => jobShell(parseJobs(wrap(job), 'j.yml')[0].body)

  it('reads defaults.run.shell', () => {
    assert.equal(
      shellOf('    runs-on: windows-latest\n    defaults:\n      run:\n        shell: powershell\n    steps:\n      - run: npm ci'),
      'powershell'
    )
  })

  it('does NOT read a strategy.matrix.shell axis as the job shell', () => {
    // The dangerous direction: the run-block guard only feeds bash/sh to
    // `bash -n`, so one false "powershell" here silently drops every real bash
    // block in that job out of the check.
    assert.equal(
      shellOf('    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        shell: [bash, zsh]\n    steps:\n      - run: npm ci'),
      undefined
    )
  })

  it('does NOT read an env.shell as the job shell', () => {
    assert.equal(
      shellOf('    runs-on: ubuntu-latest\n    env:\n      shell: fish\n    steps:\n      - run: npm ci'),
      undefined
    )
  })

  it('does NOT read a shell: sitting directly under defaults, outside run:', () => {
    assert.equal(
      shellOf('    runs-on: ubuntu-latest\n    defaults:\n      shell: powershell\n    steps:\n      - run: npm ci'),
      undefined
    )
  })
})

describe('workflow reader: jobName (#7639)', () => {
  /** The single job parsed out of a synthetic one-job workflow. */
  const nameOf = body => jobName(parseJobs(`name: probe\non: push\njobs:\n  probe:\n${body}\n`)[0])

  it('returns the display name when name: is present', () => {
    assert.equal(nameOf('    name: Server Tests\n    runs-on: ubuntu-latest'), 'Server Tests')
  })

  it('falls back to the job id when there is no name:', () => {
    // repo-relay.yml's `notify` is exactly this shape, and its check context
    // really is the bare job id — confirmed against a live PR's check runs.
    assert.equal(nameOf('    runs-on: ubuntu-latest'), 'probe')
  })

  it('strips a single layer of matching quotes — YAML quoting is cosmetic', () => {
    assert.equal(nameOf('    name: "Desktop Rust Tests (Windows)"'), 'Desktop Rust Tests (Windows)')
    assert.equal(nameOf("    name: 'Style Lint'"), 'Style Lint')
  })

  it('does NOT read a STEP name as the job name', () => {
    // The dangerous direction: a job with no name: whose first step IS named
    // would otherwise take the step's name as its check context, and the whole
    // partition guard would quantify over a context GitHub never produces.
    assert.equal(
      nameOf('    runs-on: ubuntu-latest\n    steps:\n      - name: Install dependencies\n        run: npm ci'),
      'probe'
    )
  })

  it('does NOT read a commented-out name: as configuration', () => {
    assert.equal(nameOf('    # name: Disabled Name\n    runs-on: ubuntu-latest'), 'probe')
  })
})

describe('workflow reader: workflowTriggers (#7639)', () => {
  it('reads the mapping form', () => {
    assert.deepEqual(workflowTriggers('name: x\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  a:\n'), [
      'push',
      'pull_request',
    ])
  })

  it('reads the list form', () => {
    assert.deepEqual(workflowTriggers('name: x\non: [push, pull_request]\njobs:\n  a:\n'), ['push', 'pull_request'])
  })

  it('reads the bare string form', () => {
    assert.deepEqual(workflowTriggers('name: x\non: pull_request\njobs:\n  a:\n'), ['pull_request'])
  })

  it('does NOT read a trigger named only in a comment', () => {
    // Not hypothetical: repo-relay.yml's `on:` block carries a long comment
    // explaining why `pull_request_review` was REMOVED. A reader that treats
    // prose as configuration is satisfiable by prose.
    assert.deepEqual(
      workflowTriggers('name: x\non:\n  # pull_request_review: removed, see #6749\n  issue_comment:\n jobs:\n'),
      ['issue_comment']
    )
  })

  it('does not mistake a trigger option for a trigger', () => {
    // `types:` and `branches:` sit one level deeper than the event names, so a
    // reader that took every indented key would report them as triggers and a
    // `pull_request`-scoped guard would widen to workflows that never run on one.
    assert.deepEqual(
      workflowTriggers('name: x\non:\n  pull_request:\n    types: [opened, closed]\n    branches: [main]\njobs:\n  a:\n'),
      ['pull_request']
    )
  })

  it('strips a trailing comment from the key line', () => {
    assert.deepEqual(workflowTriggers('name: x\non: push # only on push\njobs:\n  a:\n'), ['push'])
  })

  it('returns nothing for a workflow with no on: key, rather than guessing', () => {
    assert.deepEqual(workflowTriggers('name: x\njobs:\n  a:\n'), [])
  })
})

describe('workflow reader: on: spellings that used to drop a whole workflow (#7643)', () => {
  /**
   * Every case here returned `[]` or a bogus single name from the first version
   * of `workflowTriggers()`, which matched only a bare unquoted `on:` in block
   * or flow-sequence form. Two independent reviewers of #7643 reported it: a
   * workflow spelled any of these ways is discovered by `readWorkflows()`,
   * contributes real check contexts on every PR, and was silently dropped from
   * `ci-required-check-partition.test.js`'s subject — reproducing, one layer
   * down, the exact defect that guard exists to close. The floors could not
   * catch it: the untouched real workflows already clear MIN_PR_WORKFLOWS and
   * MIN_PR_JOBS on their own.
   */
  const pr = yml => workflowTriggers(yml).includes('pull_request')

  it('a DOUBLE-quoted on: key still yields its triggers', () => {
    // YAML 1.1 parses bare `on` as a boolean, so quoting the key is a normal,
    // deliberate thing to find in a hand-written or linted workflow. GitHub
    // treats both spellings identically and so must this.
    assert.deepEqual(workflowTriggers('name: x\n"on":\n  pull_request:\njobs:\n  a:\n'), ['pull_request'])
    assert.ok(pr('name: x\n"on":\n  pull_request:\njobs:\n  a:\n'))
  })

  it('a SINGLE-quoted on: key still yields its triggers', () => {
    assert.deepEqual(workflowTriggers("name: x\n'on':\n  pull_request:\njobs:\n  a:\n"), ['pull_request'])
  })

  it('a flow-MAPPING value yields each event, not one bogus string', () => {
    assert.deepEqual(workflowTriggers('name: x\non: {push: null, pull_request: null}\njobs:\n  a:\n'), [
      'push',
      'pull_request',
    ])
  })

  it('a flow mapping whose events carry options does not split on their commas', () => {
    // The nested `[opened, closed]` must not be read as two more triggers.
    assert.deepEqual(
      workflowTriggers('name: x\non: {pull_request: {types: [opened, closed]}, push: null}\njobs:\n  a:\n'),
      ['pull_request', 'push']
    )
  })

  it('an anchor on the key line does not become the trigger', () => {
    assert.deepEqual(workflowTriggers('name: x\non: &triggers\n  pull_request:\njobs:\n  a:\n'), ['pull_request'])
  })

  it('quoted event names in a flow sequence are unquoted', () => {
    assert.deepEqual(workflowTriggers('name: x\non: ["push", \'pull_request\']\njobs:\n  a:\n'), [
      'push',
      'pull_request',
    ])
  })

  it('quoted event keys in the block form are unquoted', () => {
    assert.deepEqual(workflowTriggers('name: x\non:\n  "pull_request":\n  \'push\':\njobs:\n  a:\n'), [
      'pull_request',
      'push',
    ])
  })

  it('CONTROL: a workflow that genuinely has no pull_request trigger still reports none', () => {
    // Without this the fixes above could be satisfied by a function that
    // reports `pull_request` for everything — #7273's deny/accept-everything
    // shape, inverted.
    assert.ok(!pr('name: x\non:\n  schedule:\n    - cron: "0 9 * * *"\njobs:\n  a:\n'))
    assert.ok(!pr('name: x\n"on":\n  push:\n    tags: ["v*"]\njobs:\n  a:\n'))
    assert.ok(!pr('name: x\non: {push: null}\njobs:\n  a:\n'))
  })
})

describe('workflow reader: jobName edge cases from the #7643 review', () => {
  const nameOf = body => jobName(parseJobs(`name: probe\non: push\njobs:\n  probe:\n${body}\n`)[0])

  it('reads a name: declared AFTER steps:', () => {
    // YAML does not order mapping keys, and GitHub still uses the name. An
    // earlier version sliced the job body at `steps:` "for belt and braces" and
    // silently returned the job id here — redundancy that was actually a
    // regression.
    assert.equal(nameOf('    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n    name: Late Name'), 'Late Name')
  })

  it('strips a trailing YAML comment from an unquoted name', () => {
    // `name: Deploy Prod # temporary` is the context `Deploy Prod`. Reading the
    // comment as part of the name puts a string in the roster that branch
    // protection can never match — the #7191 family.
    assert.equal(nameOf('    name: Deploy Prod # temporary\n    runs-on: ubuntu-latest'), 'Deploy Prod')
  })

  it('does NOT strip a # that is inside a quoted name', () => {
    assert.equal(nameOf('    name: "Build #2"\n    runs-on: ubuntu-latest'), 'Build #2')
  })

  it('keeps a # that is not comment-shaped', () => {
    // No preceding whitespace, so YAML does not open a comment here.
    assert.equal(nameOf('    name: Build#2\n    runs-on: ubuntu-latest'), 'Build#2')
  })
})

/* ───────────────────────────────────────────────────────────────────────────
 * The cases below moved here with the invocation predicate they cover (#7661),
 * from `ci-scripts-tests-registration.test.js` where both lived while there was
 * one consumer. They are unchanged: a hoist that rewrites the tests as it moves
 * them cannot say whether the behaviour survived the move.
 * ─────────────────────────────────────────────────────────────────────────── */

describe('withoutHeredocBodies (#7645)', () => {
  const L = s => s.split('\n')

  it('CONTROL: a body with no heredoc is returned unchanged', () => {
    assert.deepEqual(withoutHeredocBodies(L('echo a\nbash x.test.sh')), ['echo a', 'bash x.test.sh'])
  })

  it('blanks the body and keeps the lines around it', () => {
    assert.deepEqual(
      withoutHeredocBodies(L('cat <<EOF\nbash x.test.sh\nEOF\nbash y.test.sh')),
      ['cat <<EOF', '', '', 'bash y.test.sh']
    )
  })

  it('honours a QUOTED terminator', () => {
    assert.deepEqual(withoutHeredocBodies(L("cat <<'EOF'\nbash x.test.sh\nEOF")), ["cat <<'EOF'", '', ''])
  })

  it('strips leading TABS before the terminator only for `<<-`', () => {
    assert.deepEqual(withoutHeredocBodies(L('cat <<-EOF\nbash x.test.sh\n\t\tEOF\nafter')), ['cat <<-EOF', '', '', 'after'])
    // Plain `<<` does NOT strip tabs, so an indented terminator does not end
    // the body — the strict direction, which blanks more rather than less.
    assert.deepEqual(withoutHeredocBodies(L('cat <<EOF\nbash x.test.sh\n\tEOF\nafter')), ['cat <<EOF', '', '', ''])
  })

  it('honours a DOUBLE-quoted terminator', () => {
    // Untested until review: the double-quoted branch of the delimiter had no
    // case, so two independent mutants that removed it survived.
    assert.deepEqual(withoutHeredocBodies(L('cat <<"EOF"\nbash x.test.sh\nEOF')), ['cat <<"EOF"', '', ''])
  })

  it('honours a BACKSLASH-quoted terminator — `<<\\EOF` is ordinary bash', () => {
    // The fail-open review found. `<<\EOF` is exactly equivalent to `<<'EOF'`
    // and is one of the two standard ways to write a literal heredoc. The
    // first delimiter grammar matched neither it nor a digit-leading word, so
    // the body was never opened and every line in it was handed back as a
    // live command — verified against real bash, which runs none of them.
    assert.deepEqual(withoutHeredocBodies(L('cat <<\\EOF\nbash x.test.sh\nEOF')), ['cat <<\\EOF', '', ''])
  })

  it('honours a DIGIT-LEADING delimiter — the shell takes any word', () => {
    assert.deepEqual(withoutHeredocBodies(L('cat <<1EOF\nbash x.test.sh\n1EOF')), ['cat <<1EOF', '', ''])
  })

  it('does not TRUNCATE a delimiter at a non-identifier character', () => {
    // `<<EOF-1` used to capture `EOF`, so a body line spelled `EOF` closed the
    // body early and every data line after it became a live command.
    assert.deepEqual(
      withoutHeredocBodies(L('cat <<EOF-1\nEOF\nbash x.test.sh\nEOF-1\nafter')),
      ['cat <<EOF-1', '', '', '', 'after']
    )
  })

  it('over-blanks rather than under-blanks on a `<<` that is not a heredoc', () => {
    // `$(( 1 << 2 ))` opens a body terminated by `2`, which never arrives, so
    // the rest is blanked. Stated because it is a real consequence of taking
    // the delimiter as a shell word: over-blanking reports a wired suite as an
    // ORPHAN, which is loud and the safe direction, and the alternative — a
    // narrower grammar — is the fail-open this case's neighbours document.
    assert.deepEqual(withoutHeredocBodies(L('x=$(( 1 << 2 ))\nbash y.test.sh')), ['x=$(( 1 << 2 ))', ''])
  })

  it('does NOT treat a here-STRING as a heredoc', () => {
    assert.deepEqual(
      withoutHeredocBodies(L('grep -q x <<< "$VAR"\nbash y.test.sh')),
      ['grep -q x <<< "$VAR"', 'bash y.test.sh']
    )
  })

  it('blanks to the END when the terminator never appears — loud, not quiet', () => {
    // The safe direction: an unterminated body hides invocations, which
    // reports a wired suite as an orphan rather than the reverse. This is the
    // shape `echo "body<<EOF" >> $GITHUB_OUTPUT` produces in release.yml.
    assert.deepEqual(withoutHeredocBodies(L('cat <<EOF\na\nb')), ['cat <<EOF', '', ''])
  })

  it('a terminator with trailing text does NOT end the body', () => {
    // Lenient matching would hand the remaining data lines back as commands.
    assert.deepEqual(withoutHeredocBodies(L('cat <<EOF\na\nEOF >> out\nbash x.test.sh')), ['cat <<EOF', '', '', ''])
  })
})

describe('heredocDelimiter (#7645)', () => {
  it('strips the three quoting forms the shell accepts, and nothing else', () => {
    assert.equal(heredocDelimiter('EOF'), 'EOF')
    assert.equal(heredocDelimiter("'EOF'"), 'EOF')
    assert.equal(heredocDelimiter('"EOF"'), 'EOF')
    assert.equal(heredocDelimiter('\\EOF'), 'EOF')
    assert.equal(heredocDelimiter('EOF-1'), 'EOF-1', 'a dash is part of the word, not quoting')
    assert.equal(heredocDelimiter('1EOF'), '1EOF')
  })
})

describe('invokes composes the passes in the right ORDER (#7645)', () => {
  const S = 'scripts/__tests__/merge-updater-feeds.test.sh'

  it('a data line that comment-stripping would TURN INTO the terminator does not close the body', () => {
    // Stripping comments first manufactured a terminator the shell never
    // sees: the shell ends a heredoc only on a line that is exactly `EOF`, so
    // this whole block is data and nothing runs — but `EOF # not the
    // terminator` strips to `EOF`, closed the body there, and handed
    // `bash <suite>` back as a live command. Measured WIRED before the fix.
    assert.ok(!invokes(`cat <<EOF\nEOF # not the terminator\nbash ${S}\nEOF`, S))
  })

  it('a heredoc START hidden in a comment blanks the rest — over-blanking, the safe direction', () => {
    // The cost of the reversed order, stated rather than hidden. The shell
    // sees a comment and no heredoc; this sees a heredoc that never
    // terminates. It reports a wired suite as an orphan: loud.
    assert.ok(!invokes(`echo hi  # cat <<EOF\nbash ${S}`, S))
  })

  it('CONTROL: an ordinary commented-out invocation is still stripped, not blanked', () => {
    assert.ok(!invokes(`# bash ${S}\necho skipped`, S))
    assert.ok(invokes(`# bash ${S} --old\nbash ${S}`, S))
  })
})

describe('isCommandPosition rejects no-exec flags (#7645)', () => {
  const S = 'scripts/__tests__/merge-updater-feeds.test.sh'
  const reads = line => invokes(line, S)

  it('CONTROL: the two spellings this repo actually uses still count', () => {
    assert.ok(reads(`bash ${S}`))
    assert.ok(reads(`node ${S}`))
    assert.ok(reads(`bash ./${S}`))
    assert.ok(reads(`./${S}`))
    assert.ok(reads(`out=$(bash ${S})`))
  })

  for (const line of [
    `bash -n ${S}`,
    `sh -n ${S}`,
    `zsh -n ${S}`,
    `bash --norc -n ${S}`,
    `node --check ${S}`,
    `node --help ${S}`,
    `node --version ${S}`,
    `bash -c "echo hi" ${S}`,
  ]) {
    it(`rejects \`${line.replace(S, '<suite>')}\``, () => {
      assert.ok(!reads(line), 'a flag that stops the interpreter executing the file is not an invocation')
    })
  }

  it('rejects an UNKNOWN flag too — the allowlist is empty by design', () => {
    // A future `node --test <suite>` is reported as an orphan: a false
    // positive, loud, and fixed by adding the flag with the reason it
    // preserves execution. Predicting a shell is unwinnable (#7341), so the
    // guard cries wolf rather than guessing.
    assert.ok(!reads(`node --test ${S}`))
    assert.ok(!reads(`bash -x ${S}`))
  })
})

describe('workflow reader: jobTimeout (#7661)', () => {
  /** The single job parsed out of a synthetic one-job workflow. */
  const timeoutOf = body => jobTimeout(parseJobs(`name: probe\non: push\njobs:\n  probe:\n${body}\n`)[0])

  it('reads the job-level budget', () => {
    assert.equal(timeoutOf('    runs-on: ubuntu-latest\n    timeout-minutes: 10'), 10)
  })

  it('is undefined when the job declares none — that is six hours, not zero', () => {
    assert.equal(timeoutOf('    runs-on: ubuntu-latest'), undefined)
  })

  it('does NOT read a STEP timeout as the job budget', () => {
    // The dangerous direction: a step's own two-minute cap standing in for a
    // job's five would let a rule that floors the job budget pass on the wrong
    // number entirely. Steps sit at six spaces; the anchor is four.
    assert.equal(
      timeoutOf('    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n        timeout-minutes: 2'),
      undefined
    )
  })

  it('does NOT read a commented-out budget as configuration', () => {
    assert.equal(timeoutOf('    runs-on: ubuntu-latest\n    # timeout-minutes: 30'), undefined)
  })

  it('strips a trailing comment, per YAML', () => {
    assert.equal(timeoutOf('    runs-on: ubuntu-latest\n    timeout-minutes: 5  # lint tier'), 5)
  })

  it('is NaN for a value that is not a number — which fails every floor', () => {
    // Not a throw and not undefined. Undefined means "six hours" to every
    // consumer, so an unreadable value would silently clear any budget floor;
    // NaN fails every `>=` comparison there is, so it goes red at the consumer
    // without anyone having to remember this case.
    assert.ok(Number.isNaN(timeoutOf('    runs-on: ubuntu-latest\n    timeout-minutes: five')))
    assert.equal(Number.isNaN(timeoutOf('    runs-on: ubuntu-latest\n    timeout-minutes: 5')), false)
  })
})

describe('workflow reader: maskQuotedData (#7661)', () => {
  it('CONTROL: an unquoted line is returned unchanged', () => {
    assert.equal(maskQuotedData('npm ci && npm run build'), 'npm ci && npm run build')
  })

  it('preserves length, so positions in the mask still index the original', () => {
    for (const line of ['echo "a b" c', "x='y' z", 'a `b` c', 'out="$(npm ci)"']) {
      assert.equal(maskQuotedData(line).length, line.length, line)
    }
  })

  it('masks single- and double-quoted text, quotes included', () => {
    assert.equal(maskQuotedData("echo 'npm ci'"), 'echo         ')
    assert.equal(maskQuotedData('echo "npm ci"'), 'echo         ')
  })

  it('masks a separator inside quotes — the whole reason this exists', () => {
    // Unmasked, the quoted `&&` cuts the line back to an empty segment, which
    // is exactly what a command-word test accepts. ci.yml's own lockfile error
    // message is this shape.
    assert.equal(maskQuotedData('echo "a && npm ci"'), 'echo              ')
  })

  it('leaves COMMAND SUBSTITUTION inside double quotes visible — it is code', () => {
    // Masking it would undercount, and undercounting is the silent direction
    // for anything that counts invocations.
    assert.equal(maskQuotedData('out="$(npm ci)"'), 'out= $(npm ci) ')
    assert.equal(maskQuotedData('out="`npm ci`"'), 'out= `npm ci` ')
  })

  it('a `\'` inside double quotes is data, not the start of a quote', () => {
    // repo-relay.yml says "repo-relay's dependency install failed". Treating
    // that apostrophe as an opening quote leaves the rest of the line masked.
    assert.equal(maskQuotedData(`echo "it's fine" && npm ci`), 'echo             && npm ci')
  })

  it('an escaped quote does not close the string', () => {
    assert.equal(maskQuotedData('echo "a \\" npm ci"'), 'echo              ')
  })

  it("`$'…'` is ANSI-C quoting, the one single-quoted form that honours escapes", () => {
    // `$'it\'s'` is ONE string to bash; the plain `'it\'s'` is a syntax error.
    // Without the special case the embedded `\'` closed the string, the next
    // `'` opened a fresh one, and the whole rest of the line was masked as
    // data — so a real `npm ci` after it read as QUOTED. Undercount, silent
    // (#7662 review, verified against real bash).
    assert.equal(maskQuotedData(String.raw`echo $'it\'s' && npm ci`), "echo $        && npm ci")
    assert.deepEqual(commandUses(String.raw`echo $'it\'s' && npm ci`, 'npm').map(u => u.kind), ['invocation'])
  })

  it("a BACKSLASH-escaped `$` before a quote is not ANSI-C — it is a literal dollar", () => {
    assert.deepEqual(commandUses(String.raw`echo \$'plain' && npm ci`, 'npm').map(u => u.kind), ['invocation'])
  })
})

describe('workflow reader: hasUnclosedQuoting (#7661)', () => {
  it('CONTROL: a balanced line is closed', () => {
    assert.equal(hasUnclosedQuoting('echo "a" \'b\' `c`'), false)
  })

  it('reports a quote left open — the per-line mask does not apply to the next line', () => {
    assert.equal(hasUnclosedQuoting('echo "a'), true)
    assert.equal(hasUnclosedQuoting("echo 'a"), true)
  })

  it('does NOT report a command substitution left open', () => {
    // Three lines in this repo's workflows are exactly this: `version=$(printf
    // '%s' "$COMMIT_MESSAGE" \` continued on the next line. Its continuation
    // really is shell code, which is how the mask reads it, so the model still
    // holds and flagging it would make the corpus control unusable.
    assert.equal(hasUnclosedQuoting('version=$(printf \'%s\' "$MSG" \\'), false)
  })
})

describe('workflow reader: stripShellComment is quote-aware (#7661)', () => {
  it('CONTROL: a real comment is still stripped, in both positions', () => {
    assert.equal(stripShellComment('# bash x.test.sh'), '')
    // One separating space survives, exactly as the regex this replaces left
    // it: the cut is at the whitespace character adjacent to the `#`, not at
    // the end of the command.
    assert.equal(stripShellComment('npm ci  # install'), 'npm ci ')
  })

  it('does NOT strip a `#` inside a quoted string', () => {
    // The live shape, from repo-relay.yml. The old stripper cut here, leaving
    // an unterminated quote and dropping the rest of the line — which for a
    // rule that COUNTS invocations is a silent undercount.
    const line = 'echo "::warning::… does not fail the job — see #7632." && npm ci'
    assert.equal(stripShellComment(line), line)
  })

  it('a `#` with no whitespace before it was never a comment', () => {
    assert.equal(stripShellComment('curl http://x/a#b'), 'curl http://x/a#b')
  })

  it('MASKING does not manufacture the whitespace that makes a `#` a comment', () => {
    // Masking replaces a quoted span with SPACES, so asking the masked line
    // "is there whitespace before this `#`" answers yes where the original had
    // a quote. Verified against real bash: `echo "x"#y && echo RAN` prints
    // `x#y` and then RAN — the `#` is inside a word, and the tail runs. The
    // first version of this cut the line at the `#` and lost `&& npm ci`
    // entirely, which is the undercount direction and silent.
    assert.equal(stripShellComment('echo "a"#b'), 'echo "a"#b')
    assert.equal(stripShellComment('echo "x"#y && npm ci'), 'echo "x"#y && npm ci')
    assert.deepEqual(commandUses('echo "x"#y && npm ci', 'npm').map(u => u.kind), ['invocation'])
    // …while a `#` that really does begin a word still starts a comment, and
    // one inside the quotes still does not.
    assert.equal(stripShellComment('echo "a" #b'), 'echo "a"')
    assert.equal(stripShellComment('echo "a #b"'), 'echo "a #b"')
  })
})

describe('workflow reader: commandUses (#7661)', () => {
  const kinds = (body, name = 'npm') => commandUses(body, name).map(u => u.kind)

  it('the command word itself is an invocation, and its arguments come back', () => {
    assert.deepEqual(commandUses('npm ci --omit=dev', 'npm'), [
      { kind: 'invocation', line: 'npm ci --omit=dev', args: ['ci', '--omit=dev'] },
    ])
  })

  it('accepts every spelling that really puts npm at a command position', () => {
    assert.deepEqual(kinds('cd packages/server && npm ci'), ['invocation'])
    assert.deepEqual(kinds('foo | npm ci'), ['invocation'])
    assert.deepEqual(kinds('out=$(npm ci)'), ['invocation'])
    assert.deepEqual(kinds('out="$(npm ci)"'), ['invocation'])
  })

  it('a mention inside a string is QUOTED, even behind a quoted separator', () => {
    assert.deepEqual(kinds('echo "run \'cd x && npm install\' first"'), ['quoted'])
  })

  it('a name with something in front of it is UNCLASSIFIED, never silently dropped', () => {
    // Nothing here decides whether `sudo` runs its operand. Guessing wrong in
    // the lenient direction is an invocation that vanishes, so the caller is
    // handed the shape and asked.
    assert.deepEqual(kinds('sudo npm ci'), ['unclassified'])
    assert.deepEqual(kinds('if x; then npm ci; fi'), ['unclassified'])
    assert.deepEqual(kinds('grep npm ci.yml'), ['unclassified'])
  })

  it('the name must be a whole word', () => {
    assert.deepEqual(kinds('node scripts/lint-workflow-npm-env.mjs'), [])
    assert.deepEqual(kinds('npmx ci'), [])
  })

  it('a shell comment and a heredoc body are not commands', () => {
    assert.deepEqual(kinds('# npm ci'), [])
    assert.deepEqual(kinds('cat <<EOF\nnpm ci\nEOF'), [])
  })

  it('every occurrence on a line is classified, not just the first', () => {
    assert.deepEqual(kinds('npm ci && npm run build'), ['invocation', 'invocation'])
  })

  it('an ESCAPED separator does not start a new command', () => {
    // `sudo\; npm ci` runs `sudo;` — a command not found — and never reaches
    // npm. Verified with `bash -x`. Before #7662's fix the escaped `;` cut the
    // line and `npm` read as the command word.
    assert.deepEqual(kinds(String.raw`sudo\; npm ci`), ['unclassified'])
  })
})

describe('workflow reader: an escaped separator is literal text (#7662)', () => {
  const S = 'scripts/__tests__/merge-updater-feeds.test.sh'

  it('CONTROL: the real separators still start a new command', () => {
    assert.ok(invokes(`echo hi && bash ${S}`, S))
    assert.ok(invokes(`echo hi ; bash ${S}`, S))
    assert.ok(invokes(`out=$(bash ${S})`, S))
  })

  for (const [label, line] of [
    ['backtick', 'echo \\`bash ' + S + '\\`'],
    ['semicolon', 'echo run this manually\\; bash ' + S],
    ['pipe', 'echo foo\\| bash ' + S],
    ['ampersand', 'echo foo\\& bash ' + S],
    ['paren', 'echo \\(bash ' + S + '\\)'],
  ]) {
    it(`an escaped ${label} does not make a mention into an invocation`, () => {
      // Each of these is one `echo` printing words, verified with `bash -x`;
      // the suite runs in none of them. The separator scan matched the
      // metacharacter regardless of the backslash, cut there, and left `bash `
      // as the segment — so an ORPHANED suite read as WIRED, which is the
      // registration guard's dangerous direction. Latent, not live: no
      // workflow spells one today.
      assert.ok(!invokes(line, S), 'an escaped separator is literal text, not a command boundary')
    })
  }
})

describe('workflow reader: assertEveryFileParsed (#7659, #7662)', () => {
  /** A file whose `text` declares `n` jobs and whose parse yielded `parsed`. */
  const file = (name, declared, parsed = declared, stepsPerJob = 1) => ({
    name,
    text: `jobs:\n${Array.from({ length: declared }, (_, i) => `  job${i}:\n    runs-on: ubuntu-latest`).join('\n')}\n`,
    jobs: Array.from({ length: parsed }, (_, i) => ({
      id: `job${i}`,
      steps: Array.from({ length: stepsPerJob }, () => ['      - run: echo hi']),
    })),
  })

  it('CONTROL: a set where every file parses is accepted', () => {
    assertEveryFileParsed([file('ci.yml', 22), file('release.yml', 7), file('stale.yml', 1)])
  })

  it('refuses a file that parsed FEWER jobs than it declares', () => {
    // The #7659 blind spot, measured on the real corpus while reviewing #7662:
    // misindenting one job id by a single space drops that whole file to zero
    // jobs. Every GLOBAL floor stays clear — ci.yml carries 22 of 34 jobs and
    // satisfies all of them alone — so the file silently contributes nothing.
    assert.throws(
      () => assertEveryFileParsed([file('ci.yml', 22), file('nightly.yml', 1, 0)]),
      /yields a different number of jobs than it declares/
    )
  })

  it('refuses a file that parsed MORE jobs than it declares', () => {
    // Equality, not a floor. A job with neither `runs-on:` nor `uses:` is one
    // GitHub rejects, so the two readings disagreeing in this direction means
    // the reader has invented a job rather than lost one.
    assert.throws(
      () => assertEveryFileParsed([file('ci.yml', 3, 4)]),
      /yields a different number of jobs than it declares/
    )
  })

  it('counts a reusable-workflow job, which has `uses:` where a normal job has `runs-on:`', () => {
    // No job in this repo is spelled this way today. Without the `uses:` half,
    // adding one would report the file as short by a job and go red for a
    // reason that has nothing to do with the reader.
    assertEveryFileParsed([
      { name: 'x.yml', text: 'jobs:\n  call:\n    uses: ./.github/workflows/y.yml\n', jobs: [{ id: 'call', steps: [['      - run: echo hi']] }] },
    ])
  })

  it('does not read a COMMENTED-OUT job key as a declaration', () => {
    assertEveryFileParsed([
      { name: 'x.yml', text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    # runs-on: was-moved\n', jobs: [{ id: 'a', steps: [['      - run: echo hi']] }] },
    ])
  })

  it('refuses a job that parsed with no steps at all', () => {
    // One level down from the file check, same argument: a job with no steps
    // contributes no run bodies, and every run-body rule then passes over an
    // empty set for it.
    assert.throws(
      () => assertEveryFileParsed([file('ci.yml', 2, 2, 0)]),
      /a job parsed with no steps at all/
    )
  })
})
