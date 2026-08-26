import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseJobs, parseSteps, stepInput, code } from './helpers/workflow-reader.js'

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
