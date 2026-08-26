import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  parseJobs,
  code,
  stepInput,
  readWorkflows,
  assertReaderSane,
  SETUP_NODE,
  ROUTED_CACHE,
  ROUTED_RUNNER_OUTPUTS,
  LOCKFILE_GLOB,
} from './helpers/workflow-reader.js'

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

/**
 * The reader (parseJobs / parseSteps / code / stepInput / readWorkflows) moved to
 * `helpers/workflow-reader.js` in #7386, when `ci-cache-key.test.js` needed the
 * same one. Transcribing it would have made two implementations of the thing
 * both guards depend on being right — see that module's header. Its rationale
 * comments moved with it; nothing here changed behaviourally.
 */

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
      .filter(({ step }) => stepInput(step, 'cache-dependency-path') !== LOCKFILE_GLOB)
      .map(({ job }) => `${job.id} (ci.yml:${job.line})`)
    assert.deepEqual(
      missing,
      [],
      `steps using the routed cache must keep cache-dependency-path: '${LOCKFILE_GLOB}': ${missing.join(', ')}`
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
    workflows = await readWorkflows()
  })

  it('reads every workflow file', () => {
    // Positive control. A readdir that returns nothing, or a reader that finds no
    // jobs, would make the assertion below vacuous — which is precisely how the
    // maestro-nightly instance stayed invisible in the first place. The shared
    // floor lives in the reader module so this guard and ci-cache-key.test.js
    // cannot disagree about what "the reader still works" means.
    assertReaderSane(workflows)
    assert.ok(
      workflows.some(w => w.name === 'maestro-nightly.yml'),
      'expected maestro-nightly.yml to be among the scanned workflows'
    )
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

/**
 * The hosted cache's ONLY producer, pinned (#7386).
 *
 * `docs/decisions/2026-08-npm-cache-producer.md` accepts that no job exists
 * solely to warm the hosted `node-cache-Linux-x64-npm-*` entry that fork PRs
 * restore. That acceptance rests entirely on ONE job being a producer as a side
 * effect: `nightly-k8s-integration.yml`, GitHub-hosted, on a schedule, with
 * `cache: npm`. Until now that invariant existed only as prose in three
 * comments, which is the weakest form this repo has a whole document about.
 *
 * The trap is sharper than "someone might edit it". The all-workflows guard
 * above REQUIRES that a self-hosted job not hardcode an npm cache — correctly,
 * that is #7383. So moving this job to the self-hosted pool would make CI itself
 * demand the removal of `cache: npm`, and the change would go green while
 * silently deleting the last producer. A guard that drives the defect it is
 * adjacent to needs a counterpart, and this is it: move the job self-hosted and
 * THIS fails first, naming the decision record.
 */
describe('the hosted npm cache keeps a producer (#7386)', () => {
  let nightly
  let job
  let step

  before(async () => {
    // Load only. The positive control is an `it()` below, NOT an assertion here:
    // a failed `before()` hook aborts its subtests and node:test still prints
    // `# fail 0` in the aggregate TAP summary. The run does exit non-zero (and
    // assert-test-count.mjs propagates that), but anything reading the summary
    // by eye — or by grep — sees a clean count. That is the reporting half of
    // the very defect class this file guards, so don't create it here.
    const workflows = await readWorkflows()
    nightly = workflows.find(w => w.name === 'nightly-k8s-integration.yml') ?? null
    job = nightly?.jobs.find(j => j.steps.some(st => st.some(l => l.includes(SETUP_NODE)))) ?? null
    step = job?.steps.find(st => st.some(l => l.includes(SETUP_NODE))) ?? null
  })

  it('finds the producer workflow and its setup-node step', async () => {
    const workflows = await readWorkflows()
    assert.ok(
      nightly,
      'nightly-k8s-integration.yml is the only producer of the hosted npm cache ' +
        '(docs/decisions/2026-08-npm-cache-producer.md). If it was renamed, update this ' +
        `guard; if it was deleted, the decision record must be revisited. Saw: ${
          workflows.map(w => w.name).join(', ')
        }`
    )
    assert.ok(job, 'expected a job with a setup-node step in nightly-k8s-integration.yml')
    assert.ok(step, 'expected to locate that setup-node step')
  })

  it('runs on a GitHub-HOSTED runner', () => {
    // The whole point. A self-hosted runner has npmcache empty by #7383's
    // routing and saves nothing, so this job would stop being a producer while
    // still looking like one.
    assert.ok(job, 'producer job not found (see the previous test)')
    assert.doesNotMatch(
      job.runsOn,
      /self-hosted/,
      'the producer must stay GitHub-hosted — a self-hosted runner saves no cache entry ' +
        '(#7383), which would silently remove the last producer of the entry fork PRs ' +
        'restore. See docs/decisions/2026-08-npm-cache-producer.md.'
    )
    assert.match(job.runsOn, /ubuntu-/, `expected an ubuntu- runner, got: ${job.runsOn.trim()}`)
  })

  it('still declares the npm cache with the three-lockfile key', () => {
    assert.ok(step, 'producer setup-node step not found (see the first test)')
    assert.equal(
      stepInput(step, 'cache'),
      'npm',
      'the producer must keep `cache: npm` — without it the job restores nothing AND saves ' +
        'nothing. See docs/decisions/2026-08-npm-cache-producer.md.'
    )
    assert.equal(stepInput(step, 'cache-dependency-path'), LOCKFILE_GLOB)
  })

  it('still runs on a schedule', () => {
    // A producer that only fires on workflow_dispatch is not a producer. Checked
    // on the file text above the jobs mapping, so the reader's job-scoped view
    // does not apply.
    assert.ok(nightly, 'producer workflow not found (see the first test)')
    const header = nightly.text.slice(0, nightly.text.indexOf('\njobs:'))
    assert.match(
      header,
      /^\s*schedule:/m,
      'the producer must stay scheduled — on workflow_dispatch alone it would only warm the ' +
        'cache when someone remembers to. See docs/decisions/2026-08-npm-cache-producer.md.'
    )
    assert.match(header, /cron:/, 'expected a cron entry under schedule:')
  })
})
