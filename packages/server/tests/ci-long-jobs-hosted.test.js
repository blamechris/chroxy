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
 * including every value the runner-target `resolve` step can emit, and any job
 * whose runner this file cannot see (a remote reusable workflow). Visibility
 * itself is not checkable offline: if the repository ever goes private, hosted
 * minutes are billed regardless of label. Full rationale: the LONG JOBS ON
 * GITHUB-HOSTED RUNNERS note in ci.yml's header.
 *
 * It also holds the TRUST half of runner-target: the trusted branch of the
 * resolve step may only name self-hosted runners, and the fork branch only
 * standard hosted ones, so untrusted fork-PR code can never be routed onto a
 * self-hosted machine.
 */

const LONG_JOBS = ['server-tests', 'dashboard-tests', 'scripts-tests']

// Standard GitHub-hosted labels in use. Exact in BOTH directions: an unlisted
// label fails (it may be a billed larger runner), and a listed label that no
// workflow uses fails (a stale entry would silently pre-approve it later).
// Adding a label is a deliberate edit: confirm it is a standard runner first.
const STANDARD_HOSTED_LABELS = new Set(['ubuntu-24.04', 'ubuntu-latest', 'windows-latest', 'macos-latest'])

// runner-target outputs that jobs consume as `runs-on`, in ci.yml ONLY.
const ROUTED_OUTPUTS = ['runner', 'winrunner']
const routedExpression = name => `\${{ fromJSON(needs.runner-target.outputs.${name}) }}`

// The ONE spelling of a resolve-step output write this file can read.
const CANONICAL_ECHO = /^\s*echo '([a-z]+)=(.*)' >> "\$GITHUB_OUTPUT"\s*$/

// The trust predicate that selects the self-hosted branch: push events and
// same-repo PRs only. Pinned EXACTLY — inverting or widening it would route
// fork-PR code onto the self-hosted branch while every branch check still passed.
const TRUST_CONDITION =
  'if [ "${{ github.event_name == \'push\' || github.event.pull_request.head.repo.full_name == github.repository }}" = "true" ]; then'

const stripComment = s => s.replace(/\s+#.*$/, '')

/**
 * A job's JOB-LEVEL `runs-on` value (a key at exactly four spaces, the repo's
 * convention — see assertEveryFileParsed), as a flow value: `x`, `[a, b]`, or
 * `{block}` for a mapping form. `null` when there is no such key; `{duplicate}`
 * when there are two. Text nested deeper — a `with:` block scalar, a heredoc in
 * a step — is never read as the job's runner.
 */
function jobLevelRunsOn(body) {
  const at = body.map((l, i) => (/^ {4}runs-on:/.test(l) ? i : -1)).filter(i => i !== -1)
  if (at.length === 0) return null
  if (at.length > 1) return '{duplicate}'
  const inline = stripComment(body[at[0]].replace(/^ {4}runs-on:\s*/, '')).trim()
  if (inline) return inline.replace(/\s+/g, ' ')
  const items = []
  for (let i = at[0] + 1; i < body.length; i++) {
    const l = body[i]
    if (/^\s*$/.test(l) || /^\s*#/.test(l)) continue
    if (!/^ {5,}/.test(l)) break
    const m = /^\s*-\s+(.*)$/.exec(stripComment(l))
    if (!m) return '{block}'
    items.push(m[1].trim())
  }
  return `[${items.join(', ')}]`
}

/** A job's JOB-LEVEL `uses:` target (a reusable-workflow call), or null. */
function jobLevelUses(body) {
  const line = body.find(l => /^ {4}uses:\s*\S/.test(l))
  return line ? stripComment(line.replace(/^ {4}uses:\s*/, '')).trim() : null
}

/** Labels of a runner: a flow list `[a, b]`, a JSON array, or one plain label. */
function classifyLabels(labels) {
  if (labels.includes('self-hosted')) return { kind: 'self-hosted' }
  if (labels.length === 1 && /^[A-Za-z0-9._-]+$/.test(labels[0])) return { kind: 'hosted', label: labels[0] }
  return { kind: 'unknown' }
}

/**
 * Classify one job-level `runs-on` value in `file`. Anything this cannot
 * positively identify is an error — "could not check" must never read as
 * "nothing to check".
 */
function classify(value, file) {
  if (ROUTED_OUTPUTS.some(name => value === routedExpression(name))) {
    // Only ci.yml's runner-target is resolved and checked below; the same
    // expression in another workflow reads an unchecked job of that name.
    return file === 'ci.yml' ? { kind: 'routed' } : { kind: 'unknown' }
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return classifyLabels(value.slice(1, -1).split(',').map(unquote).filter(Boolean))
  }
  // A scalar is ONE label: `self-hosted` alone is valid (and unbilled), and a
  // quoted `"ubuntu-24.04"` is the same label as the bare one.
  const label = unquote(value)
  if (/^[A-Za-z0-9._-]+$/.test(label)) return classifyLabels([label])
  return { kind: 'unknown' }
}

/** `"x"` or `'x'` -> `x`; anything else unchanged (trimmed). */
function unquote(s) {
  return s.trim().replace(/^(['"])(.*)\1$/, '$2')
}

/** Classify an echoed JSON value: a string label or an array of labels. */
function classifyJson(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unknown' }
  }
  const labels = Array.isArray(parsed) ? parsed : [parsed]
  return labels.every(l => typeof l === 'string') ? classifyLabels(labels) : { kind: 'unknown' }
}

describe('long Linux jobs run on standard GitHub-hosted runners', () => {
  let workflows
  let ciJobs
  let allJobs // [{ file, job }]
  let target // the runner-target job
  let resolveLines // code lines of the resolve step
  let trusted // [{ name, raw }] written on the trusted (if) branch
  let fork // [{ name, raw }] written on the fork (else) branch

  before(async () => {
    workflows = await readWorkflows()
    ciJobs = workflows.find(w => w.name === 'ci.yml').jobs
    allJobs = workflows.flatMap(w => w.jobs.map(job => ({ file: w.name, job })))
    target = ciJobs.find(j => j.id === 'runner-target')
    const resolveStep = target?.steps.find(s => s.some(l => /^\s*(- )?id: resolve\s*$/.test(l)))
    resolveLines = resolveStep ? code(resolveStep) : []
    const ifAt = resolveLines.findIndex(l => /^\s*if \[/.test(l))
    const elseAt = resolveLines.findIndex(l => /^\s*else\s*$/.test(l))
    const fiAt = resolveLines.findIndex(l => /^\s*fi\s*$/.test(l))
    const writes = lines => lines
      .map(l => CANONICAL_ECHO.exec(l))
      .filter(Boolean)
      .map(m => ({ name: m[1], raw: m[2] }))
      .filter(v => ROUTED_OUTPUTS.includes(v.name))
    trusted = ifAt !== -1 && elseAt > ifAt ? writes(resolveLines.slice(ifAt + 1, elseAt)) : []
    fork = elseAt !== -1 && fiAt > elseAt ? writes(resolveLines.slice(elseAt + 1, fiAt)) : []
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

  it('finds exactly one write per routed output on EACH branch of the resolve step', () => {
    assert.deepEqual(trusted.map(v => v.name).sort(), [...ROUTED_OUTPUTS].sort(),
      `trusted (if) branch writes: ${trusted.map(v => v.name).join(', ') || 'none'}`)
    assert.deepEqual(fork.map(v => v.name).sort(), [...ROUTED_OUTPUTS].sort(),
      `fork (else) branch writes: ${fork.map(v => v.name).join(', ') || 'none'}`)
  })

  // ---- the move -------------------------------------------------------------
  it('each long job runs on the standard ubuntu-24.04 label for every event', () => {
    for (const id of LONG_JOBS) {
      const job = ciJobs.find(j => j.id === id)
      assert.equal(jobLevelRunsOn(job.body), 'ubuntu-24.04', `${id} must run on ubuntu-24.04 — got: ${job.runsOn}`)
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
    const refs = code(target.body).filter(l => l.includes('longrunner'))
    assert.deepEqual(refs, [], `stale longrunner routing left in runner-target: ${refs.join(' | ')}`)
  })

  // ---- runner-target: trust and cost -------------------------------------------
  it('the trusted branch routes only to self-hosted runners and the fork branch only to standard hosted ones', () => {
    const offenders = []
    for (const { name, raw } of trusted) {
      const c = classifyJson(raw)
      if (c.kind !== 'self-hosted') offenders.push(`trusted branch ${name}=${raw} is not a self-hosted label set`)
    }
    for (const { name, raw } of fork) {
      const c = classifyJson(raw)
      if (c.kind !== 'hosted') {
        offenders.push(`fork branch ${name}=${raw} is not a single hosted label — fork-PR code must never reach a self-hosted machine`)
      } else if (!STANDARD_HOSTED_LABELS.has(c.label)) {
        offenders.push(`fork branch ${name}=${raw} — '${c.label}' is not a known standard label`)
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n'))
  })

  it('the resolve step writes its outputs only in the one spelling this file reads', () => {
    // A second write in another spelling — `echo "runner=[…]"`, `tee -a`, an
    // unquoted redirect, the old `::set-output` — would be invisible to the
    // checks above while still setting the output GitHub uses.
    const routedMention = new RegExp(`\\b(${ROUTED_OUTPUTS.join('|')})=`)
    const offenders = resolveLines
      .filter(l => /GITHUB_OUTPUT|set-output/.test(l) || routedMention.test(l))
      .filter(l => !CANONICAL_ECHO.test(l))
      .map(l => l.trim())
    assert.deepEqual(offenders, [], `non-canonical output writes in the resolve step:\n  ${offenders.join('\n  ')}`)
  })

  it('the resolve step has one if/else/fi, guarded by the exact trust condition', () => {
    const count = re => resolveLines.filter(l => re.test(l)).length
    assert.equal(count(/^\s*if\b/), 1, 'expected exactly one `if` in the resolve step')
    assert.equal(count(/^\s*else\s*$/), 1, 'expected exactly one `else` in the resolve step')
    assert.equal(count(/^\s*fi\s*$/), 1, 'expected exactly one `fi` in the resolve step')
    assert.equal(count(/^\s*elif\b/), 0, 'no `elif` — each branch must be exactly trusted or fork')
    const ifLine = resolveLines.find(l => /^\s*if\b/.test(l)).trim()
    assert.equal(ifLine, TRUST_CONDITION,
      'the self-hosted branch must be selected by the push / same-repo-PR predicate, exactly')
  })

  it('every routed write sits inside the if/else (none before `if` or after `fi`)', () => {
    // A write outside both branches runs on EVERY event and, written after the
    // branch, wins — overriding both of the per-branch checks above.
    const all = resolveLines
      .map(l => CANONICAL_ECHO.exec(l))
      .filter(m => m && ROUTED_OUTPUTS.includes(m[1]))
    assert.equal(all.length, trusted.length + fork.length,
      `routed writes outside the if/else: ${all.length - trusted.length - fork.length}`)
  })

  it('runner-target passes each routed output straight through from the resolve step', () => {
    // A literal in the outputs map would bypass the resolve step entirely.
    const lines = code(target.body)
    for (const name of ROUTED_OUTPUTS) {
      const keyed = lines.filter(l => new RegExp(`^ {6}${name}:`).test(l))
      assert.equal(keyed.length, 1, `expected one '${name}:' in runner-target's outputs, found ${keyed.length}`)
      assert.ok(
        new RegExp(`^ {6}${name}:\\s*\\$\\{\\{\\s*steps\\.resolve\\.outputs\\.${name}\\s*\\}\\}\\s*$`).test(keyed[0]),
        `runner-target must expose '${name}: \${{ steps.resolve.outputs.${name} }}' — got: ${keyed[0].trim()}`
      )
    }
  })

  // ---- the cost guard, every workflow -------------------------------------------
  it('every job-level GitHub-hosted runner in every workflow is a standard (free) label', () => {
    const offenders = []
    for (const { file, job } of allJobs) {
      const where = `${file}:${job.line} ${job.id}`
      const uses = jobLevelUses(job.body)
      if (uses !== null) {
        // A reusable-workflow call runs wherever the CALLED workflow says. Only a
        // local one is visible here — its jobs are in this directory and are
        // checked in their own right. A remote one is billed to this repository.
        if (!uses.startsWith('./.github/workflows/')) offenders.push(`${where} — remote reusable workflow ${uses}`)
        continue
      }
      const value = jobLevelRunsOn(job.body)
      if (value === null) {
        offenders.push(`${where} — no job-level runs-on and no reusable-workflow call`)
        continue
      }
      const c = classify(value, file)
      if (c.kind === 'unknown') offenders.push(`${where} — cannot verify runs-on: ${value}`)
      else if (c.kind === 'hosted' && !STANDARD_HOSTED_LABELS.has(c.label)) {
        offenders.push(`${where} — '${c.label}' is not a known standard label`)
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
    const used = new Set()
    for (const { raw } of fork) {
      const c = classifyJson(raw)
      if (c.kind === 'hosted') used.add(c.label)
    }
    for (const { file, job } of allJobs) {
      const value = jobLevelRunsOn(job.body)
      const c = value === null ? { kind: 'none' } : classify(value, file)
      if (c.kind === 'hosted') used.add(c.label)
    }
    const stale = [...STANDARD_HOSTED_LABELS].filter(l => !used.has(l))
    assert.deepEqual(stale, [], `STANDARD_HOSTED_LABELS entries no workflow uses: ${stale.join(', ')}`)
  })

  // ---- the readers themselves ---------------------------------------------------
  it('classify fails closed on forms it cannot verify', () => {
    assert.equal(classify('${{ matrix.os }}', 'ci.yml').kind, 'unknown')
    assert.equal(classify('{ group: big-runners }', 'ci.yml').kind, 'unknown')
    assert.equal(classify('[ubuntu-24.04, gpu]', 'ci.yml').kind, 'unknown')
    assert.equal(classify('[self-hosted, Linux, X64]', 'ci.yml').kind, 'self-hosted')
    assert.equal(classify(routedExpression('runner'), 'ci.yml').kind, 'routed')
    assert.equal(classify(routedExpression('runner'), 'release.yml').kind, 'unknown')
    assert.equal(classify('${{ fromJSON(needs.runner-target.outputs.bigrunner) }}', 'ci.yml').kind, 'unknown')
    assert.deepEqual(classify('ubuntu-24.04-16core', 'ci.yml'), { kind: 'hosted', label: 'ubuntu-24.04-16core' })
    assert.equal(STANDARD_HOSTED_LABELS.has('ubuntu-24.04-16core'), false)
    assert.equal(classifyJson('["windows-latest-8-cores"]').kind, 'hosted')
    assert.equal(classifyJson('not json').kind, 'unknown')
    assert.equal(classify('["self-hosted", "linux"]', 'ci.yml').kind, 'self-hosted')
    // Copilot review on #8025: legitimate spellings must not fail the build.
    assert.equal(classify('self-hosted', 'ci.yml').kind, 'self-hosted')
    assert.deepEqual(classify('"ubuntu-24.04"', 'ci.yml'), { kind: 'hosted', label: 'ubuntu-24.04' })
    assert.deepEqual(classify("'ubuntu-24.04-16core'", 'ci.yml'), { kind: 'hosted', label: 'ubuntu-24.04-16core' })
    assert.equal(classify('"ubuntu-24.04', 'ci.yml').kind, 'unknown')
    assert.deepEqual(classify("['ubuntu-24.04']", 'ci.yml'), { kind: 'hosted', label: 'ubuntu-24.04' })
  })

  it('jobLevelRunsOn reads only the job-level key, in every form', () => {
    assert.equal(jobLevelRunsOn(["    runs-on: ubuntu-24.04  # don't route"]), 'ubuntu-24.04')
    assert.equal(jobLevelRunsOn(['    runs-on:', '      - self-hosted', '      - Linux']), '[self-hosted, Linux]')
    assert.equal(jobLevelRunsOn(['    runs-on:', '      group: big']), '{block}')
    assert.equal(jobLevelRunsOn(['    runs-on: a', '    runs-on: b']), '{duplicate}')
    // Nested text is not the job's runner: a decoy inside a step body is ignored.
    assert.equal(jobLevelRunsOn(['    steps:', '      - run: |', '          runs-on: ubuntu-latest']), null)
  })
})
