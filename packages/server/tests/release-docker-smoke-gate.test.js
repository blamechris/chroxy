import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWorkflows, assertReaderSane, stepInput, stepRun } from './helpers/workflow-reader.js'
import {
  BUILD_PUSH_ACTION_RE,
  dangerousIfIssue,
  stepIsBuildStep,
  stepPublishesImage,
  stepUsesLoginAction,
  tagsBlockContainsExactTag,
} from './helpers/release-publish.js'

/**
 * release.yml: every job that publishes the Docker image smokes it first
 * (#8150; review round 2 fixes four vacuity holes found in the first
 * version of this gate — C1-C4 below).
 *
 * THE DEFECT. `docker` built the root Dockerfile with `docker/build-push-
 * action`, `push: true`, and pushed straight to GHCR — nothing in the job
 * ever started the image, which is exactly how the v0.11.0 image shipped
 * unable to start at all (`ERR_MODULE_NOT_FOUND`, #8133).
 *
 * THE INVARIANT. Every job with a publishing step: has a step that runs
 * `docker-image-smoke.sh` as a bare, unwrapped command (not `|| true`,
 * not commented out, not preceded by `set +e`); every publishing step runs
 * strictly after it; nothing rebuilds the image between the smoke and the
 * last publish (S1); nothing between the smoke and a publish can swallow a
 * failure via `continue-on-error` or a status-function `if:` that isn't
 * exactly `success()`; the tag handed to the smoke script is one an EARLIER
 * build-push-action step's `tags:` input structurally contains, as an exact
 * line (C1); and a `docker/login-action` step never runs before the smoke
 * (registry credentials have no reason to exist while an unproven image is
 * being built and started).
 *
 * WHAT ROUND 1 GOT WRONG, each reproduced by its own review-supplied mutant
 * before being fixed (see the mutation-proof describe block below):
 *
 *  - C1: "was the tag built?" read EVERY raw line of every earlier step,
 *    including a comment `workflow-reader.js`'s `parseSteps` attaches to the
 *    step BEFORE the one it visually precedes — so a comment merely
 *    mentioning the tag satisfied the check with the tag deleted from the
 *    real `tags:` list. Fixed by `tagsBlockContainsExactTag`, which reads
 *    the `tags:` key's value STRUCTURALLY (comments stripped first).
 *  - C2: the smoke step was found by "does any run body MENTION the
 *    script", so `... || true`, `; exit 0`, a preceding `set +e`, or the
 *    invocation simply being commented out (with something else run
 *    instead) all still "found" a smoke step and the gate passed. Fixed by
 *    requiring the step's ENTIRE run body, trimmed, to be exactly
 *    `bash scripts/docker-image-smoke.sh <tag>` — and by applying the
 *    if:/continue-on-error checks to every step that so much as MENTIONS the
 *    script, so a decoy can't quietly take the real smoke step's slot.
 *  - C3: the dangerous-if check enumerated unsafe function names
 *    (`always()`/`failure()`/`cancelled()`), which a status function's
 *    OPERAND ORDER defeats: `if: X || success()`, `if: !success()`, and
 *    `if: true || success()` all pass a check that never named `success`
 *    itself as dangerous. Fixed by requiring the SAFE form instead: a
 *    publishing step's `if:` must be absent or exactly `success()`; ANY
 *    other expression containing a status-function call is an issue.
 *  - C4: a build-push-action step counted as "not publishing" unless
 *    `push:` was the literal string `'true'` — so `push: True`, `push: ${{
 *    expr }}`, or an `outputs:` targeting a registry directly (`type=
 *    registry`, `push=true`) all passed as non-publishing. Fixed by failing
 *    CLOSED: non-publishing only when `push` is `false`/absent AND
 *    `outputs:` contains neither of those.
 *
 * S1/S2 (non-critical, folded in the same round): the rule now also reports
 * a rebuild between the smoke and the last publish, and it runs over every
 * job in release.yml with a publishing step rather than looking the job up
 * by the id `docker` — a copy of the push step pasted into a new job with no
 * smoke step is caught precisely because nothing here assumes there is only
 * one such job.
 */

// ---- the pure rule, over already-parsed step bodies ------------------------

const SMOKE_SCRIPT_RE = /scripts\/docker-image-smoke\.sh/
// The step's ENTIRE run body, trimmed, must be exactly this — one bare
// command, nothing wrapping or following it (C2).
const PINNED_SMOKE_RE = /^bash scripts\/docker-image-smoke\.sh (\S+)$/

/** True when `stepLines` carries a truthy `continue-on-error:` — any value
 * other than the literal `false` can suppress a real failure. */
function stepHasContinueOnError(stepLines) {
  const val = stepInput(stepLines, 'continue-on-error')
  return val !== undefined && val !== 'false'
}

/** Every step index whose run body so much as MENTIONS the smoke script —
 * the broad, "could this be a decoy" set C2 requires checking if:/
 * continue-on-error on, regardless of whether it turns out to be the real
 * invocation. */
export function candidateSmokeStepIndices(steps) {
  const idx = []
  steps.forEach((s, i) => {
    if (SMOKE_SCRIPT_RE.test(stepRun(s) || '')) idx.push(i)
  })
  return idx
}

/** True when this step's run body is EXACTLY (trimmed) a bare
 * `bash scripts/docker-image-smoke.sh <tag>` — no wrapper, no trailing
 * `|| true` / `; exit 0`, no preceding `set +e`, not commented out. */
export function isPinnedSmokeInvocation(stepLines) {
  const runBody = stepRun(stepLines)
  if (typeof runBody !== 'string') return false
  return PINNED_SMOKE_RE.test(runBody.trim())
}

/** The tag argument a pinned smoke invocation passes, or undefined. */
function smokeTagOf(stepLines) {
  const runBody = stepRun(stepLines) || ''
  const m = PINNED_SMOKE_RE.exec(runBody.trim())
  return m ? m[1] : undefined
}

export function publishingStepIndices(steps) {
  const idx = []
  steps.forEach((s, i) => {
    if (stepPublishesImage(s)) idx.push(i)
  })
  return idx
}

function loginStepIndices(steps) {
  const idx = []
  steps.forEach((s, i) => {
    if (stepUsesLoginAction(s)) idx.push(i)
  })
  return idx
}

/**
 * Everything wrong with a job's smoke-before-push gate, or `[]` when sound.
 * See the module doc comment for the invariant and the four C1-C4 defects
 * this closes.
 *
 * @param {{steps: string[][]}} job
 * @returns {string[]}
 */
export function dockerSmokeGateIssues(job) {
  const steps = job && job.steps
  if (!steps || steps.length === 0) {
    return ['job has no steps at all — cannot verify the smoke gate']
  }

  const candidates = candidateSmokeStepIndices(steps)
  if (candidates.length === 0) {
    return ['no step runs scripts/docker-image-smoke.sh']
  }

  const issues = []
  // C2: apply if:/continue-on-error checks to EVERY step that mentions the
  // script, not just the one recognised as the real invocation — a decoy
  // must not be able to hide behind "it wasn't the real smoke step".
  for (const i of candidates) {
    if (stepInput(steps[i], 'if') !== undefined) {
      issues.push(`step at index ${i} mentions docker-image-smoke.sh and has an if: condition that could skip it`)
    }
    if (stepHasContinueOnError(steps[i])) {
      issues.push(`step at index ${i} mentions docker-image-smoke.sh and has continue-on-error set — a real smoke failure might not fail the job`)
    }
  }

  const smokeIdx = candidates.find((i) => isPinnedSmokeInvocation(steps[i]))
  if (smokeIdx === undefined) {
    issues.push(
      `found ${candidates.length} step(s) mentioning docker-image-smoke.sh (indices: ${candidates.join(', ')}) but none runs it as a bare ` +
        "'bash scripts/docker-image-smoke.sh <tag>' command with nothing else on the line — a wrapped, guarded, or commented-out " +
        'invocation could swallow a real failure'
    )
    return issues
  }

  const pubIdx = publishingStepIndices(steps)
  if (pubIdx.length === 0) {
    issues.push(
      'no publishing step found (a build-push-action step that is not fail-closed-safe, or a run step invoking a raw-CLI publish ' +
        'command) — nothing here actually ships the image'
    )
    return issues
  }

  for (const i of pubIdx) {
    if (i <= smokeIdx) {
      issues.push(`publishing step at index ${i} runs at or before the smoke step (index ${smokeIdx}) — the image could ship before it is smoked`)
      continue
    }
    for (let j = smokeIdx; j < i; j++) {
      if (stepHasContinueOnError(steps[j])) {
        issues.push(`step at index ${j} (between the smoke step and the publishing step at ${i}) has continue-on-error set`)
      }
    }
    // C3: the SAFE form only — absent, or exactly success().
    const pushIf = stepInput(steps[i], 'if')
    const ifIssue = dangerousIfIssue(pushIf)
    if (ifIssue) {
      issues.push(`publishing step at index ${i} has a ${ifIssue}`)
    }
  }

  // S1: nothing may rebuild the image between the smoke and the LAST
  // publish — "never rebuilt" is part of the invariant, not a side note.
  const maxPubIdx = Math.max(...pubIdx)
  for (let i = smokeIdx + 1; i <= maxPubIdx; i++) {
    if (stepIsBuildStep(steps[i])) {
      issues.push(`step at index ${i} builds the image again between the smoke step and the last publishing step — what is pushed may not be what was smoked`)
    }
  }

  // Login must not run before the smoke — see release.yml's job header.
  for (const i of loginStepIndices(steps)) {
    if (i < smokeIdx) {
      issues.push(`step at index ${i} logs in to a registry BEFORE the smoke step (index ${smokeIdx}) — credentials are present while an unproven image is built and started`)
    }
  }

  // C1: the tag must be one an EARLIER build-push-action step's tags: input
  // structurally contains, as an exact line — not merely mentioned in prose
  // anywhere in an earlier step's raw text.
  const tag = smokeTagOf(steps[smokeIdx])
  if (!tag) {
    issues.push('could not find the image tag argument passed to docker-image-smoke.sh')
  } else {
    const builtEarlier = steps
      .slice(0, smokeIdx)
      .some((s) => stepInput(s, 'uses') && BUILD_PUSH_ACTION_RE.test(stepInput(s, 'uses')) && tagsBlockContainsExactTag(s, tag))
    if (!builtEarlier) {
      issues.push(`the smoke step's tag (${tag}) is not present, as an exact tags: entry, in any build-push-action step before it — nothing built that tag`)
    }
  }

  return issues
}

/** Every job in `jobs` that has at least one publishing step. */
export function jobsWithPublishingSteps(jobs) {
  return jobs.filter((j) => publishingStepIndices(j.steps).length > 0)
}

/**
 * `dockerSmokeGateIssues` over every job with a publishing step, never a
 * single job looked up by id (S2) — `{}` means every such job is sound.
 *
 * @param {{id: string, steps: string[][]}[]} jobs
 * @returns {Record<string, string[]>}
 */
export function allDockerSmokeGateIssues(jobs) {
  const findings = {}
  for (const job of jobsWithPublishingSteps(jobs)) {
    const issues = dockerSmokeGateIssues(job)
    if (issues.length > 0) findings[job.id] = issues
  }
  return findings
}

// ---- the rule, on the real tree --------------------------------------------

describe('release.yml: every job that publishes the image smokes it first (#8150)', () => {
  let release
  let dockerJob

  before(async () => {
    const workflows = await readWorkflows()
    assertReaderSane(workflows)
    release = workflows.find((w) => w.name === 'release.yml')
    assert.ok(release, 'expected release.yml among the scanned workflows')
    dockerJob = release.jobs.find((j) => j.id === 'docker')
    assert.ok(dockerJob, "expected a 'docker' job in release.yml")
  })

  it('floor: at least one job in release.yml has a publishing step (not the vacuous empty-set pass)', () => {
    assert.ok(jobsWithPublishingSteps(release.jobs).length >= 1, 'expected >=1 job with a publishing step')
  })

  it('CONTROL: exactly one job has a publishing step, and it is docker', () => {
    const jobs = jobsWithPublishingSteps(release.jobs)
    assert.deepEqual(jobs.map((j) => j.id), ['docker'])
  })

  it('CONTROL: exactly one step in the docker job actually publishes, and it is the push step by structural classification (not a raw-text match)', () => {
    const pubIdx = publishingStepIndices(dockerJob.steps)
    assert.equal(pubIdx.length, 1, `expected exactly 1 publishing step, found indices: ${pubIdx.join(', ')}`)
    assert.equal(stepInput(dockerJob.steps[pubIdx[0]], 'name'), 'Push the smoked image')
  })

  it('CONTROL: the build step (push: false, no registry-targeting outputs:) is NOT counted as publishing', () => {
    const buildStep = dockerJob.steps.find((s) => (stepInput(s, 'uses') || '').includes('docker/build-push-action'))
    assert.ok(buildStep, 'expected a build-push-action step')
    assert.equal(stepPublishesImage(buildStep), false)
  })

  it('CONTROL: login runs AFTER the smoke step', () => {
    const smokeIdx = candidateSmokeStepIndices(dockerJob.steps).find((i) => isPinnedSmokeInvocation(dockerJob.steps[i]))
    const loginIdx = dockerJob.steps.findIndex((s) => stepUsesLoginAction(s))
    assert.ok(loginIdx > smokeIdx, `expected login (index ${loginIdx}) to run after the smoke step (index ${smokeIdx})`)
  })

  it('every job with a publishing step is sound: smoke runs unwrapped, gates every publish, and nothing rebuilds after it', () => {
    const findings = allDockerSmokeGateIssues(release.jobs)
    assert.deepEqual(findings, {}, `smoke gate unsound: ${JSON.stringify(findings)}`)
  })
})

/**
 * S5: the release build+load path is exercised on every Docker-touching PR,
 * not just at release time — ci.yml's `docker-image-smoke` job builds with
 * the SAME pinned `docker/build-push-action` ref, `load: true` / `push:
 * false`, and runs the SAME pinned smoke-invocation shape release.yml does.
 */
describe("ci.yml's docker-image-smoke job exercises the same build+load path as release.yml (#8150, S5)", () => {
  let releaseBuildStep
  let releaseSmokeStep
  let ciBuildStep
  let ciSmokeStep

  before(async () => {
    const workflows = await readWorkflows()
    const release = workflows.find((w) => w.name === 'release.yml')
    const ci = workflows.find((w) => w.name === 'ci.yml')
    assert.ok(release && ci, 'expected both release.yml and ci.yml among the scanned workflows')

    const dockerJob = release.jobs.find((j) => j.id === 'docker')
    assert.ok(dockerJob, "expected a 'docker' job in release.yml")
    releaseBuildStep = dockerJob.steps.find((s) => (stepInput(s, 'uses') || '').includes('docker/build-push-action'))
    releaseSmokeStep = dockerJob.steps.find((s) => isPinnedSmokeInvocation(s))
    assert.ok(releaseBuildStep && releaseSmokeStep, 'expected a build step and a pinned smoke step in release.yml\'s docker job')

    const smokeJob = ci.jobs.find((j) => j.id === 'docker-image-smoke')
    assert.ok(smokeJob, "expected a 'docker-image-smoke' job in ci.yml")
    ciBuildStep = smokeJob.steps.find((s) => (stepInput(s, 'uses') || '').includes('docker/build-push-action'))
    ciSmokeStep = smokeJob.steps.find((s) => isPinnedSmokeInvocation(s))
    assert.ok(ciBuildStep && ciSmokeStep, 'expected a build-push-action step and a pinned smoke step in ci.yml\'s docker-image-smoke job')
  })

  it('both build steps use the SAME pinned build-push-action ref', () => {
    const releaseUses = stepInput(releaseBuildStep, 'uses')
    const ciUses = stepInput(ciBuildStep, 'uses')
    assert.equal(ciUses, releaseUses)
  })

  it('both build steps set load: true and push: false', () => {
    for (const [label, step] of [['release.yml', releaseBuildStep], ['ci.yml', ciBuildStep]]) {
      assert.equal(stepInput(step, 'load'), 'true', `${label}'s build step should set load: true`)
      assert.equal(stepInput(step, 'push'), 'false', `${label}'s build step should set push: false`)
    }
  })

  it('both smoke run bodies are exactly the pinned form (trimmed)', () => {
    const releaseBody = stepRun(releaseSmokeStep).trim()
    const ciBody = stepRun(ciSmokeStep).trim()
    assert.ok(PINNED_SMOKE_RE.test(releaseBody), `release.yml's smoke body is not the pinned form: ${releaseBody}`)
    assert.ok(PINNED_SMOKE_RE.test(ciBody), `ci.yml's smoke body is not the pinned form: ${ciBody}`)
  })
})

/**
 * Each branch of the pure rule proven to REPORT — the real tree is sound, so
 * without these a deleted or broken rule is invisible.
 */
describe('dockerSmokeGateIssues reports each shape it exists to find (#8150)', () => {
  const soundSteps = () => [
    ['      - uses: actions/checkout@x'],
    ['      - name: Extract metadata', '        id: meta', '        uses: docker/metadata-action@x'],
    [
      '      - name: Build (local, unpushed)',
      '        uses: docker/build-push-action@x',
      '        with:',
      '          load: true',
      '          push: false',
      '          tags: |',
      '            ghcr.io/x/y:1',
      '            chroxy:release-smoke',
    ],
    ['      - name: Smoke-start the built image', '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke'],
    ['      - name: Log in to GHCR', '        uses: docker/login-action@x'],
    ['      - name: Push the smoked image', '        run: |', '          docker push ghcr.io/x/y:1'],
  ]

  it('CONTROL: a sound job reports nothing', () => {
    assert.deepEqual(dockerSmokeGateIssues({ steps: soundSteps() }), [])
  })

  it('floor: a job with NO steps at all is reported, not silently passed', () => {
    const issues = dockerSmokeGateIssues({ steps: [] })
    assert.equal(issues.length, 1)
    assert.match(issues[0], /no steps at all/)
  })

  it('floor: a job that never mentions the smoke script at all is reported', () => {
    const steps = soundSteps().filter((s) => !s.some((l) => l.includes('docker-image-smoke.sh')))
    const issues = dockerSmokeGateIssues({ steps })
    assert.equal(issues.length, 1)
    assert.match(issues[0], /no step runs scripts\/docker-image-smoke\.sh/)
  })

  it('floor: no publishing step at all is reported', () => {
    const steps = soundSteps().filter((s) => !s.some((l) => l.includes('docker push')))
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /no publishing step found/.test(i)), JSON.stringify(issues))
  })

  it('reports a publishing step that runs BEFORE the smoke step', () => {
    const steps = soundSteps()
    ;[steps[3], steps[5]] = [steps[5], steps[3]]
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /runs at or before the smoke step/.test(i)), JSON.stringify(issues))
  })

  // ---- C1: the tag-was-built check must read tags: structurally ----------
  it('C1: reports a smoke tag missing from the build step\'s (structural) tags: list', () => {
    const steps = soundSteps()
    steps[2] = steps[2].map((l) => (l.trim() === 'chroxy:release-smoke' ? '            chroxy:some-other-tag' : l))
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /not present, as an exact tags: entry/.test(i)), JSON.stringify(issues))
  })

  it('C1 regression guard: a COMMENT merely mentioning the tag does NOT satisfy the check', () => {
    const steps = soundSteps()
    // Remove the tag from the real tags: list, but leave prose mentioning it
    // on an earlier, unrelated step — reproduces the exact #8150 review
    // shape (a step's comment, which parseSteps attaches to the PRECEDING
    // step, mentioning the tag that was deleted from the real list).
    steps[2] = steps[2].filter((l) => l.trim() !== 'chroxy:release-smoke')
    steps[1] = [...steps[1], '      # mentions chroxy:release-smoke in prose only, never a real tags: entry']
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /not present, as an exact tags: entry/.test(i)), JSON.stringify(issues))
  })

  // ---- C2: the smoke step must be a bare, unwrapped command --------------
  for (const [label, runLines] of [
    ['`|| true`', ['        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke || true']],
    ['`; exit 0`', ['        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke ; exit 0']],
    ['a preceding `set +e`', ['        run: |', '          set +e', '          bash scripts/docker-image-smoke.sh chroxy:release-smoke']],
    ['commented out, replaced with echo', ['        run: |', '          # bash scripts/docker-image-smoke.sh chroxy:release-smoke', '          echo "smoke skipped"']],
    ['a decoy `true ||` prefix', ['        run: true || bash scripts/docker-image-smoke.sh chroxy:release-smoke']],
  ]) {
    it(`C2: reports a smoke invocation wrapped with ${label}`, () => {
      const steps = soundSteps()
      steps[3] = ['      - name: Smoke-start the built image', ...runLines]
      const issues = dockerSmokeGateIssues({ steps })
      assert.ok(
        issues.some((i) => /none runs it as a bare/.test(i)),
        `${label}: expected a "not a bare invocation" issue, got: ${JSON.stringify(issues)}`
      )
    })
  }

  it('C2: if:/continue-on-error checks apply even to a step that only MENTIONS the script (a decoy)', () => {
    const steps = soundSteps()
    steps[3] = ['      - name: Smoke-start the built image', '        run: echo "mentions scripts/docker-image-smoke.sh in a string but does not run it"', '        continue-on-error: true']
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /mentions docker-image-smoke\.sh and has continue-on-error set/.test(i)), JSON.stringify(issues))
  })

  it('reports continue-on-error: true on the real smoke step itself', () => {
    const steps = soundSteps()
    steps[3] = [...steps[3], '        continue-on-error: true']
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /continue-on-error set/.test(i)), JSON.stringify(issues))
  })

  it('reports an if: on the real smoke step itself', () => {
    const steps = soundSteps()
    steps[3] = [steps[3][0], "        if: runner.os == 'Linux'", ...steps[3].slice(1)]
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /has an if:/.test(i)), JSON.stringify(issues))
  })

  it('reports continue-on-error: true on a step BETWEEN the smoke step and the push step', () => {
    const steps = soundSteps()
    steps.splice(4, 0, ['      - name: Some step in between', '        run: echo hi', '        continue-on-error: true'])
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /between the smoke step and the publishing step.*continue-on-error/.test(i)), JSON.stringify(issues))
  })

  // ---- C3: the dangerous-if rule must be operand-order-proof -------------
  for (const [label, expr] of [
    ['X || success()', "github.event_name == 'workflow_dispatch' || success()"],
    ['!success()', '!success()'],
    ['true || success()', 'true || success()'],
  ]) {
    it(`C3: reports a push step whose if: is unsafe by operand order (${label})`, () => {
      const steps = soundSteps()
      const push = steps[5]
      steps[5] = [push[0], `        if: ${expr}`, ...push.slice(1)]
      const issues = dockerSmokeGateIssues({ steps })
      assert.ok(issues.some((i) => /dangerous if:/.test(i)), `${label}: ${JSON.stringify(issues)}`)
    })
  }

  it('C3 CONTROL: if: success() alone on the push step is safe', () => {
    const steps = soundSteps()
    const push = steps[5]
    steps[5] = [push[0], '        if: success()', ...push.slice(1)]
    assert.deepEqual(dockerSmokeGateIssues({ steps }), [])
  })

  // ---- C4: stepPublishesImage must fail closed ---------------------------
  it('C4: an `outputs: type=registry` build step publishes even with push: false', () => {
    const step = ['      - uses: docker/build-push-action@x', '        with:', '          push: false', '          outputs: type=registry']
    assert.equal(stepPublishesImage(step), true)
  })

  it('C4: `push: True` (not the literal lowercase false) publishes', () => {
    const step = ['      - uses: docker/build-push-action@x', '        with:', '          push: True']
    assert.equal(stepPublishesImage(step), true)
  })

  it('C4 CONTROL: push absent entirely is non-publishing (build-push-action defaults push to false)', () => {
    const step = ['      - uses: docker/build-push-action@x', '        with:', '          context: .']
    assert.equal(stepPublishesImage(step), false)
  })

  it('C4: the docker job itself goes RED when the build step gains outputs: type=registry', () => {
    const steps = soundSteps()
    steps[2] = [...steps[2], '          outputs: type=registry']
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /runs at or before the smoke step/.test(i)), JSON.stringify(issues))
  })

  for (const [label, runLine] of [
    ['`docker image push`', '          docker image push ghcr.io/x/y:1'],
    ['`docker manifest push`', '          docker manifest push ghcr.io/x/y:1'],
    ['`docker buildx imagetools create`', '          docker buildx imagetools create -t ghcr.io/x/y:1 ghcr.io/x/y:1@sha256:abc'],
    ['`docker buildx ... --push`', '          docker buildx build --platform linux/amd64 --tag ghcr.io/x/y:1 --push .'],
    ['`--output type=registry`', '          docker buildx build --output type=registry,name=ghcr.io/x/y:1 .'],
  ]) {
    it(`detects a raw-CLI publish step (${label})`, () => {
      assert.equal(stepPublishesImage(['      - name: publisher', '        run: |', runLine]), true, `expected ${label} to be detected as publishing`)
    })
  }

  // ---- S1: nothing may rebuild between smoke and the last publish -------
  it('S1: reports a SECOND build-push-action step between the smoke and the push', () => {
    const steps = soundSteps()
    steps.splice(4, 0, ['      - name: Rebuild for some reason', '        uses: docker/build-push-action@x', '        with:', '          push: false'])
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /builds the image again between the smoke step and the last publishing step/.test(i)), JSON.stringify(issues))
  })

  it('S1: reports a raw `docker build` run step between the smoke and the push', () => {
    const steps = soundSteps()
    steps.splice(4, 0, ['      - name: Rebuild via CLI', '        run: docker build -t chroxy:local .'])
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /builds the image again/.test(i)), JSON.stringify(issues))
  })

  // ---- login-before-smoke nitpick -----------------------------------------
  it('reports a docker/login-action step that runs BEFORE the smoke step', () => {
    const steps = soundSteps()
    const login = steps[4]
    steps.splice(4, 1) // remove login from its sound (post-smoke) position
    steps.splice(1, 0, login) // and put it before everything else
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /logs in to a registry BEFORE the smoke step/.test(i)), JSON.stringify(issues))
  })

  // ---- S2: the rule must not be keyed to a single job id -----------------
  it('S2: jobsWithPublishingSteps finds every job with a publishing step, not just one named docker', () => {
    const jobs = [
      { id: 'docker', steps: soundSteps() },
      { id: 'rogue-publish', steps: [['      - name: Push', '        run: docker push ghcr.io/x/y:1']] },
      { id: 'lint', steps: [['      - run: echo hi']] },
    ]
    assert.deepEqual(jobsWithPublishingSteps(jobs).map((j) => j.id), ['docker', 'rogue-publish'])
  })

  it('S2: allDockerSmokeGateIssues reports the rogue job by id, and leaves the sound one alone', () => {
    const jobs = [
      { id: 'docker', steps: soundSteps() },
      { id: 'rogue-publish', steps: [['      - name: Push', '        run: docker push ghcr.io/x/y:1']] },
    ]
    const findings = allDockerSmokeGateIssues(jobs)
    assert.deepEqual(Object.keys(findings), ['rogue-publish'])
    assert.ok(findings['rogue-publish'].some((i) => /no step runs scripts\/docker-image-smoke\.sh/.test(i)))
  })
})

/**
 * The WIRING, proven against a mutated COPY of the real workflow tree —
 * never the real file. Anchors are step KEYS (`- name:` / `run:` lines),
 * never comment prose, so a doc-comment edit elsewhere can't silently break
 * a mutant's `find` string (#8150 review nitpick).
 */
describe('the rule reads the real release.yml (mutation proof, #8150)', () => {
  const dirs = []
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  const REAL = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url))

  async function loadDockerJob(dir) {
    const workflows = await readWorkflows(pathToFileURL(`${dir}/`))
    const release = workflows.find((w) => w.name === 'release.yml')
    assert.ok(release, 'expected release.yml among the scanned workflows in the mutated copy')
    const job = release.jobs.find((j) => j.id === 'docker')
    assert.ok(job, "expected a 'docker' job in the mutated copy")
    return { release, job }
  }

  function freshCopy() {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-docker-smoke-gate-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    return dir
  }

  function mutate(target, find, replace) {
    const text = readFileSync(target, 'utf8')
    const occurrences = text.split(find).length - 1
    assert.equal(
      occurrences, 1,
      `expected exactly 1 occurrence of ${JSON.stringify(find.slice(0, 80))}, found ${occurrences} — release.yml has drifted from what this mutant edits`
    )
    writeFileSync(target, text.replace(find, replace))
  }

  it('CONTROL: an unmutated copy is clean', async () => {
    const dir = freshCopy()
    const { job } = await loadDockerJob(dir)
    assert.deepEqual(dockerSmokeGateIssues(job), [])
  })

  it('C1: goes RED when chroxy:release-smoke is removed ONLY from the build step\'s tags:', async () => {
    const dir = freshCopy()
    const target = join(dir, 'release.yml')
    mutate(target, '            ${{ steps.meta.outputs.tags }}\n            chroxy:release-smoke\n', '            ${{ steps.meta.outputs.tags }}\n')
    const { job } = await loadDockerJob(dir)
    const issues = dockerSmokeGateIssues(job)
    assert.ok(issues.some((i) => /not present, as an exact tags: entry/.test(i)), JSON.stringify(issues))
  })

  for (const [label, find, replace] of [
    ['`|| true`', '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke', '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke || true'],
    ['`; exit 0`', '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke', '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke ; exit 0'],
    [
      'a preceding `set +e`',
      '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke',
      '        run: |\n          set +e\n          bash scripts/docker-image-smoke.sh chroxy:release-smoke',
    ],
    [
      'commented out, replaced with echo',
      '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke',
      '        run: |\n          # bash scripts/docker-image-smoke.sh chroxy:release-smoke\n          echo "smoke skipped"',
    ],
    [
      'a decoy `true ||` prefix',
      '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke',
      '        run: true || bash scripts/docker-image-smoke.sh chroxy:release-smoke',
    ],
  ]) {
    it(`C2: goes RED when the smoke invocation is wrapped with ${label}`, async () => {
      const dir = freshCopy()
      const target = join(dir, 'release.yml')
      mutate(target, find, replace)
      const { job } = await loadDockerJob(dir)
      const issues = dockerSmokeGateIssues(job)
      assert.ok(issues.some((i) => /none runs it as a bare/.test(i)), `${label}: ${JSON.stringify(issues)}`)
    })
  }

  for (const [label, expr] of [
    ['X || success()', "github.ref == 'refs/heads/main' || success()"],
    ['!success()', '!success()'],
    ['true || success()', 'true || success()'],
  ]) {
    it(`C3: goes RED when the push step's if: is unsafe by operand order (${label})`, async () => {
      const dir = freshCopy()
      const target = join(dir, 'release.yml')
      mutate(target, '      - name: Push the smoked image\n        env:', `      - name: Push the smoked image\n        if: ${expr}\n        env:`)
      const { job } = await loadDockerJob(dir)
      const issues = dockerSmokeGateIssues(job)
      assert.ok(issues.some((i) => /dangerous if:/.test(i)), `${label}: ${JSON.stringify(issues)}`)
    })
  }

  it('C4: goes RED when the build step gains outputs: type=registry', async () => {
    const dir = freshCopy()
    const target = join(dir, 'release.yml')
    mutate(target, '          load: true\n          push: false\n', '          load: true\n          push: false\n          outputs: type=registry\n')
    const { job } = await loadDockerJob(dir)
    const issues = dockerSmokeGateIssues(job)
    assert.ok(issues.some((i) => /runs at or before the smoke step/.test(i)), JSON.stringify(issues))
  })

  it('C4: goes RED when the build step\'s push: is capitalised True instead of false', async () => {
    const dir = freshCopy()
    const target = join(dir, 'release.yml')
    mutate(target, '          load: true\n          push: false\n', '          load: true\n          push: True\n')
    const { job } = await loadDockerJob(dir)
    const issues = dockerSmokeGateIssues(job)
    assert.ok(issues.some((i) => /runs at or before the smoke step/.test(i)), JSON.stringify(issues))
  })

  it('S1: goes RED when a second build-push-action step is inserted between the smoke and the push', async () => {
    const dir = freshCopy()
    const target = join(dir, 'release.yml')
    const rogueBuild =
      '      - name: Rebuild for some reason\n' +
      '        uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6\n' +
      '        with:\n' +
      '          context: .\n' +
      '          push: false\n\n'
    mutate(target, '      - name: Log in to GHCR\n', `${rogueBuild}      - name: Log in to GHCR\n`)
    const { job } = await loadDockerJob(dir)
    const issues = dockerSmokeGateIssues(job)
    assert.ok(issues.some((i) => /builds the image again between the smoke step and the last publishing step/.test(i)), JSON.stringify(issues))
  })

  it('goes RED when the smoke step is removed entirely', async () => {
    const dir = freshCopy()
    const target = join(dir, 'release.yml')
    const find =
      '      # No if:, no continue-on-error: — a real failure here fails the job and\n' +
      '      # blocks login/push below via GitHub Actions\' implicit gating.\n' +
      '      - name: Smoke-start the built image\n' +
      '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke\n\n'
    mutate(target, find, '')
    const { job } = await loadDockerJob(dir)
    const issues = dockerSmokeGateIssues(job)
    assert.ok(issues.some((i) => /no step runs scripts\/docker-image-smoke\.sh/.test(i)), JSON.stringify(issues))
  })

  it('goes RED when ALL of the docker job\'s steps are deleted', async () => {
    const dir = freshCopy()
    const target = join(dir, 'release.yml')
    const text = readFileSync(target, 'utf8')
    const dockerStart = text.indexOf('\n  docker:\n')
    assert.notEqual(dockerStart, -1, "expected to find the 'docker:' job header")
    const nextJobStart = text.indexOf('\n  desktop-macos:\n', dockerStart)
    assert.notEqual(nextJobStart, -1, "expected to find the 'desktop-macos:' job header after 'docker:'")
    const dockerJobText = text.slice(dockerStart, nextJobStart)
    const stepsAt = dockerJobText.indexOf('\n    steps:\n')
    assert.notEqual(stepsAt, -1, "expected a '    steps:' key in the docker job")
    const newDockerJobText = `${dockerJobText.slice(0, stepsAt)}\n    steps: []\n`
    writeFileSync(target, text.slice(0, dockerStart) + newDockerJobText + text.slice(nextJobStart))
    const { job } = await loadDockerJob(dir)
    assert.equal(job.steps.length, 0, 'expected the mutated docker job to parse with zero steps')
    const issues = dockerSmokeGateIssues(job)
    assert.equal(issues.length, 1)
    assert.match(issues[0], /no steps at all/)
  })

  // S2: the AGGREGATE rule (every job with a publishing step, not one
  // looked up by id) catches a copy of the push step pasted into a NEW job
  // with no smoke step at all.
  it('S2: goes RED when the push step is copied into a new job with no smoke step', async () => {
    const dir = freshCopy()
    const target = join(dir, 'release.yml')
    const text = readFileSync(target, 'utf8')
    const rogueJob =
      '\n  rogue-publish:\n' +
      '    name: Rogue Publish\n' +
      '    needs: [test, verify-artifacts]\n' +
      '    runs-on: ubuntu-24.04\n' +
      '    steps:\n' +
      '      - name: Push the smoked image\n' +
      '        env:\n' +
      '          TAGS: ghcr.io/blamechris/chroxy:rogue\n' +
      '        run: |\n' +
      '          set -euo pipefail\n' +
      '          docker push "$TAGS"\n'
    const anchor = '\n  desktop-macos:\n'
    const occurrences = text.split(anchor).length - 1
    assert.equal(occurrences, 1, `expected exactly 1 occurrence of ${JSON.stringify(anchor)}, found ${occurrences}`)
    writeFileSync(target, text.replace(anchor, `${rogueJob}${anchor}`))
    const workflows = await readWorkflows(pathToFileURL(`${dir}/`))
    const release = workflows.find((w) => w.name === 'release.yml')
    const rogue = release.jobs.find((j) => j.id === 'rogue-publish')
    assert.ok(rogue, 'expected the injected rogue-publish job to parse')
    assert.equal(publishingStepIndices(rogue.steps).length, 1, 'expected the rogue job\'s push step to be classified as publishing')
    const findings = allDockerSmokeGateIssues(release.jobs)
    assert.ok('rogue-publish' in findings, JSON.stringify(findings))
    assert.ok(findings['rogue-publish'].some((i) => /no step runs scripts\/docker-image-smoke\.sh/.test(i)), JSON.stringify(findings))
    // The real docker job must still be reported sound alongside the rogue one.
    assert.deepEqual(findings.docker, undefined, JSON.stringify(findings))
  })
})
