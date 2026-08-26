import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

/**
 * #7383 — setup-node's npm cache must be routed, never hardcoded.
 *
 * The self-hosted pool members are long-lived and their `~/.npm` is already warm
 * (measured 2.2 GB, persistent since the container was built), so `cache: npm`
 * only made every job additionally download and unpack a 521 MB actions/cache
 * tarball over a superset of itself. On `chroxy-linux-winbox-01` that download
 * stalls outright — `Received 0 of 521063625 (0.0%), 0.0 MBs/sec` — until the job
 * burns its entire `timeout-minutes`, and the cancellation renders as `fail` in
 * `gh pr checks` with every real step `skipped`. Nine such cancellations across
 * four PRs looked exactly like test failures.
 *
 * GitHub-hosted fork-PR runners are the opposite case: a fresh VM with an empty
 * `~/.npm`, where the restore is the only thing standing between the job and a
 * cold `npm ci` of the whole monorepo. So the cache is not removed, it is ROUTED
 * on the same predicate as the runner itself, via `runner-target.outputs.npmcache`.
 *
 * What this guard is defending against is the growth case, which is the shape
 * this repo keeps getting caught by (docs/false-safety-guards.md: "a hardcoded
 * list next to a set that grows"). Adding a job is routine; adding a job that
 * copy-pastes `cache: npm` from its neighbour silently re-adds the 521 MB
 * download for that job only, and nothing else in the repo would notice.
 *
 * It therefore asserts BEHAVIOUR, not presence:
 *   - the two `npmcache` values are checked in the RIGHT branch of the resolve
 *     script (swapping them would leave both an `npmcache` output and 13 routed
 *     consumers in place while doing precisely the wrong thing on both runners);
 *   - every routed setup-node step is checked, discovered by scanning rather than
 *     from a list this file holds.
 *
 * The scan is a small indentation-aware reader rather than a file-wide grep,
 * because a file-wide grep for `cache: npm` is satisfied by the prose in ci.yml's
 * own comments explaining why `cache: npm` was removed. Every assertion below is
 * anchored to a step body. `parses ci.yml into jobs and steps` is the positive
 * control: if the reader ever stops understanding ci.yml's shape it fails there,
 * loudly, instead of letting every later assertion pass over an empty set.
 */

const SETUP_NODE = 'actions/setup-node@'
const ROUTED_CACHE = '${{ needs.runner-target.outputs.npmcache }}'

/** Runner-target outputs that mean "this job's runner depends on the trust predicate". */
const ROUTED_RUNNER_OUTPUTS = ['needs.runner-target.outputs.runner', 'needs.runner-target.outputs.winrunner']

/**
 * Split ci.yml's `jobs:` mapping into per-job blocks.
 *
 * Job ids are the only keys at exactly two-space indent, and ci.yml has a single
 * top-level `jobs:` key, so this needs no general YAML support — but it must not
 * silently return nothing, which is what the positive control below checks.
 */
function parseJobs(ciYml) {
  const lines = ciYml.split('\n')
  const jobsAt = lines.findIndex(l => l === 'jobs:')
  assert.notEqual(jobsAt, -1, "ci.yml should have a top-level 'jobs:' key")

  const starts = []
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i])
    if (m) starts.push({ id: m[1], line: i })
  }

  return starts.map((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].line : lines.length
    const body = lines.slice(s.line, end)
    const runsOn = body.find(l => /^\s*runs-on:/.test(l)) ?? ''
    return { id: s.id, line: s.line + 1, body, runsOn, steps: parseSteps(body) }
  })
}

/**
 * Split a job body into step blocks.
 *
 * A step begins at a `- ` list item under `steps:`; the block runs until the next
 * list item at the same indent or the end of the job. Only step bodies are ever
 * asserted on, which is what keeps ci.yml's explanatory comments — several of
 * which quote `cache: npm` verbatim — out of the guard's reach.
 */
function parseSteps(bodyLines) {
  const stepsAt = bodyLines.findIndex(l => /^\s*steps:\s*$/.test(l))
  if (stepsAt === -1) return []

  const starts = []
  let indent = null
  for (let i = stepsAt + 1; i < bodyLines.length; i++) {
    const m = /^(\s*)- /.exec(bodyLines[i])
    if (!m) continue
    if (indent === null) indent = m[1].length
    if (m[1].length === indent) starts.push(i)
  }

  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : bodyLines.length
    return bodyLines.slice(start, end)
  })
}

/**
 * Drop comment lines.
 *
 * ci.yml is heavily commented and several of those comments quote the very
 * strings this file matches on — `cache: npm` in the rationale for removing it,
 * and `npm ci` twice in `server-tests-windows`'s explanation of its 20-minute
 * budget. A guard that reads prose as configuration is satisfiable by prose.
 */
function code(lines) {
  return lines.filter(l => !/^\s*#/.test(l))
}

/**
 * The value of a `with:` input inside a single step block, or undefined.
 *
 * Must strip a TRAILING comment, not just a whole-line one. `cache: npm # hosted-only`
 * parses as `npm` in YAML, and a naive read of the rest of the line sees
 * `npm # hosted-only` — which matches no rule and so slips past every assertion
 * here. Verified: adding exactly that line to a job left the suite 9/9 green
 * while the workflow really did hardcode the cache.
 */
function stepInput(stepLines, key) {
  for (const line of code(stepLines)) {
    const m = new RegExp(`^\\s*${key}:\\s*(.*)$`).exec(line)
    if (!m) continue
    const raw = m[1].trim()

    // A quoted scalar ends at its closing quote; anything after it is a comment.
    if (raw.startsWith("'") || raw.startsWith('"')) {
      const q = raw[0]
      const close = raw.indexOf(q, 1)
      return close === -1 ? raw.slice(1) : raw.slice(1, close)
    }
    // Otherwise a ` #` (whitespace-preceded, per YAML) starts a comment. `${{ }}`
    // expressions contain no `#`, so this cannot truncate a routed value.
    return raw.replace(/\s+#.*$/, '').trim()
  }
  return undefined
}

describe('CI npm cache routing (#7383)', () => {
  let ciYml
  let jobs
  let setupNodeSteps

  before(async () => {
    ciYml = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    jobs = parseJobs(ciYml)
    setupNodeSteps = jobs.flatMap(job =>
      job.steps.filter(s => s.some(l => l.includes(SETUP_NODE))).map(step => ({ job, step }))
    )
  })

  // ---- positive control -------------------------------------------------
  // Every assertion below quantifies over what the reader found. If the reader
  // breaks, they all pass over an empty set and report a clean green — the exact
  // "cannot check this treated as nothing to check" failure in
  // docs/false-safety-guards.md. These three make that impossible.

  it('parses ci.yml into jobs and steps', () => {
    // Thresholds are LOOSE on purpose. Their job is to catch a reader that has
    // stopped understanding ci.yml (which yields zero), not to pin the job count
    // — sitting them on today's exact numbers would turn "a job was merged away"
    // into a failure that blames the reader for someone else's refactor.
    assert.ok(jobs.length >= 10, `expected to parse >=10 jobs from ci.yml, got ${jobs.length}`)
    assert.ok(
      jobs.some(j => j.id === 'runner-target'),
      `expected a 'runner-target' job among: ${jobs.map(j => j.id).join(', ')}`
    )
    assert.ok(
      jobs.every(j => j.runsOn !== ''),
      `every job should have a runs-on: ${jobs.filter(j => j.runsOn === '').map(j => j.id).join(', ')}`
    )
  })

  it('finds the setup-node steps', () => {
    assert.ok(
      setupNodeSteps.length >= 8,
      `expected >=8 setup-node steps, found ${setupNodeSteps.length} — the reader is probably broken`
    )
  })

  it('finds the routed setup-node steps', () => {
    const routed = setupNodeSteps.filter(({ job }) =>
      ROUTED_RUNNER_OUTPUTS.some(o => job.runsOn.includes(o))
    )
    assert.ok(
      routed.length >= 8,
      `expected >=8 setup-node steps in runner-target-routed jobs, found ${routed.length} — ` +
        'the reader is probably broken'
    )
  })

  // ---- the resolve job emits the output, with the right value per branch ----

  it('runner-target exposes an npmcache output', () => {
    const job = jobs.find(j => j.id === 'runner-target')
    assert.ok(
      code(job.body).some(l =>
        /^\s*npmcache:\s*\$\{\{\s*steps\.resolve\.outputs\.npmcache\s*\}\}\s*$/.test(l)
      ),
      "runner-target must expose 'npmcache: ${{ steps.resolve.outputs.npmcache }}' in its outputs"
    )
  })

  it('resolves npmcache empty for self-hosted and npm for hosted, in that order', () => {
    // The resolve script's if-branch is the SAME predicate that picks the runner:
    // the `if` body is the trusted/self-hosted case, the `else` body is the fork
    // case. Asserting each npmcache value inside its own branch is what makes a
    // swap fail — checking only that both strings appear somewhere would not.
    // The resolve STEP's shell, comments stripped — not the job body. The long
    // rationale comment directly above that shell names both branch values, so a
    // job-body scan would be reading the explanation rather than the code.
    const job = jobs.find(j => j.id === 'runner-target')
    const resolveStep = job.steps.find(s => s.some(l => /^\s*(- )?id: resolve\s*$/.test(l)))
    assert.ok(resolveStep, "expected a step with 'id: resolve' in runner-target")
    const text = code(resolveStep).join('\n')

    const ifAt = text.indexOf('echo \'runner=["self-hosted"')
    const elseAt = text.indexOf('echo \'runner="ubuntu-24.04"\'')
    assert.ok(ifAt !== -1, "expected the self-hosted branch to set runner=[\"self-hosted\", ...]")
    assert.ok(elseAt !== -1, 'expected the fork branch to set runner="ubuntu-24.04"')
    assert.ok(ifAt < elseAt, 'expected the self-hosted branch to come first')

    const selfHostedBranch = text.slice(ifAt, elseAt)
    const hostedBranch = text.slice(elseAt)

    assert.match(
      selfHostedBranch,
      /echo 'npmcache=' >> "\$GITHUB_OUTPUT"/,
      'the self-hosted branch must set npmcache to the EMPTY string — its ~/.npm is already warm, ' +
        'and restoring the 521 MB actions/cache entry over it is what #7383 is about'
    )
    assert.match(
      hostedBranch,
      /echo 'npmcache=npm' >> "\$GITHUB_OUTPUT"/,
      'the fork/hosted branch must set npmcache=npm — a fresh ubuntu-24.04 VM has an empty ~/.npm ' +
        'and genuinely needs the restore'
    )
  })

  // ---- every routed consumer takes the cache from that output --------------

  it('a routed setup-node step that caches at all, caches via npmcache', () => {
    // Not every routed job wants a cache: `scripts-tests` and `release-pr-subject`
    // use setup-node for the Node runtime alone and never install anything, so
    // "has no cache" is correct for them and must stay allowed. The rule is about
    // the value when one IS declared.
    const offenders = []
    for (const { job, step } of setupNodeSteps) {
      if (!ROUTED_RUNNER_OUTPUTS.some(o => job.runsOn.includes(o))) continue
      const cache = stepInput(step, 'cache')
      if (cache !== undefined && cache !== ROUTED_CACHE) {
        offenders.push(`${job.id} (ci.yml:${job.line}) has cache: ${cache}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a job routed through runner-target must take setup-node\'s cache from ' +
        `'cache: ${ROUTED_CACHE}'. Hardcoding 'npm' re-adds a 521 MB per-job download on the ` +
        `self-hosted pool (#7383):\n  ${offenders.join('\n  ')}`
    )
  })

  it('every routed job that runs npm ci declares the routed cache', () => {
    // The other half of the rule, and the one that catches an OMISSION rather
    // than a wrong value: a new routed job that installs dependencies but leaves
    // `cache:` off entirely costs the self-hosted pool nothing (which is why it
    // would go unnoticed) while making every fork PR do a cold `npm ci` of the
    // whole monorepo on a fresh VM.
    // Scans STEP bodies, minus comments — not the whole job. `server-tests-windows`
    // explains its 20-minute budget in prose that mentions `npm ci` twice, so a
    // job-body scan reads two comments as install steps. It reaches the right
    // verdict there only because that job also genuinely installs; a job that
    // merely *discussed* npm ci would be misclassified, and then required to
    // declare a cache it has no use for.
    const installers = jobs.filter(
      job =>
        ROUTED_RUNNER_OUTPUTS.some(o => job.runsOn.includes(o)) &&
        job.steps.some(step => code(step).some(l => /(^|\s)npm ci(\s|$)/.test(l)))
    )
    assert.ok(
      installers.length >= 8,
      `expected >=8 routed jobs running 'npm ci', found ${installers.length} ` +
        '(positive control: if this drops to nothing, the scan stopped seeing install steps)'
    )

    const offenders = installers
      .filter(job => {
        const step = job.steps.find(s => s.some(l => l.includes(SETUP_NODE)))
        return !step || stepInput(step, 'cache') !== ROUTED_CACHE
      })
      .map(job => `${job.id} (ci.yml:${job.line})`)
    assert.deepEqual(
      offenders,
      [],
      `routed jobs that run 'npm ci' must set 'cache: ${ROUTED_CACHE}': ${offenders.join(', ')}`
    )
  })

  it('no setup-node step hardcodes cache: npm', () => {
    // Deliberately covers UNROUTED jobs too. A hosted-pinned job hardcoding the
    // cache is defensible today, but the ones that exist (dashboard-smoke) do not
    // set a cache at all, so there is no legitimate hardcode left in the file —
    // and the moment one appears it is worth a deliberate look rather than a
    // copy-paste. Anchored to step bodies, so ci.yml's comments about `cache: npm`
    // do not trip it.
    const offenders = setupNodeSteps
      .filter(({ step }) => stepInput(step, 'cache') === 'npm')
      .map(({ job }) => `${job.id} (ci.yml:${job.line})`)
    assert.deepEqual(offenders, [], `setup-node steps hardcoding 'cache: npm': ${offenders.join(', ')}`)
  })

  it('every routed cache still declares cache-dependency-path for the hosted branch', () => {
    // `cache-dependency-path` is inert when `cache` resolves to empty, which is
    // exactly what makes it easy to delete as dead config — but it is what the
    // FORK-PR branch keys on. Dropping it would silently narrow the hosted cache
    // key to the default (the root lockfile alone) in a monorepo with three, so
    // a lockfile change under packages/ would reuse a stale entry.
    const cached = setupNodeSteps.filter(({ step }) => stepInput(step, 'cache') === ROUTED_CACHE)
    assert.ok(
      cached.length >= 8,
      `expected >=8 routed-cache setup-node steps, found ${cached.length} ` +
        '(positive control for the assertion below)'
    )

    const missing = cached
      .filter(({ step }) => stepInput(step, 'cache-dependency-path') !== '**/package-lock.json')
      .map(({ job }) => `${job.id} (ci.yml:${job.line})`)
    assert.deepEqual(
      missing,
      [],
      `steps using the routed cache must keep cache-dependency-path: '**/package-lock.json': ${missing.join(', ')}`
    )
  })
})


/**
 * The same rule, across EVERY workflow file — not just ci.yml.
 *
 * This block exists because the first version of this fix did exactly what
 * MEMORY records as the repo's recurring miss: corrected the roster it was
 * looking at and walked past the entry one file over. `maestro-nightly.yml`
 * pins `[self-hosted, macOS, ARM64, chroxy-mac]` and was hardcoding `cache: npm`
 * with a live 1.86 GB entry, restored over a ~/.npm measured at 4.8 GB on that
 * very runner — the identical defect, invisible to a ci.yml-scoped guard, and
 * invisible to the sibling `ci-cache-key.test.js` for the same reason (it also
 * carried the bare `package-lock.json` key that test forbids).
 *
 * A workflow-scoped guard would have to be rewritten every time the class turns
 * up somewhere new. This one is scoped to the DEFECT: any setup-node step whose
 * job names a self-hosted runner literally. That covers files that do not exist
 * yet.
 */
describe('npm cache across all workflows (#7383)', () => {
  let workflows

  before(async () => {
    const dir = new URL('../../../.github/workflows/', import.meta.url)
    const names = (await readdir(dir)).filter(n => n.endsWith('.yml') || n.endsWith('.yaml'))
    workflows = await Promise.all(
      names.map(async name => ({ name, jobs: parseJobs(await readFile(new URL(name, dir), 'utf8')) }))
    )
  })

  it('reads every workflow file', () => {
    // Positive control. A readdir that returns nothing, or a reader that finds no
    // jobs, would make the assertion below vacuous — which is precisely how the
    // maestro-nightly instance stayed invisible in the first place.
    assert.ok(workflows.length >= 5, `expected >=5 workflow files, found ${workflows.length}`)
    assert.ok(
      workflows.some(w => w.name === 'maestro-nightly.yml'),
      'expected maestro-nightly.yml to be among the scanned workflows'
    )
    const totalJobs = workflows.reduce((n, w) => n + w.jobs.length, 0)
    assert.ok(totalJobs >= 20, `expected >=20 jobs across all workflows, found ${totalJobs}`)
  })

  it('no self-hosted job hardcodes an npm cache', () => {
    const offenders = []
    for (const { name, jobs } of workflows) {
      for (const job of jobs) {
        // `runs-on` naming self-hosted LITERALLY. ci.yml's routed jobs go through
        // `runner-target` instead and are covered by the suite above; those may
        // legitimately resolve to a hosted runner for a fork PR.
        if (!/self-hosted/.test(job.runsOn)) continue
        for (const step of job.steps) {
          if (!step.some(l => l.includes(SETUP_NODE))) continue
          const cache = stepInput(step, 'cache')
          if (cache) offenders.push(`${name}:${job.line} ${job.id} -> cache: ${cache}`)
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a job pinned to a self-hosted runner must not restore an npm cache — its ~/.npm is ' +
        `already warm, so the restore is a download over a superset of itself (#7383):\n  ${offenders.join('\n  ')}`
    )
  })
})
