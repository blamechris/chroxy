import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  assertEveryFileContributes,
  assertReaderSane,
  valuelessKey,
  flowStep,
  readWorkflows,
  SETUP_NODE,
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
 *
 * ONE block is the exception, and says so where it sits: the #7659 sweep at
 * the end asserts a property OF the live corpus — that no single real file
 * can collapse without the shared control noticing — and that claim is about
 * how the real run bodies are distributed across the real files, which no
 * synthetic fixture can establish.
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

describe('workflow reader: the mask stays aligned past an ASTRAL character (#7665)', () => {
  // Copilot's finding. `[...line]` iterates CODE POINTS; the scan, `roles`, and
  // every index a caller carries in from `namePositions` are UTF-16 CODE UNITS.
  // One emoji made the mask a character shorter than its line, and from that
  // point on every position was off by one.
  const ROCKET = '\u{1F680}' // U+1F680, a surrogate pair: length 2, one code point

  it('CONTROL: the two lines differ only by the astral character', () => {
    // Without this the case below is satisfied by an ASCII line that was never
    // going to desync — the mutation has to be the emoji and nothing else.
    assert.equal(`echo "a" && npm ci`.length, 18)
    assert.equal(`echo "${ROCKET}" && npm ci`.length, 19, 'the emoji is two code units wide')
  })

  it('the masked line is the same LENGTH as its input', () => {
    for (const line of [`echo "${ROCKET}" && npm ci`, `npm ci # ${ROCKET}`, `echo '${ROCKET}${ROCKET}'`]) {
      assert.equal(maskQuotedData(line).length, line.length, line)
    }
  })

  it('an npm AFTER an astral character is still an invocation, not a quoted mention', () => {
    // The bug in the direction that matters: the offset masked the unquoted
    // `&&`, the segment before `npm` stopped being empty, and a real resolve
    // read as prose. `commandUses` returned `quoted` — a resolve that vanishes.
    assert.deepEqual(commandUses(`echo "${ROCKET}" && npm ci`, 'npm').map(u => u.kind), ['invocation'])
    assert.deepEqual(commandUses(`echo "${ROCKET}" && npm ci`, 'npm')[0].args, ['ci'])
    // …and one genuinely inside the string is still masked.
    assert.deepEqual(commandUses(`echo "${ROCKET} npm ci"`, 'npm').map(u => u.kind), ['quoted'])
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
      { kind: 'invocation', line: 'npm ci --omit=dev', args: ['ci', '--omit=dev'], argsComplete: true },
    ])
  })

  it('the other two buckets report their arguments as INCOMPLETE, not as absent', () => {
    // Nothing parsed the arguments of a mention inside a string or of a name
    // behind `sudo`, so `args: []` there is "not read", not "none". `false` is
    // what makes a caller who reads the flag without reading the docblock fail
    // loudly rather than quietly treat an unparsed line as an empty one.
    for (const line of ['echo "npm ci"', 'sudo npm ci']) {
      assert.deepEqual(
        commandUses(line, 'npm').map(u => u.argsComplete),
        [false],
        line
      )
    }
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

describe('workflow reader: arguments are read as the SHELL splits them (#7663)', () => {
  const args = body => commandUses(body, 'npm')[0].args
  const complete = body => commandUses(body, 'npm')[0].argsComplete
  const kindsOf = (body, name = 'npm') => commandUses(body, name).map(u => u.kind)

  it('a QUOTED argument is READ, not masked away', () => {
    // The #7663 bug. `argWords` read the MASKED line, where a quoted span is
    // spaces, so a quoted argument was indistinguishable from an absent one:
    // this returned `['build']` and the caller saw `npm build`.
    assert.deepEqual(args("npm 'run' build"), ['run', 'build'])
    assert.deepEqual(args('npm "run" build'), ['run', 'build'])
    assert.deepEqual(args('npm "ci"'), ['ci'])
    // `$'…'` is quoting too, and the `$` belongs to the syntax rather than to
    // the word — bash passes `run`, not `$run`.
    assert.deepEqual(args(String.raw`npm $'run' build`), ['run', 'build'])
  })

  it('a quote does not END a word — `a`b is one argument', () => {
    // Verified with `printf '%s\n'`: `npm 'c'i` names the subcommand `ci`.
    // Splitting at the quote instead would report `c`, which no classifier
    // will ever recognise.
    assert.deepEqual(args("npm 'c'i"), ['ci'])
    assert.deepEqual(args('npm r"un" build'), ['run', 'build'])
  })

  it('a separator INSIDE an argument does not end the command', () => {
    // The half that masking got right and raw reading would get wrong: this is
    // one invocation with two arguments, not `npm run` followed by `b`. Reading
    // the raw line would cut at the quoted `&&` and truncate the list.
    assert.deepEqual(args(`npm run 'a && b'`), ['run', 'a && b'])
    assert.equal(complete(`npm run 'a && b'`), true)
    assert.deepEqual(kindsOf('echo "a && npm ci"'), ['quoted'])
  })

  it('an UNQUOTED separator still ends it', () => {
    assert.deepEqual(args('npm ci && npm run build'), ['ci'])
    assert.deepEqual(args('npm ci; echo done'), ['ci'])
    assert.deepEqual(args('npm ci | tee log'), ['ci'])
  })

  it('a substitution the command sits INSIDE ends at its closing paren', () => {
    // `out=$(npm ci)` used to yield `['ci)']`, which counted as a resolve only
    // because no denylist contains `ci)` — the same "wrong, but wrong safely"
    // the quoted subcommand was.
    assert.deepEqual(args('out=$(npm ci)'), ['ci'])
    assert.deepEqual(args('out="$(npm run build)"'), ['run', 'build'])
    assert.deepEqual(args('out=`npm ci`'), ['ci'])
  })

  it('a LINE CONTINUATION is an escape, not an argument, and the list is INCOMPLETE', () => {
    // The other half of #7663. The trailing backslash used to come back as the
    // word `\`, which counted as a resolve by luck: `\` is in no denylist. Now
    // it produces no word at all, and `argsComplete` says why the list is
    // short — the rest of the command is on the next line, which this per-line
    // reader never sees.
    assert.deepEqual(args('npm \\\nci'), [])
    assert.equal(complete('npm \\\nci'), false)
    // The words that WERE read are still accurate; only the tail is missing.
    assert.deepEqual(args('npm ci \\\n--omit=dev'), ['ci'])
    assert.equal(complete('npm ci \\\n--omit=dev'), false)
    assert.deepEqual(args('npm --silent \\\nrun build'), ['--silent'])
    assert.equal(complete('npm --silent \\\nrun build'), false)
  })

  it('an argument PRODUCED by a substitution cannot be read, and says so', () => {
    // `npm $(pick) ci` — nothing static knows what `pick` prints. The words
    // stop at the `(`, and the flag is what keeps "unreadable" from looking
    // like "there was nothing there".
    assert.equal(complete('npm $(pick) ci'), false)
    assert.equal(complete('npm `pick` ci'), false)
    // …while a substitution AFTER a real separator ends the command normally.
    assert.equal(complete('npm ci; echo $(date)'), true)
  })

  it('an unclosed quote leaves the list incomplete too', () => {
    // The per-line model does not apply to a string that closes on the next
    // line, and `hasUnclosedQuoting` reports that for the line as a whole. An
    // invocation on such a line inherits it rather than claiming a full read.
    assert.equal(complete('npm ci "unterminated'), false)
  })

  it('a word the shell has not CLOSED is a fragment, and is not reported at all', () => {
    // #7663 one layer down. A word still being accumulated when the line ran
    // out is a prefix of the real word, not the word — and a caller comparing
    // it against a list of known subcommands would be classifying that prefix.
    // `npm 'ru` must answer "no subcommand", never `ru`.
    assert.deepEqual(args("npm 'ru"), [])
    assert.deepEqual(args('npm ru\\\nn build'), [])
    // A word CLOSED by whitespace before the continuation is a real word, so
    // the shape that actually occurs — a long command wrapped over lines —
    // still reads its subcommand and does not go red for no reason.
    assert.deepEqual(args('npm run \\\nbuild'), ['run'])
    assert.deepEqual(args('npm ci \\\n--omit=dev'), ['ci'])
  })

  it('an EMPTY quoted argument is a word, and holds its position', () => {
    // Found in review. `''` is entirely quoting syntax, so nothing was pushed
    // and no word was emitted — which SHIFTED every later argument one place
    // earlier. `npm '' run` then reported the subcommand `run`, a script run
    // the shell never performs: npm receives an empty first argument and
    // fails. Verified against bash, whose argv is ['', 'run'] for all three
    // spellings.
    assert.deepEqual(args("npm '' run"), ['', 'run'])
    assert.deepEqual(args('npm "" run'), ['', 'run'])
    assert.deepEqual(args(String.raw`npm $'' run`), ['', 'run'])
    // …and an empty argument AFTER the subcommand does not disturb it.
    assert.deepEqual(args("npm ci ''"), ['ci', ''])
  })

  it('an ANSI-C escape is OPAQUE, never its own escape letter', () => {
    // Found in review, and the sharper half. `$'…'` is the one quoted form
    // that DECODES escapes: bash passes `$'\t'` a tab byte and `$'ru\n'` the
    // three characters `ru` plus a newline. Reading the escape letter instead
    // reported `t` — npm's documented `test` alias — and `run`, both of which
    // a caller's non-resolving list contains. This reader does not implement
    // that grammar, so the character is marked opaque rather than guessed, and
    // the stand-in cannot equal any real subcommand.
    assert.deepEqual(args(String.raw`npm $'\t'`), ['�'])
    assert.deepEqual(args(String.raw`npm $'ru\n'`), ['ru�'])
    assert.deepEqual(args(String.raw`npm $'\x63i'`), ['�63i'])
    // The three escapes that stand for themselves ARE read literally — this is
    // the shape the workflows contain, and bash agrees the argument is `it's`.
    assert.deepEqual(args(String.raw`npm $'it\'s'`), ["it's"])
    // No escape, no opacity: `$'run'` really is the word `run`.
    assert.deepEqual(args(String.raw`npm $'run' build`), ['run', 'build'])
  })

  it('CONTROL: an ordinary invocation is COMPLETE, so the flag is not always false', () => {
    // Without this the cases above are satisfied by `argsComplete: false`
    // everywhere, which reads as "nothing is ever legible" and would make a
    // caller that fails safe on the flag fail safe on all 57 live invocations.
    for (const body of ['npm ci', 'npm run build', 'npm', "npm 'run' build", 'out=$(npm ci)']) {
      assert.equal(complete(body), true, body)
    }
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
  const STEP = '      - run: echo hi'
  /**
   * A file whose `text` declares `n` jobs and whose parse yielded `parsed`.
   *
   * The steps are emitted into the TEXT as well as into `jobs`, GENERATED FROM
   * THE SAME `stepsPerJob` rather than typed, because since #7668 the function
   * reads the text for a second, independent count of the steps each file
   * declares. Before that these fixtures carried no steps in their text at all
   * and every one of them went red the moment the row landed — a fixture out of
   * step with the shape the subject is handed.
   */
  const file = (name, declared, parsed = declared, stepsPerJob = 1) => ({
    name,
    text:
      `jobs:\n${Array.from(
        { length: declared },
        (_, i) =>
          `  job${i}:\n    runs-on: ubuntu-latest\n    steps:\n` +
          Array.from({ length: stepsPerJob }, () => STEP).join('\n')
      ).join('\n')}\n`,
    jobs: Array.from({ length: parsed }, (_, i) => ({
      id: `job${i}`,
      steps: Array.from({ length: stepsPerJob }, () => [STEP]),
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

  it('counts a reusable-workflow `uses:` as a JOB and not also as a step (#7668)', () => {
    // The reusable-workflow spelling is the one place the same key means a job
    // at one indent and a step at another, so ONE fixture has to reach both
    // halves — the jobs row's `^ {4}(?:runs-on|uses):`, without which adding
    // such a job reports the file short by one, and the step row's negation of
    // exactly that indent, without which the same line also declares a step for
    // a job that has none. Mutating EITHER alone turns this case red.
    //
    // It was two cases with byte-identical fixtures and assertions until review
    // of #7671 measured that the second added no coverage. A duplicate case is
    // not neutral: it reads as two independent proofs and is one.
    //
    // The `steps:` block used to be a FICTION here — a real reusable-workflow
    // job has no steps at all, and the old blanket stepless rule refused it, so
    // the case for the reusable spelling had to be invalid YAML for the very
    // spelling it was named for. #7672 replaced that rule with an equality, so
    // the fixture is now the real shape.
    assertEveryFileParsed([
      {
        name: 'x.yml',
        text: 'jobs:\n  call:\n    uses: ./.github/workflows/y.yml\n',
        jobs: [{ id: 'call', steps: [] }],
      },
    ])
  })

  it('a reusable-workflow job that yielded steps is refused — by the STEP-COUNT row, not this one', () => {
    // Measured, and worth pinning because the equality's own comment would
    // otherwise imply this direction is its to catch. It is not: a `uses:` job
    // yielding a step makes parsed steps exceed what the text declares, and the
    // step-count row runs first and says so. The direction the stepless
    // equality UNIQUELY owns is the other one — a normal job with no steps.
    assert.throws(
      () =>
        assertEveryFileParsed([
          {
            name: 'x.yml',
            text: 'jobs:\n  call:\n    uses: ./.github/workflows/y.yml\n',
            jobs: [{ id: 'call', steps: [['      - run: echo hi']] }],
          },
        ]),
      /yields a different number of steps than its text declares/
    )
  })

  it('DISCLOSED BLIND SPOT: a swap between two jobs keeps every per-file total intact', () => {
    // The limitation all three per-file rows share, pinned here because this is
    // where it is easiest to construct. The reader attributes the normal job's
    // step to the reusable one: jobs 2 = 2, steps 1 = 1, stepless 1 = reusable
    // 1. Every total agrees and the attribution is wrong.
    //
    // Guarding it needs a per-JOB declared count, which means deciding which
    // text lines belong to which job — the traversal `parseJobs` already does,
    // and deriving the expectation from it would be the
    // "expectation computed from its own subject" cause. Pinned GREEN
    // deliberately: this asserts CURRENT behaviour. If it ever goes red,
    // someone has closed it and this case should be inverted.
    assertEveryFileParsed([
      {
        name: 'x.yml',
        text:
          'jobs:\n  call:\n    uses: ./.github/workflows/y.yml\n' +
          '  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
        jobs: [{ id: 'call', steps: [['      - run: echo hi']] }, { id: 'a', steps: [] }],
      },
    ])
  })

  it('a normal job with no steps is still refused, in a file that ALSO has a reusable one (#7672)', () => {
    // The reason the rule is an equality rather than an exemption. Under a
    // floor, one legitimate `uses:` job would license a normal stepless job in
    // the same file — the widening this change must not introduce.
    assert.throws(
      () =>
        assertEveryFileParsed([
          {
            name: 'x.yml',
            text: 'jobs:\n  call:\n    uses: ./.github/workflows/y.yml\n  a:\n    runs-on: ubuntu-latest\n',
            jobs: [{ id: 'call', steps: [] }, { id: 'a', steps: [] }],
          },
        ]),
      /different number of step-less jobs than it declares reusable-workflow calls/
    )
  })

  it('a file with a reusable job AND a normal job with steps is accepted (#7672)', () => {
    // The mixed CONTROL. Without it the two cases above would both pass on a
    // rule that simply refused every file containing a `uses:` job.
    assertEveryFileParsed([
      {
        name: 'x.yml',
        text:
          'jobs:\n  call:\n    uses: ./.github/workflows/y.yml\n' +
          '  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
        jobs: [{ id: 'call', steps: [] }, { id: 'a', steps: [['      - run: echo hi']] }],
      },
    ])
  })

  it('does not read a COMMENTED-OUT job key as a declaration', () => {
    // The ANCHOR does this, not a comment filter. `^ {4}` requires the fifth
    // character to be `r` or `u`, and a comment line has its `#` at or before
    // the fourth. A `code()` call sat here until a #7672 mutation sweep proved
    // it inert — this case stayed green with the filter deleted, and goes red
    // when the anchor is dropped, which is the mutation that reaches the
    // mechanism actually in use.
    assertEveryFileParsed([
      {
        name: 'x.yml',
        text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    # runs-on: was-moved\n    steps:\n      - run: echo hi\n',
        jobs: [{ id: 'a', steps: [['      - run: echo hi']] }],
      },
    ])
  })

  it('refuses a job that parsed with no steps at all', () => {
    // One level down from the file check, same argument: a job with no steps
    // contributes no run bodies, and every run-body rule then passes over an
    // empty set for it.
    assert.throws(
      () => assertEveryFileParsed([file('ci.yml', 2, 2, 0)]),
      /different number of step-less jobs than it declares reusable-workflow calls/
    )
  })

  // --- flow-collection steps are REFUSED (#7669) ---------------------------

  it('refuses a step written as a YAML flow mapping, and says WHY', () => {
    // `- { run: echo hi }` is legal Actions YAML. `parseSteps` starts a step
    // for it, and every key-reading function anchors on `run:`/`uses:` at the
    // dash indent plus two and finds `{` there — so the step contributes to
    // nothing while looking like a step.
    //
    // The assertion on the MESSAGE is the point of this case. #7668's
    // step-count row already made such a file red (declared 1, parsed 2), so
    // the bare fact of redness proves nothing new. What this pins is that the
    // named cause speaks FIRST: "yields a different number of steps than its
    // text declares" sends a reader looking for a lost step rather than an
    // unreadable one, and it would vanish the day `declaredSteps` learns the
    // spelling.
    const text = ['jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo one', '      - { run: echo hi }', ''].join('\n')
    const jobs = parseJobs(text, 'x.yml')
    // The facts that MOTIVATE the refusal, asserted rather than left in prose.
    // Review of #7676 noted these lived only in comments once the flow entry
    // moved out of the "cannot SPELL" case, which is the shape this repo
    // catalogues as a comment describing something no test checks.
    assert.equal(jobs[0].steps.length, 2, 'parseSteps DOES start a step for it')
    assert.equal(stepRun(jobs[0].steps[1]), undefined, 'and every key-reader finds `{` where it expects a key')
    assert.throws(
      () => assertEveryFileParsed([{ name: 'x.yml', text, jobs }]),
      /a step is written as a YAML flow collection/
    )
  })

  it('refuses the flow SEQUENCE form too', () => {
    // Invalid for a step, unlike the mapping form — refused anyway, because a
    // reader that cannot decompose either should not let one through on a
    // technicality.
    const text = ['jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - [ run, echo hi ]', ''].join('\n')
    assert.throws(
      () => assertEveryFileParsed([{ name: 'x.yml', text, jobs: parseJobs(text, 'x.yml') }]),
      /a step is written as a YAML flow collection/
    )
  })

  it('refuses the spellings a first-line regex misses: tag, anchor, and wrapped to the next line', () => {
    // Review of #7676 measured that the first version of this predicate — a
    // regex over `stepLines[0]` — missed three spellings js-yaml parses
    // IDENTICALLY to the caught one. All three fell through to #7668's
    // step-count row, which is the incidental catch this refusal exists to
    // replace, so the guard was missing its own stated target on three of four
    // spellings while its comment claimed otherwise.
    const file = step => {
      const text = ['jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo one', ...step, ''].join('\n')
      return [{ name: 'x.yml', text, jobs: parseJobs(text, 'x.yml') }]
    }
    for (const [label, step] of [
      ['tag before the brace', ['      - !!map { run: echo hi }']],
      ['anchor before the brace', ['      - &a { run: echo hi }']],
      ['both', ['      - !!map &a { run: echo hi }']],
      ['wrapped to the next line', ['      - ', '        { run: echo hi }']],
    ]) {
      assert.throws(
        () => assertEveryFileParsed(file(step)),
        /a step is written as a YAML flow collection/,
        `${label} was not refused`
      )
    }
  })

  it('CONTROL: flowStep sees every flow shape and no ordinary step, so its empty result means something', () => {
    // #7669's third acceptance criterion, and the reason it is a criterion:
    // the corpus has ZERO flow steps, so the assertion in
    // `assertEveryFileParsed` quantifies over an empty set and would be
    // satisfied by a predicate that matches NOTHING — the #7503 cause in
    // docs/false-safety-guards.md. This exercises the predicate directly.
    for (const yes of [
      ['      - { run: echo hi }'],
      ['      - {run: x}'],
      ['      - [ a, b ]'],
      ['  - {  }'],
      ['      - !!map { run: echo hi }'],
      ['      - &a { run: echo hi }'],
      ['      - ', '        { run: echo hi }'],
      ['      - ', '        # a comment first', '        { run: echo hi }'],
    ]) {
      assert.ok(flowStep(yes), `expected a flow step: ${JSON.stringify(yes)}`)
    }
    for (const no of [
      ['      - run: echo hi'],
      ['      - uses: actions/checkout@v4'],
      ['      - name: thing', '        run: echo { not a step start }'],
      // Ubiquitous in the real corpus — a `${{ }}` expression must never be
      // read as a flow collection.
      ['      - run: echo ${{ github.sha }}'],
      // A brace LATER on the first content line. This is what makes the
      // predicate's anchoring load-bearing: review measured that dropping the
      // `^` from the old regex survived every assertion in the PR.
      ['      - run: cleanup - {tmp}'],
      // The #7668 absorbed-step shape is NOT a flow step — that row owns it.
      ['      - ', '        name: t'],
    ]) {
      assert.ok(!flowStep(no), `expected NOT a flow step: ${JSON.stringify(no)}`)
    }
  })

  it('the live corpus has no flow-collection step, and the predicate that says so is live', async () => {
    // The set-level half: a real reading, not a synthetic one — and the
    // predicate proven live against a planted positive in the same case, so
    // "zero found" cannot mean "nothing was looked at".
    const ws = await readWorkflows()
    assert.ok(ws.length >= 5, `expected >=5 workflow files, found ${ws.length}`)
    const steps = ws.flatMap(w => w.jobs.flatMap(j => j.steps))
    assert.ok(steps.length >= 100, `expected the corpus to carry many steps, found ${steps.length}`)
    assert.deepEqual(steps.filter(flowStep).map(st => st[0]), [])
    assert.ok(flowStep(['      - { run: echo hi }']), 'the predicate must still fire on a planted positive')
  })

  // --- the per-file STEP row (#7668) ---------------------------------------

  it('refuses a file whose step was ABSORBED into its neighbour (#7668)', () => {
    // The issue's fixture, driven through the real `parseJobs`. A step whose
    // keys sit on the line AFTER the dash is legal Actions YAML and identical
    // config to GitHub; `parseSteps` needs the space on the SAME line, so it
    // never starts a step and these lines are absorbed into the previous one.
    // js-yaml reads three steps here.
    const text = [
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      -',
      '        name: thing',
      '        uses: actions/setup-node@abc',
      '      - run: echo hi',
      '',
    ].join('\n')
    const set = [{ name: 'x.yml', text, jobs: parseJobs(text, 'x.yml') }]
    assert.equal(set[0].jobs[0].steps.length, 2, 'precondition: parseSteps absorbed one of the three')
    assert.throws(
      () => assertEveryFileParsed(set),
      /yields a different number of steps than its text declares/
    )
    // And the reason this row had to exist: BOTH content rows stay green on
    // the same input, by construction. The run half counts one body per step,
    // so absorbing a non-run step changes nothing; the setup half counts
    // LINES, and a merge never changes a line count.
    assertEveryFileContributes(set)
  })

  it('refuses a file that yielded MORE steps than its text declares', () => {
    // Equality, not a floor — the same argument the jobs row makes. A step
    // with neither `run:` nor `uses:` behind it is one the reader invented,
    // and a floor cannot see an invention.
    assert.throws(
      () => assertEveryFileParsed([{ ...file('x.yml', 1, 1, 1), jobs: [{ id: 'job0', steps: [[STEP], [STEP]] }] }]),
      /yields a different number of steps than its text declares/
    )
  })

  it('reports the step disagreement rather than the emptier `no steps at all`', () => {
    // The ordering between the two rules, and the reason they are not
    // redundant: when the text declares steps the parse did not produce, the
    // useful message names the disagreement. `steps.length === 0` says only
    // that a job is empty, which is true of a great many broken parses.
    assert.throws(
      () =>
        assertEveryFileParsed([
          {
            name: 'x.yml',
            text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
            jobs: [{ id: 'a', steps: [] }],
          },
        ]),
      /yields a different number of steps than its text declares/
    )
  })

  it('leaves `no steps at all` to catch a job whose text declares none either', () => {
    // The other half of that interaction, and what stops the step row from
    // being read as a replacement: it agrees at zero, so only the stepless
    // rule can refuse a job that yields nothing.
    assert.throws(
      () =>
        assertEveryFileParsed([
          {
            name: 'x.yml',
            text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n',
            jobs: [{ id: 'a', steps: [] }],
          },
        ]),
      /different number of step-less jobs than it declares reusable-workflow calls/
    )
  })

  it('does not read a job-level `defaults: run:` mapping head as a step key', () => {
    // A bare `run:` under `defaults:` is a mapping head, not a step. ci.yml
    // has 15 of them, so without this exclusion the live corpus reads 15 steps
    // over and the row is permanently red for a reason that is not the
    // reader's. Deleting the exclusion turns this case red.
    assertEveryFileParsed([
      {
        name: 'x.yml',
        text:
          'jobs:\n  a:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash\n' +
          '    steps:\n      - run: echo hi\n',
        jobs: [{ id: 'a', steps: [['      - run: echo hi']] }],
      },
    ])
  })

  it('finds the `defaults:` parent past a comment between the two keys', () => {
    // The exclusion reads the PARENT key, and a comment sitting between them
    // must not hide it — the same reason `runsOnOf` skips blanks and comments
    // rather than treating them as the end of a block. Without the skip the
    // previous line is the comment, the `run:` counts as a step, and this case
    // goes red.
    assertEveryFileParsed([
      {
        name: 'x.yml',
        text:
          'jobs:\n  a:\n    runs-on: ubuntu-latest\n    defaults:\n      # bash everywhere, see #1234\n' +
          '      run:\n        shell: bash\n    steps:\n      - run: echo hi\n',
        jobs: [{ id: 'a', steps: [['      - run: echo hi']] }],
      },
    ])
  })

  it('finds the `defaults:` parent when the key carries a TRAILING comment', () => {
    // `defaults: # bash everywhere` is legal YAML and this repo's style writes
    // trailing comments freely, but a bare `$` anchor does not match it, so the
    // `run:` beneath counted as a step and the file went RED at declared+1.
    // Measured before the fix: declared 2, parsed 1. The `(?:#.*)?$` allowance
    // is the one `parseJobs` already uses on a job-id line (#7499) — the same
    // hole, found once and not swept for siblings. Caught in review of #7671,
    // not in writing it.
    assertEveryFileParsed([
      {
        name: 'x.yml',
        text:
          'jobs:\n  a:\n    runs-on: ubuntu-latest\n    defaults: # bash everywhere\n' +
          '      run:\n        shell: bash\n    steps:\n      - run: echo hi\n',
        jobs: [{ id: 'a', steps: [['      - run: echo hi']] }],
      },
    ])
  })

  it('does not read a COMMENTED-OUT step key as a declaration', () => {
    // The ANCHOR does this, not a comment filter: `^` forces the first
    // non-space character to be `-`, `r` or `u`, and a comment's is `#`. A
    // `code()` call here could not change a count, which is precisely the
    // INERT filter review of #7666 found and deleted on the run side. Dropping
    // the `^` turns this case red, which is the mutation that reaches the
    // mechanism in use.
    assertEveryFileParsed([
      {
        name: 'x.yml',
        text:
          'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n' +
          '      # - run: echo removed in #1234\n      - uses: actions/checkout@v4\n' +
          '        # was: uses: actions/setup-node@abc\n',
        jobs: [{ id: 'a', steps: [['      - uses: actions/checkout@v4', '        # was: uses: actions/setup-node@abc']] }],
      },
    ])
  })

  it('counts a step whose `run:` value is on the NEXT line — the row is VALUE-AGNOSTIC (#7670)', () => {
    // The reason this row does not reuse `assertEveryFileContributes`'s
    // `RUN_KEY`, which requires a value after the colon. To YAML this is one
    // real step whose value is `echo hi`; only the BODY is lost, and the step
    // count really is 1. Requiring a value here would report 0 against 1 and
    // go red for the wrong quantity — a guard wrong about its own subject on a
    // legal spelling. The two rows disagree about this file DELIBERATELY, and
    // the case asserts both halves so the disagreement cannot drift silently.
    const text = [
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: thing',
      '        run:',
      '          echo hi',
      '',
    ].join('\n')
    const set = [{ name: 'x.yml', text, jobs: parseJobs(text, 'x.yml') }]
    assertEveryFileParsed(set)
    // Pinned as the known false GREEN it is over there (#7670), not as
    // desired behaviour.
    assertEveryFileContributes(set)
  })

  it('a file with no jobs declares zero steps and yields zero, and needs no exemption', () => {
    // The legitimate zero, and it is weaker evidence than the run row's: no
    // live workflow exercises it, because every file here that has a job has
    // steps. Held to zero all the same, in both directions.
    const bare = { name: 'x.yml', text: 'name: nothing\non: push\njobs:\n', jobs: [] }
    assertEveryFileParsed([bare])
    assert.throws(
      () => assertEveryFileParsed([{ ...bare, jobs: [{ id: 'a', steps: [[STEP]] }] }]),
      /yields a different number of jobs than it declares/
    )
  })

  it('FALSE RED, pinned: a step key the declared side cannot SPELL reads as zero declared', () => {
    // The `parsed > declared` direction, and the reason this row's comment does
    // NOT repeat the jobs row's "means an invented step". Each of these is a
    // real step to YAML that the declared side cannot match, so the file goes
    // red at declared 0 — fail-closed and legible, but for the opposite reason
    // to an invention. Measured on real `parseJobs` output; `- { run: … }` is
    // tracked as #7669. If any of these ever goes GREEN, someone has taught the
    // declared side the spelling and the comment must move with it.
    // The flow-mapping spelling was a third entry here until #7669 gave it its
    // OWN refusal, which fires first and names the cause. That is the intended
    // succession, not a regression: this case pins the spellings the declared
    // side cannot READ, and a flow step is one the reader cannot DECOMPOSE at
    // all — a different fact deserving a different message.
    for (const [label, step, parsed] of [
      ['quoted key', '      - "run": echo hi', 1],
      ['space before the colon', '      - run : echo hi', 1],
    ]) {
      const text = ['jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', step, ''].join('\n')
      const jobs = parseJobs(text, 'x.yml')
      assert.equal(jobs[0].steps.length, parsed, `precondition: parseSteps still starts a step for ${label}`)
      assert.throws(
        () => assertEveryFileParsed([{ name: 'x.yml', text, jobs }]),
        /yields a different number of steps than its text declares/,
        `${label} did not go red`
      )
    }
  })

  it('FALSE RED, pinned: a mapping key named `run` outside a step inflates the declared count', () => {
    // The exclusion list is the two the LIVE CORPUS needs, not every place a
    // key can be spelled `run` or `uses`. A job-level `env:` variable named
    // `run` is legal — env names are free-form — and reads as a declaration.
    // Fails CLOSED, nothing in the corpus is spelled this way, and guarding it
    // would mean growing a notion of "which mapping am I in" on the declared
    // side, which is the drift this module exists to prevent.
    const text = [
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    env:',
      '      run: /some/path',
      '    steps:',
      '      - run: echo hi',
      '',
    ].join('\n')
    assert.throws(
      () => assertEveryFileParsed([{ name: 'x.yml', text, jobs: parseJobs(text, 'x.yml') }]),
      /yields a different number of steps than its text declares/
    )
  })

  it('FALSE RED, pinned: a step-key-shaped line inside a block scalar BODY inflates the declared count', () => {
    // Not a defect being fixed — a disclosed limit being pinned, the same one
    // `assertEveryFileContributes` carries for run bodies. The declared side
    // has no notion of "inside a block scalar", so a heredoc that writes YAML
    // counts as a second step. It fails CLOSED, nothing in the corpus is
    // spelled this way, and the alternative is a second block-scalar parser on
    // the declared side — the drift this module exists to prevent. If this
    // case ever starts PASSING, someone has made the declared side body-aware
    // and the comment in `assertEveryFileParsed` must move with it.
    const text = [
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: |',
      '          cat > out.yml <<EOF',
      '          - uses: actions/checkout@v4',
      '          EOF',
      '',
    ].join('\n')
    assert.throws(
      () => assertEveryFileParsed([{ name: 'x.yml', text, jobs: parseJobs(text, 'x.yml') }]),
      /yields a different number of steps than its text declares/
    )
  })
})

describe('workflow reader: assertEveryFileContributes (#7659)', () => {
  /**
   * A file whose TEXT declares `declared` run steps and whose PARSE yielded
   * `yielded` of them. The two are separate parameters because that is the
   * whole subject: the guard compares a reading of the raw text against a
   * reading that walked jobs -> steps -> stepRun, and only a fixture that can
   * make them disagree can prove it notices.
   */
  const runFile = (name, declared, yielded = declared) => ({
    name,
    text:
      `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n` +
      Array.from({ length: declared }, () => '      - run: echo hi').join('\n') +
      '\n',
    jobs: [{ id: 'a', steps: Array.from({ length: yielded }, () => ['      - run: echo hi']) }],
  })

  it('CONTROL: a set where every file yields what it declares is accepted', () => {
    assertEveryFileContributes([runFile('ci.yml', 20), runFile('release.yml', 7)])
  })

  it('refuses a file that yielded FEWER run bodies than its text declares', () => {
    // The #7659 blind spot, measured on the real corpus: neutralising one
    // file's run keys leaves every GLOBAL floor clear, because ci.yml carries
    // 91 of the 137 run bodies and satisfies both of them alone. Five of the
    // repo's six run-carrying files collapse completely invisibly that way.
    assert.throws(
      () => assertEveryFileContributes([runFile('ci.yml', 20), runFile('nightly.yml', 3, 0)]),
      /yields a different number of `run:` bodies than its text declares/
    )
  })

  it('refuses a file that yielded MORE run bodies than its text declares', () => {
    // Equality, not a floor — the same argument `assertEveryFileParsed` makes
    // about jobs. A body with no `run:` line behind it is invented, and a
    // floor cannot see an invention.
    assert.throws(
      () => assertEveryFileContributes([runFile('ci.yml', 2, 3)]),
      /yields a different number of `run:` bodies than its text declares/
    )
  })

  it('a file with NO run steps needs no exemption, and stops being exempt the moment it grows one', () => {
    // `stale.yml` genuinely has zero run steps today. A roster of files
    // allowed to contribute nothing would be a hardcoded list beside a growing
    // set — the first cause in docs/false-safety-guards.md. Deriving the
    // expectation from the file's own text needs no roster: zero declared is
    // zero required, and the same file is held to one the day it declares one.
    assertEveryFileContributes([runFile('ci.yml', 20), runFile('stale.yml', 0)])
    assert.throws(
      () => assertEveryFileContributes([runFile('ci.yml', 20), runFile('stale.yml', 1, 0)]),
      /yields a different number of `run:` bodies than its text declares/
    )
  })

  it('does not read a job-level `defaults: run:` mapping as a run step', () => {
    // A bare `run:` key with no value is the head of the `defaults.run.shell`
    // mapping, not a step. ci.yml has 15 of them; counting those would put the
    // declared side 15 ahead of a perfectly healthy reader and make the guard
    // permanently red for a reason that is not the reader's.
    assertEveryFileContributes([
      {
        name: 'x.yml',
        text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - uses: actions/checkout@v4\n',
        jobs: [{ id: 'a', steps: [['      - uses: actions/checkout@v4']] }],
      },
    ])
  })

  it('does not read a COMMENTED-OUT run key as a declaration', () => {
    // The ANCHOR is what does this, not a comment filter: `RUN_KEY`'s `^`
    // forces the first non-space character to be `-` or `r`. Named precisely
    // because the first version of this case credited a `code()` call that a
    // mutation sweep then proved INERT on this side — the case stayed green
    // with the filter deleted. It goes red when the anchor is dropped, which
    // is the mutation that reaches the mechanism actually in use.
    assertEveryFileContributes([
      {
        name: 'x.yml',
        text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      # - run: echo removed in #1234\n      - uses: actions/checkout@v4\n',
        jobs: [{ id: 'a', steps: [['      - uses: actions/checkout@v4']] }],
      },
    ])
  })

  it('counts a run step whose body is EMPTY as not yielded', () => {
    // A `run: |` with nothing under it yields `''`. Requiring a NON-empty body
    // is what stops a branch degraded to returning the empty string from
    // vouching for itself — the same reason `assertReaderSane`'s block floor
    // rejects a body that is only newlines (#7658 review). The YAML is
    // degenerate and this repo has none, and the guard fails CLOSED on it.
    assert.throws(
      () =>
        assertEveryFileContributes([
          {
            name: 'x.yml',
            text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n',
            jobs: [{ id: 'a', steps: [['      - run: |']] }],
          },
        ]),
      /yields a different number of `run:` bodies than its text declares/
    )
  })

  it('refuses a file whose setup-node step the reader does not reach', () => {
    // The `>=15` global setup-node floor is the same shape as the run floors:
    // ci.yml carries 17 of the repo's 24, so dropping any ONE of the other
    // four files' setup-node steps leaves it clear. Measured: the global floor
    // catches the ci.yml collapse and is blind to all four others.
    assert.throws(
      () =>
        assertEveryFileContributes([
          {
            name: 'x.yml',
            text: `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${SETUP_NODE}abc\n`,
            jobs: [{ id: 'a', steps: [['      - uses: actions/checkout@v4']] }],
          },
        ]),
      /declares setup-node LINES the reader does not reach/
    )
  })

  it('does not read a COMMENTED-OUT setup-node reference as a declaration, on EITHER side', () => {
    // The setup-node half matches a SUBSTRING, so unlike the run half it has
    // no anchor to lean on and both of its readings run through `code()`. The
    // comment sits inside the STEP as well as in the text — which is how
    // `readWorkflows` really hands step lines over — so this one fixture
    // reaches both filters; dropping either one alone turns it red.
    const step = [
      '      - uses: actions/checkout@v4',
      `        # was: uses: ${SETUP_NODE}abc`,
    ]
    assertEveryFileContributes([
      {
        name: 'x.yml',
        text: `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${step.join('\n')}\n`,
        jobs: [{ id: 'a', steps: [step] }],
      },
    ])
  })

  it('refuses a file that yielded MORE setup-node lines than its text declares', () => {
    // The direction the setup-node half had NO case for. Review of #7666
    // mutated its `!==` to `>` — one-directional, blind to an invented step —
    // and BOTH suites stayed green, 251/251. The doc comment claimed equality
    // caught an invention; nothing proved it. That is the catalogue's
    // "roster checked in only ONE direction" cause, committed inside the PR
    // whose whole subject is that class.
    assert.throws(
      () =>
        assertEveryFileContributes([
          {
            name: 'x.yml',
            text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
            jobs: [{ id: 'a', steps: [[`      - uses: ${SETUP_NODE}abc`]] }],
          },
        ]),
      /declares setup-node LINES the reader does not reach/
    )
  })

  it('refuses a file that declares ZERO run steps but yielded one', () => {
    // The zero boundary of the same direction, and separately untested:
    // review exempted `declared === 0` rows from the filter and nothing went
    // red. Without this, "declares zero, so zero is required" — the argument
    // that replaces an exemption list — is only half enforced.
    assert.throws(
      () => assertEveryFileContributes([runFile('x.yml', 0, 1)]),
      /yields a different number of `run:` bodies than its text declares/
    )
  })

  it('FALSE RED, pinned: a `run:`-shaped line inside a block scalar BODY inflates the declared count', () => {
    // Not a defect being fixed — a disclosed limit being pinned, so it stays a
    // known property. The declared side has no notion of "inside a block
    // scalar", so a heredoc that writes YAML counts as a second declaration
    // while `stepRun` correctly reads it as data. It fails CLOSED, and the
    // alternative — a second block-scalar parser on the declared side — is the
    // drift this module exists to prevent. If this case ever starts FAILING,
    // someone has made the declared side body-aware, and the comment in
    // `assertEveryFileContributes` needs updating with it.
    const text = [
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: |',
      '          cat > out.yml <<EOF',
      '          run: this is data, not a key',
      '          EOF',
      '',
    ].join('\n')
    assert.throws(
      () => assertEveryFileContributes([{ name: 'x.yml', text, jobs: parseJobs(text, 'x.yml') }]),
      /yields a different number of `run:` bodies than its text declares/
    )
  })

  it("FALSE RED, pinned: an empty quoted scalar `run: ''` declares a key and yields nothing", () => {
    // The quoted sibling of the empty `run: |` case above. Both are degenerate
    // YAML, neither is in this repo, and both fail CLOSED — listed together in
    // the function's own limits paragraph so the pair cannot drift apart.
    const text = "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ''\n"
    assert.throws(
      () => assertEveryFileContributes([{ name: 'x.yml', text, jobs: parseJobs(text, 'x.yml') }]),
      /yields a different number of `run:` bodies than its text declares/
    )
  })

  it('a plain scalar whose value is on the NEXT line is a real run step, and BOTH sides see it (#7670)', () => {
    // THE INVERSION of a case that was pinned GREEN here for the opposite
    // reason, and the comment is kept long because the history is the point.
    //
    // It used to read: "the one place the two independent readings do not
    // hold". `stepRun` returned '' — its plain branch read only the remainder
    // of the KEY LINE — and the declared side skipped the key because it
    // required a value after the colon. Both encoded the same rule, nothing
    // after the colon means nothing, so they AGREED at zero and a file spelled
    // entirely this way would have collected the free pass stale.yml gets.
    // Agreement is not evidence where the two sides share a rule.
    //
    // #7670 removed the shared rule from both sides at once, which is the only
    // way to fix this class: `stepRun` folds the continuation, and the declared
    // side counts a bare `run:` key, with the `defaults:` mapping head excluded
    // by its PARENT rather than by the absence of a value. To YAML the value
    // here is `echo hi`, and now it is to this reader too.
    const text = [
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: thing',
      '        run:',
      '          echo hi',
      '',
    ].join('\n')
    const jobs = parseJobs(text, 'x.yml')
    assert.equal(stepRun(jobs[0].steps[0]), 'echo hi', 'the value really is on the next line')
    assertEveryFileContributes([{ name: 'x.yml', text, jobs }])
  })

  it('the two sides of that spelling now disagree when one of them breaks', () => {
    // The other half, and the reason the case above is not just a restatement
    // of the old one with a different assertion: agreement at ONE is only
    // evidence if disagreement is reachable. Yield a body the text does not
    // declare, and the row fires.
    const text = 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n'
    assert.throws(
      () =>
        assertEveryFileContributes([
          { name: 'x.yml', text, jobs: [{ id: 'a', steps: [['      - run:', '          echo hi']] }] },
        ]),
      /yields a different number of `run:` bodies than its text declares/
    )
  })

  it('a multi-line plain scalar FOLDS, the way YAML folds one (#7670)', () => {
    // Not a nicety — it is the difference between one command and two. YAML
    // joins the lines of a plain scalar with a space, so this step runs
    // `echo one echo two`, and a reader that joined with newlines would hand
    // the `bash -n` pass a script the runner never sees.
    //
    // This case is DELIBERATELY the weak one, and says so rather than
    // pretending otherwise: its assertion cannot tell real folding from a
    // naive `join(' ')`, and reverting `foldPlain` to `fold` leaves it green.
    // The folding guarantee lives two cases below, in the unequal-indent case
    // and its `>` CONTROL. An earlier version of this comment claimed
    // `fold()` was shared here — true when it was written and false three
    // cases later in the same file, which is the drift worth naming.
    const step = ['      - name: t', '        run:', '          echo one', '          echo two']
    assert.equal(stepRun(step), 'echo one echo two')
  })

  it('a PLAIN scalar folds unconditionally — indentation does NOT make a line literal (#7675 review)', () => {
    // The mistake this case exists for was mine, and it was the DRY instinct
    // applied one step too far: `keyBody` really is the same collection in both
    // scalar styles, so the first version shared `fold()` for the folding too.
    // It is not the same rule. A folded BLOCK scalar keeps a more-indented line
    // literal; a PLAIN scalar has no such rule and folds every break to a space.
    //
    // js-yaml says this step is the single line `if true; then echo hi fi`.
    // Sharing `fold()` returned the three-line form — so `bash -n` would have
    // validated a script the runner never receives, which is a false green in
    // the exact scenario `stepRun`'s own block comment names as the reason
    // folding matters at all.
    const step = ['      - name: t', '        run:', '          if true; then', '            echo hi', '          fi']
    assert.equal(stepRun(step), 'if true; then echo hi fi')
    // A blank line is still a newline in BOTH styles: n breaks become n-1.
    assert.equal(stepRun(['      - name: t', '        run:', '          echo one', '', '          echo two']), 'echo one\necho two')
  })

  it('a whitespace-preceded `#` ENDS a continued plain scalar (#7675 review, Copilot)', () => {
    // The single-line plain branch has stripped a trailing comment since #7383
    // ("`cache: npm # hosted-only` parses as `npm`"); the new continued branch
    // did not, so the comment landed in the body. Measured against js-yaml:
    // `run:` / `echo hi # note` is `echo hi`, and this returned
    // `echo hi # note`. Not cosmetic — the body goes to `bash -n` and to every
    // content-inspecting guard.
    const step = tail => ['      - name: t', '        run:', ...tail]
    assert.equal(stepRun(step(['          echo hi # note'])), 'echo hi')
    // And it leaks across the FOLD, which the single-line branch cannot show:
    assert.equal(stepRun(step(['          echo one', '          echo two # note'])), 'echo one echo two')
    // No whitespace before the `#` means no comment — YAML's rule, and the same
    // one `valuelessKey` encodes on the key side.
    assert.equal(stepRun(step(['          echo hi#note'])), 'echo hi#note')
    // A line that is ONLY a comment ends the scalar rather than folding in.
    assert.equal(stepRun(step(['          echo one', '          # done'])), 'echo one')
  })

  it('CONTROL: a folded `>` block DOES keep a more-indented line literal', () => {
    // The other half, and what makes the case above a statement about two
    // different rules rather than about one of them. If this ever folds flat,
    // someone has shared the plain rule back into the block branch and the
    // `>` scalars in release.yml start being read wrong.
    const step = ['      - name: t', '        run: >', '          echo one', '            deeper', '          echo two']
    assert.equal(stepRun(step), 'echo one\n  deeper\necho two')
  })

  it('a block header with a TRAILING COMMENT is still a block header (#7675 review)', () => {
    // The bare-`$` anchor #7673 swept out of every KEY position, surviving on
    // the VALUE side. `run: | # c` is legal YAML whose value is `echo hi`;
    // `stepRun` fell through to the plain catch-all and returned the literal
    // `"|"`. Measured: `| # c` -> "|", `|- # c` -> "|-", `>+ # c` -> ">+".
    //
    // `>+` is the dangerous one: it is a VALID bash line — a redirect to a file
    // named `+` — so `bash -n` passes it and a content-inspecting guard reads
    // ">+" instead of the script. The other two are syntax errors, which fail
    // loudly. Pre-existing, not introduced by #7670, and fixed here because the
    // grammar is now shared with `runHeadSpelling`, which already accepted the
    // comment — the two disagreed while a comment claimed they mirrored.
    for (const head of ['| # c', '|- # c', '>+ # c', '|2 # c']) {
      const step = ['      - name: t', `        run: ${head}`, '          echo hi']
      assert.equal(stepRun(step), 'echo hi', `block header ${JSON.stringify(head)}`)
    }
  })

  it('a `run:` key that really carries nothing still yields the empty string', () => {
    // The boundary the new branch must not swallow: `keyBody` returns no lines,
    // `fold([])` is '', and the empty-body false red below still fires. Without
    // this, "nothing after the colon" and "nothing at all" could drift apart.
    assert.equal(stepRun(['      - name: t', '        run:']), '')
    assert.throws(
      () =>
        assertEveryFileContributes([
          {
            name: 'x.yml',
            text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run:\n',
            jobs: [{ id: 'a', steps: [['      - run:']] }],
          },
        ]),
      /yields a different number of `run:` bodies than its text declares/
    )
  })
})

describe('workflow reader: no single real file can collapse invisibly (#7659)', () => {
  /**
   * The one block in this file that drives the REPO'S OWN workflows rather
   * than synthetic YAML, and it is deliberate. Every other test here pins a
   * spelling the directory does not use, because a shape no repo-scanning
   * guard ever meets is the one it cannot prove it handles. This asserts the
   * opposite kind of fact — a property OF the live corpus, that no one file's
   * collapse is invisible to the shared control — and synthetic input cannot
   * establish it, because the whole claim is about how the real 137 run bodies
   * are distributed across the real seven files.
   *
   * The collapse is applied to the PARSED side only, leaving each file's text
   * untouched: every step's `run:` key is renamed, so `stepRun` finds nothing
   * while the declared count is unchanged. That is the exact failure #7659
   * describes — jobs present, steps present, run bodies gone — and it is the
   * one `assertEveryFileParsed` structurally cannot see, which each case
   * re-checks rather than assumes.
   */
  let workflows
  before(async () => {
    workflows = await readWorkflows()
  })

  const yieldsRunBodies = w =>
    w.jobs
      .flatMap(j => j.steps)
      .some(s => {
        const body = stepRun(s)
        return typeof body === 'string' && body.length > 0
      })

  const withRunKeysNeutralised = (ws, target) =>
    ws.map(w =>
      w.name !== target
        ? w
        : {
            ...w,
            jobs: w.jobs.map(j => ({
              ...j,
              steps: j.steps.map(s => s.map(l => l.replace(/^(\s*(?:-\s+)?)run:/, '$1xun:'))),
            })),
          }
    )

  /**
   * The files the reader currently yields at least one run body for — derived
   * from the corpus on every run rather than listed, and FLOORED HERE rather
   * than in one of the cases.
   *
   * The floor lived in the CONTROL case first, and review of #7666 showed why
   * that is not good enough: with `stepRun` mutated to return `undefined`,
   * `carriers` came back empty, the sweep below ran ZERO iterations and
   * reported ok while its siblings went red. The file verdict was still red,
   * so nothing escaped — but a case that reports success over zero cases is
   * catalogue entry 32, and it was sitting inside the case written to prove a
   * sweep fires. A case must not depend on a sibling for its own
   * non-vacuity. Six of seven files carry run bodies today (all but stale.yml).
   */
  const carriersOf = ws => {
    const carriers = ws.filter(yieldsRunBodies).map(w => w.name)
    assert.ok(
      carriers.length >= 5,
      `expected >=5 workflow files to yield run bodies, found ${carriers.length}: ${carriers.join(', ')}`
    )
    return carriers
  }

  it('CONTROL: the live corpus passes, and enough of it carries run bodies to make the sweep mean something', () => {
    assertReaderSane(workflows)
    carriersOf(workflows)
  })

  it('every file that carries run bodies goes RED when only that file loses them', () => {
    const carriers = carriersOf(workflows)
    for (const name of carriers) {
      const collapsed = withRunKeysNeutralised(workflows, name)
      assert.throws(
        () => assertEveryFileContributes(collapsed),
        /yields a different number of `run:` bodies than its text declares/,
        `collapsing ${name}'s run bodies alone did not go red`
      )
      // The #7662 check stays GREEN on the same input: the file is still
      // there, its jobs are still there, its steps are still there. That is
      // what makes this a new catch rather than a restatement of that one.
      assertEveryFileParsed(collapsed)
    }
  })

  it('a file that carries NO run bodies cannot collapse, and needs no entry on any list', () => {
    const empty = workflows.filter(w => !yieldsRunBodies(w)).map(w => w.name)
    // stale.yml today. If this set is ever empty the assertion below is
    // vacuous, which is why the case says so rather than looping in silence.
    assert.ok(empty.length >= 1, 'expected at least one workflow with no run steps (stale.yml)')
    for (const name of empty) {
      assertEveryFileContributes(withRunKeysNeutralised(workflows, name))
    }
  })
})

describe('workflow reader: a valueless key may carry a trailing comment (#7673)', () => {
  /**
   * `parseJobs` has allowed a trailing comment on a job-id line since #7499.
   * That fix went to the site that had the bug, and the module was never swept
   * for siblings — there were four, and every one of them ended at a bare `$`.
   * The adjacent-field pattern in docs/false-safety-guards.md, four instances
   * of it in one file.
   *
   * Each case below measures ONE site, and each goes red with only its own
   * anchor reverted. The bare spellings are asserted alongside, so the
   * allowance cannot be "fixed" by matching everything.
   */
  /** The live corpus, for the behavioural rule below. */
  let corpus
  before(async () => {
    corpus = await readWorkflows()
  })

  const bashJob = steps => [
    '  a:',
    '    runs-on: ubuntu-latest',
    steps,
    '      - run: echo hi',
    '      - uses: actions/checkout@v4',
  ]
  const pwshJob = (defaults, run) => [
    '  a:',
    '    runs-on: windows-latest',
    defaults,
    run,
    '        shell: pwsh',
    '    steps:',
    '      - run: Get-Item .',
  ]

  it('parseSteps: `steps: # comment` still yields the job its steps', () => {
    // Measured before the fix: 2 steps for the bare spelling, ZERO for the
    // commented one — the whole job's steps vanish, and every rule anchored to
    // a step body then passes over an empty set for it.
    assert.equal(parseSteps(bashJob('    steps:')).length, 2, 'control: the bare spelling')
    assert.equal(parseSteps(bashJob('    steps: # the pipeline')).length, 2)
  })

  it('jobShell: `defaults: # comment` still classifies the job pwsh', () => {
    // Measured before the fix: "pwsh" bare, `undefined` commented. Both of
    // this repo's PowerShell jobs declare their shell in `defaults:` and
    // neither declares it on a step.
    assert.equal(jobShell(pwshJob('    defaults:', '      run:')), 'pwsh', 'control: the bare spelling')
    assert.equal(jobShell(pwshJob('    defaults: # pwsh everywhere', '      run:')), 'pwsh')
  })

  it('jobShell: `run: # comment` still classifies the job pwsh', () => {
    // The `defaults:` -> `run:` -> `shell:` chain has two valueless keys and
    // the second was broken the same way. Measured: `undefined` before.
    assert.equal(jobShell(pwshJob('    defaults:', '      run: # pwsh everywhere')), 'pwsh')
  })

  it('jobShell: `steps: # comment` must not read a RUN BODY as the job shell', () => {
    // The sharp one, and the direction `jobShell`'s own comment names: with
    // `steps:` unmatched the job-key slice runs to the end of the job, so the
    // scan walks into a run block's body and reads a heredoc writing a
    // workflow file as this job's configuration. Measured before the fix:
    // "pwsh" FOR A BASH JOB — and a false "powershell" drops every real bash
    // block in that job out of `bash -n`.
    const heredocJob = steps => [
      '  a:',
      '    runs-on: ubuntu-latest',
      steps,
      '      - run: |',
      '          cat > w.yml <<EOF',
      '          defaults:',
      '            run:',
      '              shell: pwsh',
      '          EOF',
    ]
    assert.equal(jobShell(heredocJob('    steps:')), undefined, 'control: the bare spelling')
    assert.equal(jobShell(heredocJob('    steps: # the pipeline')), undefined)
  })

  it('valuelessKey accepts a bare key and a trailing comment, and REFUSES a key with a value', () => {
    // The contract, asserted directly. A mutation sweep made the pattern
    // `${key}:.*$` — accepting a key WITH a value — and all four call sites
    // stayed green, because these three keys are never written with one in real
    // YAML. Inferring "valueless" from the call sites is inferring it from
    // evidence that cannot vary; this is the case that can.
    const k = valuelessKey('steps')
    for (const ok of ['steps:', '    steps:', 'steps:   ', 'steps: # the pipeline', '  steps:\t# tab then comment']) {
      assert.ok(k.test(ok), `expected a valueless key to match: ${JSON.stringify(ok)}`)
    }
    for (const no of ['steps: [a, b]', 'steps: 3 # three', 'stepsx:', 'steps:#nospace']) {
      assert.ok(!k.test(no), `expected NO match: ${JSON.stringify(no)}`)
    }
    // `steps:#nospace` is in the reject list for a YAML reason, not a style
    // one: a `#` needs preceding whitespace to open a comment, so that line is
    // a plain scalar and not a mapping key at all.
  })

  it('a COMMENTED-OUT key is not the key — the `^` anchor, pinned on both consumers', () => {
    // The other half of the contract, and separately untested: a sweep dropped
    // the `^` from `valuelessKey` and nothing went red. Without it the pattern
    // matches mid-line, so a bare `# steps:` — a commented-out key above the real
    // one, which is how this repo actually edits workflows — reads AS the key.
    // The commented key must be BARE: `# steps: moved below` matches neither
    // spelling, so a fixture written that way proves nothing and passes either
    // way. That is how the first draft of this case was written, and the sweep
    // is what caught it.
    // Neither consumer runs its anchor through `code()`, so nothing else stops
    // it. Both consumers are pinned because the damage differs.
    //
    // jobShell: the job-key slice ends at the COMMENT, so the whole
    // `defaults:` chain falls outside it and a pwsh job reads as unset.
    const pwsh = [
      '  a:',
      '    runs-on: windows-latest',
      '    # steps:',
      '    #   - run: moved below',
      '    defaults:',
      '      run:',
      '        shell: pwsh',
      '    steps:',
      '      - run: Get-Item .',
    ]
    assert.equal(jobShell(pwsh), 'pwsh')

    // parseSteps: the scan starts at the comment, so the FIRST dash it meets
    // sets the step indent — here a matrix axis, four spaces deeper than the
    // real steps — and it returns the axis entries as this job's steps.
    const matrix = [
      '  a:',
      '    runs-on: ubuntu-latest',
      '    strategy:',
      '      matrix:',
      '        # steps:',
      '        os:',
      '          - ubuntu-latest',
      '          - macos-latest',
      '    steps:',
      '      - run: echo hi',
    ]
    assert.equal(parseSteps(matrix).length, 1, 'the matrix axis is not this job’s steps')
  })

  it('NO valueless-key anchor anywhere in the module may reject a trailing comment', () => {
    // A UNIVERSAL rather than a list of site names — a roster beside a growing
    // set is the first cause in docs/false-safety-guards.md, and a list would
    // go stale on the next site, which is exactly how this survived #7499.
    //
    // WHAT IT DOES NOT COVER, measured in review of #7674 rather than reasoned
    // about, because the first version of this comment claimed it meant "a
    // fifth site cannot be added quietly" and it does not. It is a SPELLING
    // check, and two behaviourally identical reintroductions of the bug went
    // straight past it: `/^\s*steps[:]\s*$/` (colon in a character class) and
    // `new RegExp("^\\s*defaults:" + "\\s*$")` (split across two lines). It
    // could never have seen `parseJobs`'s `l === 'jobs:'` string equality
    // either — the sixth site, which is not a regex at all.
    //
    // It is kept because it is cheap and it catches the shape people actually
    // type. The rule that does the real work is the BEHAVIOURAL one below,
    // which is spelling-blind by construction and is what found site six.
    const src = readFileSync(new URL('./helpers/workflow-reader.js', import.meta.url), 'utf8')
    const isComment = l => /^\s*(?:\/\/|\/?\*)/.test(l)
    const bare = src
      .split('\n')
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter(r => !isComment(r.text) && r.text.includes(':\\s*$'))
    assert.deepEqual(
      bare.map(r => `${r.line}: ${r.text}`),
      [],
      'a `key:\\s*$` anchor ends at a bare `$`, so a legal trailing comment on that key matches ' +
        'nothing — route it through valuelessKey() instead'
    )
  })

  it('commenting EVERY valueless key in the live corpus changes nothing the reader reports', () => {
    // The guard that is not a spelling check. It asks the question the source
    // rule only approximates — does a legal trailing comment change what this
    // reader reports? — and it asks it of the REAL workflows, through the
    // public surface, so an anchor's spelling is irrelevant and an anchor that
    // is not a regex at all is still covered. That is not hypothetical: this
    // case is what found `parseJobs`'s `l === 'jobs:'` string equality, which
    // made the whole file THROW and which the source rule cannot see.
    //
    // The transform is deliberately indiscriminate — every `key:` line with no
    // value, at any indent, whatever the key — because naming the keys would
    // reintroduce the roster this file keeps removing.
    const VALUELESS = /^\s*[A-Za-z0-9_-]+:\s*$/
    const observe = (name, text) =>
      parseJobs(text, name).map(j => ({ id: j.id, steps: j.steps.length, shell: jobShell(j.body) ?? null }))

    let touched = 0
    for (const w of corpus) {
      const lines = w.text.split('\n')
      const n = lines.filter(l => VALUELESS.test(l)).length
      // Per FILE, so a file with none drops out loudly instead of shrinking the
      // sweep in silence — the same non-vacuity rule the #7668 sweep learned.
      assert.ok(n > 0, `${w.name} has no valueless key, so this case proves nothing for it`)
      touched += n
      const commented = lines.map(l => (VALUELESS.test(l) ? `${l} # pinned by #7673` : l)).join('\n')
      assert.deepEqual(
        observe(w.name, commented),
        observe(w.name, w.text),
        `${w.name}: commenting its valueless keys changed what the reader reports`
      )
    }
    // 223 today across seven files. A floor, not the exact number, because the
    // corpus grows — but high enough that a transform which quietly stopped
    // matching could not pass.
    assert.ok(touched >= 100, `expected the transform to touch many keys, touched ${touched}`)
  })

  it('parseJobs: `jobs: # comment` is still the top-level jobs key (#7674 review)', () => {
    // The sixth site, and the only one that was not a regex: `l === 'jobs:'`.
    // Measured before the fix — THROWS, so the file yields nothing at all.
    // Anchored at column zero, because `jobs:` is top-level and a nested
    // `jobs:` further in must not be mistaken for it.
    const text = ['jobs: # the pipeline', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo hi'].join('\n')
    assert.equal(parseJobs(text, 'x.yml')[0].steps.length, 1)
    assert.ok(!valuelessKey('jobs', { topLevel: true }).test('  jobs:'), 'a nested `jobs:` is not the top-level one')
  })

  it('valuelessKey is symmetric across line endings, and REFUSES a key it cannot safely interpolate', () => {
    // Two review findings in one contract. `.` excludes `\r`, so the comment
    // branch written with `.` matched `steps: \r` and REJECTED `steps: # c\r` —
    // this same bug class, gated on line ending instead of on a comment.
    // `.gitattributes` pins the repo to LF so nothing live hit it, but the
    // helper is exported now.
    const k = valuelessKey('steps')
    assert.ok(k.test('steps: \r'), 'a bare key with a CR')
    assert.ok(k.test('steps: # c\r'), 'and its commented form — these must agree')
    // And the key is interpolated into a RegExp, so a metacharacter would widen
    // the pattern silently rather than failing. Refused, not escaped.
    for (const bad of ['ste.s', 'a(b', 'x|y', '']) {
      assert.throws(() => valuelessKey(bad), /expects a plain YAML key/, `expected refusal for ${JSON.stringify(bad)}`)
    }
  })

  it('CONTROL: the guard above can SEE a bare anchor, so its empty result means something', () => {
    // Without this the case above passes on an empty file, a broken read, or a
    // needle that matches nothing — "a filter whose terms match NOTHING, so the
    // gate is satisfied by zero rows" (docs/false-safety-guards.md). The needle
    // is applied to a line known to contain the shape.
    const isComment = l => /^\s*(?:\/\/|\/?\*)/.test(l)
    const planted = '  const stepsAt = bodyLines.findIndex(l => /^\\s*steps:\\s*$/.test(l))'
    assert.ok(!isComment(planted) && planted.includes(':\\s*$'), 'the needle must match the pre-#7673 line')
    const src = readFileSync(new URL('./helpers/workflow-reader.js', import.meta.url), 'utf8')
    assert.ok(src.length > 1000, 'the module source must actually have been read')
    assert.ok(src.includes('valuelessKey'), 'and it must be the module that carries the one implementation')
  })
})

describe('workflow reader: no real file can absorb a step invisibly (#7668)', () => {
  /**
   * The companion of the block above, one level up from run bodies: the same
   * argument about the real corpus, for the STEP count. Synthetic YAML proves
   * the row understands the spelling; only the real seven files can establish
   * that not one of them absorbs a step where nothing sees it.
   */
  let workflows
  before(async () => {
    workflows = await readWorkflows()
  })

  /**
   * `text` with its first RUN-FREE step respelled the #7668 way: the keys on
   * the dash line move DOWN one line, to the column they already occupied.
   * Identical YAML to GitHub, and `parseSteps` — which needs the space on the
   * SAME line as the dash — stops starting a step there.
   *
   * Run-free ON PURPOSE. Absorbing a step that carries a `run:` also destroys
   * a run body, which `assertEveryFileContributes` catches on its own; the
   * claim under measurement is that this row sees what that one cannot, so the
   * mutation has to leave that one nothing to find. Measured: with a run-free
   * step chosen, all seven files go red HERE and green THERE.
   *
   * Returns null for a file with no such step, which the sweep counts rather
   * than skips — a file quietly dropping out is how a sweep reports success
   * over fewer cases than it claims.
   */
  const withAStepAbsorbed = text => {
    const lines = text.split('\n')
    let stepsIndent = null
    for (let i = 0; i < lines.length; i++) {
      if (valuelessKey('steps').test(lines[i])) {
        stepsIndent = /^(\s*)/.exec(lines[i])[1].length
        continue
      }
      if (stepsIndent === null) continue
      const m = /^(\s+)- (\S.*)$/.exec(lines[i])
      if (!m || m[1].length <= stepsIndent) continue
      let end = lines.length
      for (let k = i + 1; k < lines.length; k++) {
        const dash = /^(\s*)- \S/.exec(lines[k])
        if (dash && dash[1].length === m[1].length) { end = k; break }
        if (/\S/.test(lines[k]) && /^(\s*)/.exec(lines[k])[1].length <= stepsIndent) { end = k; break }
      }
      if (lines.slice(i, end).some(l => /^\s*(?:-\s+)?run:/.test(l))) continue
      lines.splice(i, 1, `${m[1]}-`, `${m[1]}  ${m[2]}`)
      return lines.join('\n')
    }
    return null
  }

  const withFileReplaced = (ws, name, text) =>
    ws.map(w => (w.name === name ? { name, text, jobs: parseJobs(text, name) } : w))

  /**
   * The corpus, FLOORED HERE rather than in one of the cases — the same shape
   * as `carriersOf` in the block above, and for the same reason it moved there.
   *
   * The floor sat in the CONTROL case in the first draft of this block, and
   * review of #7671 measured what that costs: with `workflows` empty the sweep
   * below runs ZERO iterations and reports ok, and only the SIBLING case says
   * so. That is catalogue entry 29 — a control that fires as somebody else's
   * side effect — reintroduced two describe blocks after the comment
   * explaining it. A case must not depend on a sibling for its own
   * non-vacuity, so both cases call this and neither can pass over nothing.
   */
  const flooredCorpus = ws => {
    assert.ok(ws.length >= 5, `expected >=5 workflow files, found ${ws.length}`)
    return ws
  }

  it('CONTROL: the live corpus passes, and every file has a step this mutation can reach', () => {
    const ws = flooredCorpus(workflows)
    assertEveryFileParsed(ws)
    const unreachable = ws.filter(w => withAStepAbsorbed(w.text) === null).map(w => w.name)
    assert.deepEqual(
      unreachable,
      [],
      'a file with no run-free step would drop out of the sweep below and shrink it in silence'
    )
  })

  it('every file goes RED when one of its steps is absorbed, and the content rows stay GREEN', () => {
    for (const w of flooredCorpus(workflows)) {
      const text = withAStepAbsorbed(w.text)
      assert.notEqual(text, null, `${w.name} has no run-free step to absorb`)
      const set = withFileReplaced(workflows, w.name, text)
      const after = set.find(x => x.name === w.name).jobs.reduce((n, j) => n + j.steps.length, 0)
      const before = w.jobs.reduce((n, j) => n + j.steps.length, 0)
      assert.equal(after, before - 1, `absorbing a step in ${w.name} did not cost the parse a step`)
      assert.throws(
        () => assertEveryFileParsed(set),
        /yields a different number of steps than its text declares/,
        `absorbing a step in ${w.name} alone did not go red`
      )
      // What makes this a new catch rather than a restatement: the file is
      // still there, its jobs are still there, its run bodies and setup-node
      // lines are all still counted — the absorbed lines simply live in the
      // neighbouring step now.
      assertEveryFileContributes(set)
    }
  })
})
