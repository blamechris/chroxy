import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { parseJobs, code, stepInput } from './helpers/workflow-reader.js'

/**
 * The three long Linux jobs run on GitHub-hosted `ubuntu-24.04` (2026-09-27,
 * replacing the #7471 X64 pin that serialized them onto one self-hosted VM).
 *
 * Hosted runners cost nothing here for two reasons that must BOTH hold: the
 * repository is public, and the label is a STANDARD runner. GitHub's billing
 * docs: "GitHub Actions usage is free for self-hosted runners and for public
 * repositories that use standard GitHub-hosted runners" — but larger runners
 * "are always charged for, even when used by public repositories". A larger
 * runner is selected by a custom label, so this file fails the build on any
 * GitHub-hosted `runs-on` label, in any workflow, outside the standard
 * allowlist below. Full rationale: the LONG JOBS ON GITHUB-HOSTED RUNNERS note
 * in ci.yml's header.
 */

const WORKFLOWS_DIR = new URL('../../../.github/workflows/', import.meta.url)
const LONG_JOBS = ['server-tests', 'dashboard-tests', 'scripts-tests']

// Standard GitHub-hosted labels in use. Exact in BOTH directions: an unlisted
// label fails (it may be a billed larger runner), and a listed label that no
// workflow uses fails (a stale entry would silently pre-approve it later).
// Adding a label is a deliberate edit: confirm it is a standard runner first.
const STANDARD_HOSTED_LABELS = new Set(['ubuntu-24.04', 'ubuntu-latest', 'windows-latest', 'macos-latest'])

// `runs-on` expressions whose GitHub-hosted values are literals in the
// runner-target `resolve` step; those literals are checked separately below.
const ROUTED_EXPRESSIONS = new Set([
  '${{ fromJSON(needs.runner-target.outputs.runner) }}',
  '${{ fromJSON(needs.runner-target.outputs.winrunner) }}',
])

/** `runs-on: X  # why` (flow or block form) -> `X`, whitespace-collapsed. */
function runsOnValue(raw) {
  return raw
    .replace(/^\s*runs-on:\s*/, '')
    .replace(/\s+#[^'"\]}]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Classify one `runs-on` value. Anything this cannot positively identify is
 * an error — "could not check" must never read as "nothing to check".
 * @returns {{ kind: 'self-hosted' } | { kind: 'hosted', label: string } | { kind: 'routed' } | { kind: 'unknown' }}
 */
function classify(value) {
  if (ROUTED_EXPRESSIONS.has(value)) return { kind: 'routed' }
  if (value.startsWith('[')) {
    const labels = value.slice(1, -1).split(',').map(l => l.trim())
    return labels.includes('self-hosted') ? { kind: 'self-hosted' } : { kind: 'unknown' }
  }
  if (/^[A-Za-z0-9._-]+$/.test(value)) return { kind: 'hosted', label: value }
  return { kind: 'unknown' }
}

describe('long Linux jobs run on standard GitHub-hosted runners', () => {
  let ciJobs
  let allJobs // [{ file, job }]
  let resolveHostedLabels

  before(async () => {
    const files = (await readdir(WORKFLOWS_DIR)).filter(f => /\.ya?ml$/.test(f)).sort()
    allJobs = []
    for (const file of files) {
      const text = await readFile(new URL(file, WORKFLOWS_DIR), 'utf8')
      for (const job of parseJobs(text)) allJobs.push({ file, job })
      if (file === 'ci.yml') ciJobs = parseJobs(text)
    }
    const target = ciJobs.find(j => j.id === 'runner-target')
    const resolveStep = target?.steps.find(s => s.some(l => /^\s*(- )?id: resolve\s*$/.test(l)))
    const text = resolveStep ? code(resolveStep).join('\n') : ''
    // `echo 'runner="ubuntu-24.04"'` — a JSON STRING value is a hosted label;
    // the JSON ARRAY values are the self-hosted label sets.
    resolveHostedLabels = [...text.matchAll(/echo '[a-z]+="([^"]+)"'/g)].map(m => m[1])
  })

  // ---- positive controls ----------------------------------------------------
  // Every rule below quantifies over what these found; a broken reader must
  // fail HERE, not pass the rules over an empty set.
  it('reads the workflows and finds the three long jobs in ci.yml', () => {
    assert.ok(allJobs.length >= 20, `expected >=20 jobs across workflows, found ${allJobs.length}`)
    for (const id of LONG_JOBS) {
      assert.ok(ciJobs.some(j => j.id === id), `expected job '${id}' in ci.yml`)
    }
  })

  it('finds the hosted labels the runner-target resolve step emits for forks', () => {
    assert.deepEqual(
      [...resolveHostedLabels].sort(),
      ['ubuntu-24.04', 'windows-latest'],
      'expected the fork branch to emit runner="ubuntu-24.04" and winrunner="windows-latest"'
    )
  })

  // ---- the move -------------------------------------------------------------
  it('each long job runs on the standard ubuntu-24.04 label for every event', () => {
    for (const id of LONG_JOBS) {
      const job = ciJobs.find(j => j.id === id)
      assert.equal(runsOnValue(job.runsOn), 'ubuntu-24.04', `${id} must run on ubuntu-24.04 — got: ${job.runsOn}`)
    }
  })

  it('the long jobs no longer depend on runner-target', () => {
    // A leftover `needs.runner-target.outputs.*` would evaluate EMPTY without the
    // `needs:` edge — silently turning `cache:` off, for example.
    for (const id of LONG_JOBS) {
      const job = ciJobs.find(j => j.id === id)
      const refs = code(job.body).filter(l => l.includes('runner-target'))
      assert.deepEqual(refs, [], `${id} still references runner-target: ${refs.join(' | ')}`)
    }
  })

  it('each long job that runs npm ci restores the npm cache (a hosted VM starts cold)', () => {
    // The routed-cache omission rule in ci-npm-cache-routing.test.js only sees
    // ROUTED jobs, and these are not routed: without this, deleting `cache: npm`
    // would go unnoticed and every run would cold-install the whole monorepo.
    const installers = LONG_JOBS
      .map(id => ciJobs.find(j => j.id === id))
      .filter(job => job.steps.some(step => code(step).some(l => /(^|\s)npm ci(\s|$)/.test(l))))
    assert.deepEqual(installers.map(j => j.id).sort(), ['dashboard-tests', 'server-tests'],
      'positive control: expected server-tests and dashboard-tests to run npm ci')
    for (const job of installers) {
      const setupNode = job.steps.find(step => code(step).some(l => l.includes('actions/setup-node@')))
      assert.equal(setupNode && stepInput(setupNode, 'cache'), 'npm', `${job.id} must set 'cache: npm' on setup-node`)
    }
  })

  it('runner-target no longer exposes a longrunner output', () => {
    const target = ciJobs.find(j => j.id === 'runner-target')
    const refs = code(target.body).filter(l => l.includes('longrunner'))
    assert.deepEqual(refs, [], `stale longrunner routing left in runner-target: ${refs.join(' | ')}`)
  })

  // ---- the cost guard ---------------------------------------------------------
  it('every GitHub-hosted runs-on label in every workflow is a standard (free) runner', () => {
    const offenders = []
    for (const { file, job } of allJobs) {
      const value = runsOnValue(job.runsOn)
      if (value === '') continue // a reusable-workflow call (`uses:`) has no runs-on
      const c = classify(value)
      if (c.kind === 'unknown') {
        offenders.push(`${file}:${job.line} ${job.id} — cannot verify runs-on: ${value}`)
      } else if (c.kind === 'hosted' && !STANDARD_HOSTED_LABELS.has(c.label)) {
        offenders.push(`${file}:${job.line} ${job.id} — '${c.label}' is not a known standard label`)
      }
    }
    for (const label of resolveHostedLabels) {
      if (!STANDARD_HOSTED_LABELS.has(label)) {
        offenders.push(`ci.yml runner-target resolve step — '${label}' is not a known standard label`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a GitHub-hosted label outside STANDARD_HOSTED_LABELS may be a LARGER runner, which is billed even ' +
        'on a public repository. Confirm it is a standard runner, then add it deliberately:\n  ' +
        offenders.join('\n  ')
    )
  })

  it('every allowlisted standard label is actually used (the allowlist cannot go stale)', () => {
    const used = new Set(resolveHostedLabels)
    for (const { job } of allJobs) {
      const c = classify(runsOnValue(job.runsOn))
      if (c.kind === 'hosted') used.add(c.label)
    }
    const stale = [...STANDARD_HOSTED_LABELS].filter(l => !used.has(l))
    assert.deepEqual(stale, [], `STANDARD_HOSTED_LABELS entries no workflow uses: ${stale.join(', ')}`)
  })

  // ---- the classifier itself ---------------------------------------------------
  it('classify fails closed on forms it cannot verify', () => {
    assert.equal(classify('${{ matrix.os }}').kind, 'unknown')
    assert.equal(classify('{ group: big-runners }').kind, 'unknown')
    assert.equal(classify('[ubuntu-24.04, gpu]').kind, 'unknown')
    assert.equal(classify('[self-hosted, Linux, X64]').kind, 'self-hosted')
    assert.deepEqual(classify('ubuntu-24.04-16core'), { kind: 'hosted', label: 'ubuntu-24.04-16core' })
    assert.equal(STANDARD_HOSTED_LABELS.has('ubuntu-24.04-16core'), false)
    assert.equal(runsOnValue('    runs-on: ubuntu-24.04  # always hosted'), 'ubuntu-24.04')
  })
})
