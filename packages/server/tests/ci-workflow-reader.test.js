import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseJobs, parseSteps, stepInput, code, stepRun, jobShell, jobName, workflowTriggers } from './helpers/workflow-reader.js'

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
