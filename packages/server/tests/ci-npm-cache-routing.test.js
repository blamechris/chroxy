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

  it('no setup-node step hardcodes cache: npm, except the named producer', () => {
    // Deliberately covers UNROUTED jobs too: a routed job hardcoding the cache
    // re-adds the 521 MB per-job download on the self-hosted pool, and an
    // unrouted one is worth a deliberate look rather than a copy-paste.
    //
    // #7386 added the first — and so far only — legitimate hardcode, so this is
    // an ALLOWLIST OF ONE rather than a relaxed rule. `dashboard-smoke` is
    // GitHub-hosted, x86_64, unconditional, on push-to-main, and already ran a
    // root `npm ci` with no cache: it cold-installed every run and saved nothing.
    // Caching it makes the job faster AND produces the entry fork PRs restore.
    // See docs/decisions/2026-08-npm-cache-producer.md.
    //
    // Keep this list exact. Widening it to "any hosted job may hardcode" would
    // give back the copy-paste this guard exists to catch, and #7383's cost was
    // nine cancelled jobs across four PRs.
    const ALLOWED_HARDCODED_CACHE = new Set(['dashboard-smoke'])

    const offenders = setupNodeSteps
      .filter(({ job, step }) => stepInput(step, 'cache') === 'npm' && !ALLOWED_HARDCODED_CACHE.has(job.id))
      .map(({ job }) => `${job.id} (ci.yml:${job.line})`)
    assert.deepEqual(
      offenders,
      [],
      "setup-node steps hardcoding 'cache: npm'. Routed jobs must use " +
        `'cache: ${ROUTED_CACHE}'; an unrouted job needs a deliberate entry in ` +
        `ALLOWED_HARDCODED_CACHE with a reason: ${offenders.join(', ')}`
    )

    // The allowlist must not outlive its entries. A stale name here would silently
    // permit a future job that happens to be called `dashboard-smoke`, and would
    // hide the removal of the producer itself.
    const present = new Set(setupNodeSteps.map(({ job }) => job.id))
    const stale = [...ALLOWED_HARDCODED_CACHE].filter(id => !present.has(id))
    assert.deepEqual(
      stale,
      [],
      `ALLOWED_HARDCODED_CACHE names job(s) that no longer have a setup-node step: ${stale.join(', ')}`
    )
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
 * The hosted cache keeps a producer (#7386).
 *
 * `docs/decisions/2026-08-npm-cache-producer.md`: the `node-cache-Linux-x64-npm-*`
 * entry a FORK PR restores on ubuntu-24.04 can only be saved by a job that runs
 * on a GitHub-hosted runner AND on `main` — a PR's cache writes are scoped to its
 * own ref, so no fork ever helps the next one. #7385 emptied `npmcache` on the
 * self-hosted pool, which was right for those runners and left nothing on `main`
 * saving the entry.
 *
 * Two jobs restore that: `dashboard-smoke` on every push to `main` (the primary —
 * it was already hosted and already ran `npm ci` uncached), and the k8s nightly
 * daily (the fallback). Until now the invariant was prose in three comments.
 *
 * The trap is sharper than "someone might edit it". The all-workflows guard above
 * REQUIRES that a self-hosted job not hardcode an npm cache — correctly, that is
 * #7383 — so moving a producer to the self-hosted pool would make CI itself demand
 * the removal of `cache: npm`, going green while deleting the producer. A guard
 * that drives the defect next to it needs a counterpart.
 *
 * SCOPED TO THE PROPERTY, NOT THE ROSTER. This asserts "some hosted job produces
 * the entry on a push to main, and some producer runs on a schedule" — not
 * "these two files exist". Naming files here would rebuild the hardcoded-roster
 * defect that this whole PR and docs/false-safety-guards.md entry 16 are about.
 * Swapping in an equivalent producer passes; removing the last one fails.
 *
 * The `ALLOWED_HARDCODED_CACHE` allowlist in the suite above is name-based, and
 * necessarily so — an exception has to name what it excepts. Its staleness check
 * therefore DOES fire when a producer job is renamed. That is intended: renaming
 * the one job allowed to hardcode `cache: npm` is exactly when someone should
 * re-read why the exception exists.
 */
describe('the hosted npm cache keeps a producer (#7386)', () => {
  let workflows
  let producers

  before(async () => {
    // Load only — the positive control is an `it()` below, never an assertion in
    // `before()`. A failed hook aborts its subtests while node:test still prints
    // `# fail 0` in the aggregate summary; the run exits non-zero (and
    // assert-test-count.mjs propagates that), but anything reading the summary
    // sees a clean count. Measured: an earlier draft reported `pass 11, fail 0`
    // on a mutation it had actually caught. Creating the reporting half of this
    // file's own defect class inside it is not on.
    workflows = await readWorkflows()

    // A PRODUCER: a setup-node step that really saves the hosted entry.
    //   - hosted AND x86_64 (a self-hosted runner has npmcache empty by #7383 and
    //     saves nothing; an ubuntu-*-arm runner saves the arm64 entry, which no
    //     hosted fork job reads),
    //   - unconditionally reachable — a job-level `if:` can switch the producer
    //     off without touching anything this file used to look at,
    //   - `cache: npm` literally — a routed expression resolves to empty on the
    //     self-hosted branch, so a routed job is not a dependable producer,
    //   - the three-lockfile key, or it produces an entry under the WRONG key.
    producers = workflows.flatMap(w =>
      w.jobs.flatMap(job =>
        job.steps
          .filter(st => st.some(l => l.includes(SETUP_NODE)))
          .filter(() => isHostedX64Linux(job.runsOn) && isUnconditional(job))
          .filter(st => stepInput(st, 'cache') === 'npm')
          .filter(st => stepInput(st, 'cache-dependency-path') === LOCKFILE_GLOB)
          .map(() => ({ workflow: w, job }))
      )
    )
  })

  /** The `on:` block — everything above the jobs mapping. */
  const triggers = w => w.text.slice(0, w.text.indexOf('\njobs:'))

  /** The lines strictly more indented than `lines[at]` (its YAML sub-block). */
  const subBlock = (lines, at) => {
    const indent = /^(\s*)/.exec(lines[at])[1].length
    const out = []
    for (let i = at + 1; i < lines.length; i++) {
      if (/^\s*$/.test(lines[i]) || /^\s*#/.test(lines[i])) continue
      if (/^(\s*)/.exec(lines[i])[1].length <= indent) break
      out.push(lines[i])
    }
    return out
  }

  /** The sub-block under the first line matching `re`, plus that line's own tail. */
  const blockFor = (lines, re) => {
    const at = lines.findIndex(l => re.test(l))
    if (at === -1) return null
    return [lines[at], ...subBlock(lines, at)].join('\n')
  }

  /**
   * Does this workflow run on a push to the DEFAULT BRANCH, unfiltered?
   *
   * Three loose-match traps, each measured green before being closed:
   *
   * 1. Not `/push:/`. `release.yml` is `on: push: tags: ['v*']` with hosted jobs
   *    that DO carry `cache: npm` and the right key, so a bare match let it stand
   *    in for the real producer — deleting dashboard-smoke's cache left the suite
   *    GREEN.
   * 2. Not `branches:` and `main` tested INDEPENDENTLY over the push block. A
   *    `paths: [packages/main-app/**]` alongside `branches: [release]` satisfies
   *    both halves while the workflow never runs on main. The branch check now
   *    reads the `branches:` sub-block only.
   * 3. A `paths:`/`paths-ignore:` filter makes the push conditional on which
   *    files changed — so a lockfile-only change could skip the producer, which
   *    is precisely when the cache needs re-saving. Treated as not-a-producer.
   */
  const triggersOnPushToMain = w => {
    const lines = triggers(w).split('\n')
    const at = lines.findIndex(l => /^\s*push:\s*$/.test(l))
    if (at === -1) return false
    const push = subBlock(lines, at)
    if (push.some(l => /^\s*paths(-ignore)?:/.test(l))) return false
    const branches = blockFor(push, /^\s*branches:/)
    return branches !== null && /\bmain\b/.test(branches)
  }

  /**
   * A GitHub-hosted x86_64 Linux runner.
   *
   * `/ubuntu-/` alone was wrong on the one axis this whole record is built on:
   * `ubuntu-24.04-arm` is a real GitHub label, and it saves
   * `node-cache-Linux-arm64-*` — NOT the `Linux-x64` entry a fork PR on
   * ubuntu-24.04 restores. Measured: moving the producer there left the suite
   * green while the entry stopped being produced.
   */
  const isHostedX64Linux = runsOn =>
    !/self-hosted/.test(runsOn) && /ubuntu-/.test(runsOn) && !/\barm\b|arm64/i.test(runsOn)

  /**
   * Is the job unconditionally reachable — no job-level `if:`?
   *
   * ci.yml's comment on the producer tells the reader not to "gate it behind an
   * `if:`/`needs:`" and says this file pins that. It did not: adding
   * `if: github.event_name == 'pull_request'` to dashboard-smoke left the suite
   * at pass 15 / fail 0 with the producer gone. A comment claiming a stronger
   * check than its code performs is this repo's entry-13 shape, so the code now
   * matches the comment rather than the comment being softened.
   *
   * Job-level only: a step-level `if:` is normal and irrelevant here, so scan
   * the job body ABOVE `steps:`.
   */
  const isUnconditional = job => {
    const stepsAt = job.body.findIndex(l => /^\s*steps:\s*$/.test(l))
    const head = stepsAt === -1 ? job.body : job.body.slice(0, stepsAt)
    return !head.some(l => /^\s{2,}if:/.test(l))
  }

  it('finds at least one producer at all', () => {
    // Positive control AND the load-bearing assertion. If this reaches zero, every
    // fork PR cold-installs the monorepo across ~12 jobs and nothing else notices.
    assert.ok(
      producers.length > 0,
      'NO job produces the hosted npm cache. A fork PR on ubuntu-24.04 restores ' +
        '`node-cache-Linux-x64-npm-*`, and only a GitHub-hosted job running on `main` with ' +
        '`cache: npm` + the three-lockfile key can save it. See ' +
        'docs/decisions/2026-08-npm-cache-producer.md for what to restore and where.'
    )
  })

  it('at least one producer runs on every push to main', () => {
    // The primary. A daily producer alone leaves a window after each lockfile
    // change; a push-to-main producer closes it.
    const onPush = producers.filter(p => triggersOnPushToMain(p.workflow))
    assert.ok(
      onPush.length > 0,
      'no push-to-main producer. Something must save the hosted cache on every push, or a ' +
        'lockfile change leaves fork PRs cold-installing until the next scheduled producer. ' +
        `Producers found: ${producers.map(p => `${p.workflow.name}:${p.job.id}`).join(', ') || '(none)'}`
    )
  })

  it('at least one producer runs on a schedule', () => {
    // The fallback. Keeps the entry warm even if the push producer is skipped,
    // and re-saves after the 7-day eviction on a quiet week.
    const onSchedule = producers.filter(p => /^\s*schedule:/m.test(triggers(p.workflow)))
    assert.ok(
      onSchedule.length > 0,
      'no scheduled producer. Producers found: ' +
        `${producers.map(p => `${p.workflow.name}:${p.job.id}`).join(', ') || '(none)'}`
    )
  })

  it('no producer sits on a self-hosted runner', () => {
    // The counterpart to the all-workflows self-hosted rule above: that guard
    // would DEMAND removing `cache: npm` from a producer moved to the self-hosted
    // pool. This one fails first, and says why.
    const stranded = workflows.flatMap(w =>
      w.jobs
        .filter(job => /self-hosted/.test(job.runsOn))
        .filter(job =>
          job.steps.some(st => st.some(l => l.includes(SETUP_NODE)) && stepInput(st, 'cache') === 'npm')
        )
        .map(job => `${w.name}:${job.id}`)
    )
    assert.deepEqual(
      stranded,
      [],
      'a job on a self-hosted runner declares `cache: npm`. It saves nothing there (#7383), so ' +
        'if this was a producer being moved, the move removed a producer — and the ' +
        'all-workflows guard above will now demand you delete the `cache:` line, completing it ' +
        `silently. See docs/decisions/2026-08-npm-cache-producer.md:\n  ${stranded.join('\n  ')}`
    )
  })
})
