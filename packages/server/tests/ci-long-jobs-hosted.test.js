import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readWorkflows, assertEveryFileParsed, code, stepInput } from './helpers/workflow-reader.js'

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
 * GitHub-hosted label, in any workflow, outside the standard allowlist below —
 * including the labels the runner-target `resolve` step emits on BOTH of its
 * branches, and any job whose runner this file cannot see (a remote reusable
 * workflow). Visibility itself is not checkable offline: if the repository ever
 * goes private, hosted minutes are billed regardless of label. Full rationale:
 * the LONG JOBS ON GITHUB-HOSTED RUNNERS note in ci.yml's header.
 */

const LONG_JOBS = ['server-tests', 'dashboard-tests', 'scripts-tests']

// Standard GitHub-hosted labels in use. Exact in BOTH directions: an unlisted
// label fails (it may be a billed larger runner), and a listed label that no
// workflow uses fails (a stale entry would silently pre-approve it later).
// Adding a label is a deliberate edit: confirm it is a standard runner first.
const STANDARD_HOSTED_LABELS = new Set(['ubuntu-24.04', 'ubuntu-latest', 'windows-latest', 'macos-latest'])

// runner-target outputs that jobs consume as `runs-on`. Their values are the
// JSON literals the `resolve` step echoes, and those are classified below.
const ROUTED_OUTPUTS = ['runner', 'winrunner']
const routedExpression = name => `\${{ fromJSON(needs.runner-target.outputs.${name}) }}`

/** `runs-on: X  # why` (flow or block form) -> `X`, whitespace-collapsed. */
function runsOnValue(raw) {
  // A YAML comment needs whitespace before `#`; no runs-on value here contains
  // ` #`, so everything from the first ` #` on is the comment.
  return raw
    .replace(/^\s*runs-on:\s*/, '')
    .replace(/\s+#.*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Labels of a runner: a flow list `[a, b]`, a JSON array, or one plain label. */
function classifyLabels(labels) {
  if (labels.includes('self-hosted')) return { kind: 'self-hosted' }
  if (labels.length === 1 && /^[A-Za-z0-9._-]+$/.test(labels[0])) return { kind: 'hosted', label: labels[0] }
  return { kind: 'unknown' }
}

/**
 * Classify one `runs-on` value. Anything this cannot positively identify is
 * an error — "could not check" must never read as "nothing to check".
 */
function classify(value) {
  if (ROUTED_OUTPUTS.some(name => value === routedExpression(name))) return { kind: 'routed' }
  if (value.startsWith('[') && value.endsWith(']')) {
    return classifyLabels(value.slice(1, -1).split(',').map(l => l.trim()).filter(Boolean))
  }
  if (/^[A-Za-z0-9._-]+$/.test(value)) return { kind: 'hosted', label: value }
  return { kind: 'unknown' }
}

/** A job-level `uses:` (a reusable-workflow call) and its target, or null. */
function reusableCall(job) {
  const line = code(job.body).find(l => /^ {4}uses:\s*\S/.test(l))
  return line ? line.replace(/^ {4}uses:\s*/, '').replace(/\s+#.*$/, '').trim() : null
}

describe('long Linux jobs run on standard GitHub-hosted runners', () => {
  let workflows
  let ciJobs
  let allJobs // [{ file, job }]
  let resolveValues // [{ name, raw }]

  before(async () => {
    workflows = await readWorkflows()
    ciJobs = workflows.find(w => w.name === 'ci.yml').jobs
    allJobs = workflows.flatMap(w => w.jobs.map(job => ({ file: w.name, job })))
    const target = ciJobs.find(j => j.id === 'runner-target')
    const resolveStep = target?.steps.find(s => s.some(l => /^\s*(- )?id: resolve\s*$/.test(l)))
    const text = resolveStep ? code(resolveStep).join('\n') : ''
    resolveValues = [...text.matchAll(/echo '([a-z]+)=(.*)' >> "\$GITHUB_OUTPUT"/g)]
      .map(m => ({ name: m[1], raw: m[2] }))
      .filter(v => ROUTED_OUTPUTS.includes(v.name))
  })

  // ---- positive controls ----------------------------------------------------
  // Every rule below quantifies over what these found; a broken reader must
  // fail HERE, not pass the rules over an empty set.
  it('reads every workflow file completely', () => {
    assert.ok(workflows.length >= 2, `expected several workflow files, found ${workflows.length}`)
    assertEveryFileParsed(workflows)
  })

  it('finds the three long jobs in ci.yml', () => {
    for (const id of LONG_JOBS) {
      assert.ok(ciJobs.some(j => j.id === id), `expected job '${id}' in ci.yml`)
    }
  })

  it('finds both branches of every routed runner output in the resolve step', () => {
    // One value per branch per output: the trusted (self-hosted) branch AND the
    // fork (hosted) branch. The first version of this guard read only the fork
    // branch's strings, so a larger-runner array on the trusted branch passed.
    assert.deepEqual(
      resolveValues.map(v => v.name).sort(),
      ['runner', 'runner', 'winrunner', 'winrunner'],
      `expected two echoes each for ${ROUTED_OUTPUTS.join('/')}, found: ${resolveValues.map(v => v.name).join(', ')}`
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
  it('every GitHub-hosted runner in every workflow is a standard (free) label', () => {
    const offenders = []
    const check = (where, c) => {
      if (c.kind === 'unknown') offenders.push(`${where} — cannot verify the runner`)
      else if (c.kind === 'hosted' && !STANDARD_HOSTED_LABELS.has(c.label)) {
        offenders.push(`${where} — '${c.label}' is not a known standard label`)
      }
    }
    for (const { file, job } of allJobs) {
      const value = runsOnValue(job.runsOn)
      if (value === '') {
        // No runs-on: only a LOCAL reusable-workflow call is fine — its jobs are
        // in this same directory and are checked in their own right. A remote
        // one runs on whatever that repository chose, billed to this one.
        const target = reusableCall(job)
        if (!target || !target.startsWith('./.github/workflows/')) {
          offenders.push(`${file}:${job.line} ${job.id} — no runs-on and no local reusable workflow (${target ?? 'none'})`)
        }
        continue
      }
      check(`${file}:${job.line} ${job.id} runs-on: ${value}`, classify(value))
    }
    for (const { name, raw } of resolveValues) {
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        offenders.push(`ci.yml runner-target resolve step — ${name}=${raw} is not JSON`)
        continue
      }
      const labels = Array.isArray(parsed) ? parsed : [parsed]
      check(`ci.yml runner-target resolve step ${name}=${raw}`,
        labels.every(l => typeof l === 'string') ? classifyLabels(labels) : { kind: 'unknown' })
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
    const used = new Set()
    for (const { raw } of resolveValues) {
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed === 'string') used.add(parsed)
      } catch { /* reported by the cost guard */ }
    }
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
    assert.equal(classify(routedExpression('runner')).kind, 'routed')
    assert.equal(classify('${{ fromJSON(needs.runner-target.outputs.bigrunner) }}').kind, 'unknown')
    assert.deepEqual(classify('ubuntu-24.04-16core'), { kind: 'hosted', label: 'ubuntu-24.04-16core' })
    assert.equal(STANDARD_HOSTED_LABELS.has('ubuntu-24.04-16core'), false)
    assert.deepEqual(classifyLabels(['windows-latest-8-cores']), { kind: 'hosted', label: 'windows-latest-8-cores' })
    assert.equal(runsOnValue("    runs-on: ubuntu-24.04  # don't route"), 'ubuntu-24.04')
  })
})
