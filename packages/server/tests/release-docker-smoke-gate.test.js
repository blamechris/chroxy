import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWorkflows, assertReaderSane, stepInput, stepRun } from './helpers/workflow-reader.js'

/**
 * release.yml: the `docker` job smokes the built image before it pushes it
 * (#8150).
 *
 * THE DEFECT. Before this fix, `docker` built the root Dockerfile with
 * `docker/build-push-action`, `push: true`, and pushed straight to GHCR —
 * nothing in the job ever STARTED the image. That is how the v0.11.0 image
 * shipped unable to start at all (`ERR_MODULE_NOT_FOUND` for
 * `@chroxy/protocol`, #8133): the push step succeeded, because a push
 * doesn't care whether the thing it uploads can run.
 * `scripts/docker-image-smoke.sh` (added for #8133, and run PR-side by
 * ci.yml's path-filtered `Docker Image Smoke` job) proves an image can
 * actually start — but nothing wired it into the one workflow that publishes
 * a release.
 *
 * THE INVARIANT. The image that is SMOKED must be exactly the image that is
 * PUSHED: one build (`load: true`, `push: false`, tagged with both the real
 * metadata-action tags and a fixed local `chroxy:release-smoke` tag), then
 * `docker-image-smoke.sh` against that local tag, and only on success a
 * separate step pushes the SAME already-built tags. Structurally, that means:
 * a step actually runs `docker-image-smoke.sh`; every step that really
 * publishes (a `build-push-action` step with `push: true`, or a `run:` step
 * invoking `docker push` / `docker image push` / `docker buildx ... --push`)
 * comes strictly after it; neither the smoke step nor anything between it and
 * the push can carry `continue-on-error:` (which would let a real failure
 * pass silently); the smoke step itself carries no `if:` that could skip it;
 * a publishing step's own `if:` (if it has one at all) cannot contain
 * `always()`/`failure()`/`cancelled()`, which would let it run even after an
 * upstream step failed; and the tag handed to the smoke script must be one
 * the build step actually produced, not a name nothing built.
 *
 * WHY STRUCTURAL, NOT BY JOB/STEP NAME. A step is classified by what it
 * actually invokes — the literal `run:` script `stepRun()` returns, and the
 * literal `uses:`/`push:` values `stepInput()` returns — never by its `name:`
 * or by a comment describing it, for the same reason
 * release-verify-artifacts-gate.test.js's `isPublishingJob` reads step
 * content rather than trusting a comment: this job's own header comment
 * narrates the very shape this file checks, so a check that read prose would
 * be satisfiable by prose that no longer matches the steps beneath it.
 */

// ---- the pure rule, over already-parsed step bodies ------------------------

/** A step's `docker-image-smoke.sh` invocation, if it has one. */
const SMOKE_SCRIPT_RE = /scripts\/docker-image-smoke\.sh/
/** The image tag argument passed to that invocation. */
const SMOKE_INVOCATION_RE = /scripts\/docker-image-smoke\.sh\s+(\S+)/

const BUILD_PUSH_ACTION_RE = /docker\/build-push-action/
// Matched by command shape, not by step name — mirrors
// release-verify-artifacts-gate.test.js's PUBLISH_RUN_RE /
// PUBLISH_BUILDX_PUSH_RE, widened with `docker image push` (the third raw-CLI
// publish spelling the acceptance criteria name explicitly).
const RUN_DOCKER_PUSH_RE = /\bdocker\s+push\b/
const RUN_DOCKER_IMAGE_PUSH_RE = /\bdocker\s+image\s+push\b/
const RUN_BUILDX_PUSH_RE = /\bdocker\s+buildx\b[\s\S]{0,300}?--push\b/

// Same shape as release-verify-artifacts-gate.test.js's DANGEROUS_IF_RE:
// `always()`/`failure()`/`cancelled()` (covering `!cancelled()` too, a
// substring of it) let a step run even after an upstream failure, and
// `success() || X` widens the safe default right back open. Case-insensitive
// because GitHub Actions expressions are.
const DANGEROUS_IF_RE = /\balways\(\)|\bfailure\(\)|\bcancelled\(\)|\bsuccess\(\)\s*\|\|/i

/** True when `stepLines` carries a truthy `continue-on-error:` — any value
 * other than the literal `false` can suppress a real failure. */
function stepHasContinueOnError(stepLines) {
  const val = stepInput(stepLines, 'continue-on-error')
  return val !== undefined && val !== 'false'
}

/**
 * True when this step actually PUBLISHES the image: a `build-push-action`
 * step whose `push:` input is the literal `true`, or a `run:` step invoking
 * `docker push`, `docker image push`, or `docker buildx ... --push`.
 *
 * A `build-push-action` step with `push: false` (this job's own build step)
 * is deliberately NOT publishing — that is the whole point of the gate.
 *
 * @param {string[]} stepLines
 * @returns {boolean}
 */
export function stepPublishesImage(stepLines) {
  const usesAction = stepInput(stepLines, 'uses')
  if (usesAction && BUILD_PUSH_ACTION_RE.test(usesAction)) {
    return stepInput(stepLines, 'push') === 'true'
  }
  const runBody = stepRun(stepLines)
  if (typeof runBody !== 'string') return false
  return RUN_DOCKER_PUSH_RE.test(runBody) || RUN_DOCKER_IMAGE_PUSH_RE.test(runBody) || RUN_BUILDX_PUSH_RE.test(runBody)
}

/** Index of the first step that runs `docker-image-smoke.sh`, or -1. */
export function findSmokeStepIndex(steps) {
  return steps.findIndex((s) => SMOKE_SCRIPT_RE.test(stepRun(s) || ''))
}

/** Indices of every step that actually publishes the image. */
export function publishingStepIndices(steps) {
  const idx = []
  steps.forEach((s, i) => {
    if (stepPublishesImage(s)) idx.push(i)
  })
  return idx
}

/**
 * Everything wrong with a docker-style job's smoke-before-push gate, or `[]`
 * when the job is sound. See the module doc comment for the invariant.
 *
 * Guards the zero-match vacuous pass explicitly (#8150 acceptance criterion
 * f): a job with no steps, or one with no smoke step, is reported as an
 * issue rather than silently passing over an empty set.
 *
 * @param {{steps: string[][]}} job
 * @returns {string[]}
 */
export function dockerSmokeGateIssues(job) {
  const steps = job && job.steps
  if (!steps || steps.length === 0) {
    return ['job has no steps at all — cannot verify the smoke gate']
  }

  const smokeIdx = findSmokeStepIndex(steps)
  if (smokeIdx === -1) {
    return ['no step runs scripts/docker-image-smoke.sh']
  }

  const issues = []
  const smokeStep = steps[smokeIdx]
  if (stepInput(smokeStep, 'if') !== undefined) {
    issues.push('the smoke step has an if: condition that could skip it')
  }
  if (stepHasContinueOnError(smokeStep)) {
    issues.push('the smoke step has continue-on-error set — a real smoke failure might not fail the job')
  }

  const pubIdx = publishingStepIndices(steps)
  if (pubIdx.length === 0) {
    issues.push(
      'no publishing step found (a build-push-action step with push: true, or a run step invoking ' +
        'docker push / docker image push / docker buildx ... --push) — nothing here actually ships the image'
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
    const pushIf = stepInput(steps[i], 'if')
    if (pushIf && DANGEROUS_IF_RE.test(pushIf)) {
      issues.push(`publishing step at index ${i} has a dangerous if: (${pushIf})`)
    }
  }

  const smokeScript = stepRun(smokeStep) || ''
  const tagMatch = SMOKE_INVOCATION_RE.exec(smokeScript)
  if (!tagMatch) {
    issues.push('could not find the image tag argument passed to docker-image-smoke.sh')
  } else {
    const tag = tagMatch[1]
    const producedEarlier = steps.slice(0, smokeIdx).some((s) => s.some((l) => l.includes(tag)))
    if (!producedEarlier) {
      issues.push(`the smoke step's tag (${tag}) does not appear in any step before it — nothing built that tag`)
    }
  }

  return issues
}

// ---- the rule, on the real tree --------------------------------------------

describe("release.yml: the docker job smokes the built image before pushing it (#8150)", () => {
  let release
  let dockerJob

  before(async () => {
    const workflows = await readWorkflows()
    // Shared positive control: a broken reader finds nothing, and nothing
    // satisfies every rule below over an empty set.
    assertReaderSane(workflows)
    release = workflows.find((w) => w.name === 'release.yml')
    assert.ok(release, 'expected release.yml among the scanned workflows')
    dockerJob = release.jobs.find((j) => j.id === 'docker')
    assert.ok(dockerJob, "expected a 'docker' job in release.yml")
  })

  it('the docker job has steps to check (floor: not the vacuous empty-job pass)', () => {
    assert.ok(dockerJob.steps.length > 0, 'expected the docker job to have parsed steps')
  })

  it('finds the smoke step', () => {
    assert.notEqual(findSmokeStepIndex(dockerJob.steps), -1, 'expected a step running scripts/docker-image-smoke.sh')
  })

  it('CONTROL: exactly one step actually publishes the image', () => {
    const pubIdx = publishingStepIndices(dockerJob.steps)
    assert.equal(pubIdx.length, 1, `expected exactly 1 publishing step, found indices: ${pubIdx.join(', ')}`)
    assert.match(dockerJob.steps[pubIdx[0]].join('\n'), /docker push/)
  })

  it('CONTROL: the build step (push: false) is NOT counted as publishing', () => {
    const buildStep = dockerJob.steps.find((s) => (stepInput(s, 'uses') || '').includes('docker/build-push-action'))
    assert.ok(buildStep, 'expected a build-push-action step')
    assert.equal(stepInput(buildStep, 'push'), 'false')
    assert.equal(stepPublishesImage(buildStep), false)
  })

  it('the job is sound: smoke runs, gates the push, and the smoked tag is one the build produced', () => {
    const issues = dockerSmokeGateIssues(dockerJob)
    assert.deepEqual(issues, [], `docker job's smoke gate is not sound: ${issues.join('; ')}`)
  })
})

/**
 * Each branch of the pure rule proven to REPORT — the real tree is sound, so
 * without these a deleted or broken rule is invisible (docs/false-safety-
 * guards.md: a rule that returns [] because it is broken looks identical to
 * one that returns [] because the tree is clean).
 */
describe('dockerSmokeGateIssues reports each shape it exists to find (#8150)', () => {
  // A minimal but structurally real job: build (push: false) -> smoke ->
  // push (docker push). Each test below mutates ONE aspect of it.
  const soundSteps = () => [
    ['      - uses: actions/checkout@x'],
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

  it('floor: a job whose smoke step was removed entirely is reported', () => {
    const steps = soundSteps().filter((s) => !s.some((l) => l.includes('docker-image-smoke.sh')))
    const issues = dockerSmokeGateIssues({ steps })
    assert.equal(issues.length, 1)
    assert.match(issues[0], /no step runs scripts\/docker-image-smoke\.sh/)
  })

  it('floor: no publishing step at all is reported (not a silent pass over zero)', () => {
    const steps = soundSteps().filter((s) => !s.some((l) => l.includes('docker push')))
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /no publishing step found/.test(i)), JSON.stringify(issues))
  })

  it('reports a publishing step that runs BEFORE the smoke step', () => {
    const steps = soundSteps()
    // Swap smoke (index 2) and push (index 3).
    ;[steps[2], steps[3]] = [steps[3], steps[2]]
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /runs at or before the smoke step/.test(i)), JSON.stringify(issues))
  })

  it('reports a publishing step running AT the same index as the smoke step (single mutated step doing both)', () => {
    const steps = soundSteps()
    // Collapse smoke+push into one step that both smokes and pushes — the
    // "publishing step at or before" branch must fire even when they are
    // literally the same step (i === smokeIdx, not just i < smokeIdx).
    steps[2] = ['      - name: Smoke and push in one step', '        run: |', '          bash scripts/docker-image-smoke.sh chroxy:release-smoke', '          docker push ghcr.io/x/y:1']
    steps.splice(3, 1)
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /runs at or before the smoke step/.test(i)), JSON.stringify(issues))
  })

  it('reports continue-on-error: true on the smoke step itself', () => {
    const steps = soundSteps()
    steps[2] = [...steps[2], '        continue-on-error: true']
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /smoke step has continue-on-error/.test(i)), JSON.stringify(issues))
  })

  it('reports an if: on the smoke step itself', () => {
    const steps = soundSteps()
    steps[2] = [steps[2][0], "        if: runner.os == 'Linux'", ...steps[2].slice(1)]
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /smoke step has an if:/.test(i)), JSON.stringify(issues))
  })

  it('reports continue-on-error: true on a step BETWEEN the smoke step and the push step', () => {
    const steps = soundSteps()
    steps.splice(3, 0, ['      - name: Some step in between', '        run: echo hi', '        continue-on-error: true'])
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /between the smoke step and the publishing step.*continue-on-error/.test(i)), JSON.stringify(issues))
  })

  for (const dangerous of ['always()', 'failure()', 'cancelled()', '${{ !cancelled() }}']) {
    it(`reports a push step whose OWN if: contains ${dangerous}`, () => {
      const steps = soundSteps()
      steps[3] = [steps[3][0], `        if: ${dangerous}`, ...steps[3].slice(1)]
      const issues = dockerSmokeGateIssues({ steps })
      assert.ok(issues.some((i) => /dangerous if:/.test(i)), JSON.stringify(issues))
    })
  }

  it('CONTROL: success() alone on the push step is safe', () => {
    const steps = soundSteps()
    steps[3] = [steps[3][0], '        if: success()', ...steps[3].slice(1)]
    assert.deepEqual(dockerSmokeGateIssues({ steps }), [])
  })

  it('reports a smoke tag that the build step never produced', () => {
    const steps = soundSteps()
    steps[2] = ['      - name: Smoke-start the built image', '        run: bash scripts/docker-image-smoke.sh chroxy:some-other-tag']
    const issues = dockerSmokeGateIssues({ steps })
    assert.ok(issues.some((i) => /does not appear in any step before it/.test(i)), JSON.stringify(issues))
  })

  for (const [label, runLine] of [
    ['`docker push`', '          docker push ghcr.io/x/y:1'],
    ['`docker image push`', '          docker image push ghcr.io/x/y:1'],
    ['`docker buildx ... --push`', '          docker buildx build --platform linux/amd64 --tag ghcr.io/x/y:1 --push .'],
  ]) {
    it(`detects a raw-CLI publish step (${label})`, () => {
      assert.equal(stepPublishesImage(['      - name: publisher', '        run: |', runLine]), true, `expected ${label} to be detected as publishing`)
    })
  }

  it('a build-push-action step with push: true IS publishing', () => {
    const step = ['      - uses: docker/build-push-action@x', '        with:', '          push: true']
    assert.equal(stepPublishesImage(step), true)
  })

  it('a build-push-action step with push: false is NOT publishing', () => {
    const step = ['      - uses: docker/build-push-action@x', '        with:', '          push: false']
    assert.equal(stepPublishesImage(step), false)
  })
})

/**
 * The WIRING, proven against a mutated COPY of the real workflow tree — never
 * the real file. Synthetic cases above prove the rule reports; this proves it
 * is fed the real file and actually goes red on each of the mutants named in
 * #8150's acceptance criteria.
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
    return job
  }

  function freshCopy() {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-docker-smoke-gate-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    return dir
  }

  function mutate(dir, find, replace) {
    const target = join(dir, 'release.yml')
    const text = readFileSync(target, 'utf8')
    const occurrences = text.split(find).length - 1
    assert.equal(
      occurrences, 1,
      `expected exactly 1 occurrence of ${JSON.stringify(find.slice(0, 80))}, found ${occurrences} — ` +
        'release.yml has drifted from what this mutant edits'
    )
    writeFileSync(target, text.replace(find, replace))
  }

  it('CONTROL: an unmutated copy is clean', async () => {
    const dir = freshCopy()
    const job = await loadDockerJob(dir)
    assert.deepEqual(dockerSmokeGateIssues(job), [])
  })

  it('goes RED when the smoke step is removed entirely', async () => {
    const dir = freshCopy()
    const find =
      '      # No if:, no continue-on-error: — a real failure here fails the job and\n' +
      "      # blocks the push step below via GitHub Actions' implicit gating.\n" +
      '      - name: Smoke-start the built image\n' +
      '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke\n\n'
    mutate(dir, find, '')
    const job = await loadDockerJob(dir)
    const issues = dockerSmokeGateIssues(job)
    assert.ok(issues.some((i) => /no step runs scripts\/docker-image-smoke\.sh/.test(i)), JSON.stringify(issues))
  })

  it('goes RED when the push step is moved BEFORE the smoke step', async () => {
    const dir = freshCopy()
    const smokeBlock =
      '      # No if:, no continue-on-error: — a real failure here fails the job and\n' +
      "      # blocks the push step below via GitHub Actions' implicit gating.\n" +
      '      - name: Smoke-start the built image\n' +
      '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke\n\n'
    const pushBlock =
      '      # Pushes the EXACT tags the build step above already built and loaded —\n' +
      '      # never rebuilt, so what was smoked is what ships. steps.meta.outputs.tags\n' +
      "      # is newline-separated; `set -euo pipefail` plus the explicit empty-list\n" +
      '      # check means a metadata-action regression that yields zero tags fails\n' +
      '      # loudly here instead of silently pushing nothing.\n' +
      '      - name: Push the smoked image\n' +
      '        run: |\n' +
      '          set -euo pipefail\n' +
      '          tags="${{ steps.meta.outputs.tags }}"\n' +
      '          if [ -z "$tags" ]; then\n' +
      '            echo "no tags from metadata-action — refusing to push nothing" >&2\n' +
      '            exit 1\n' +
      '          fi\n' +
      '          while IFS= read -r tag; do\n' +
      '            [ -n "$tag" ] || continue\n' +
      '            docker push "$tag"\n' +
      '          done <<< "$tags"\n\n'
    mutate(dir, smokeBlock + pushBlock, pushBlock + smokeBlock)
    const job = await loadDockerJob(dir)
    const issues = dockerSmokeGateIssues(job)
    assert.ok(issues.some((i) => /runs at or before the smoke step/.test(i)), JSON.stringify(issues))
  })

  it('goes RED when the smoke step gains continue-on-error: true', async () => {
    const dir = freshCopy()
    const find = '      - name: Smoke-start the built image\n        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke'
    mutate(dir, find, `${find}\n        continue-on-error: true`)
    const job = await loadDockerJob(dir)
    const issues = dockerSmokeGateIssues(job)
    assert.ok(issues.some((i) => /smoke step has continue-on-error/.test(i)), JSON.stringify(issues))
  })

  it('goes RED when the push step gains if: always()', async () => {
    const dir = freshCopy()
    const find = '      - name: Push the smoked image\n        run: |'
    mutate(dir, find, '      - name: Push the smoked image\n        if: always()\n        run: |')
    const job = await loadDockerJob(dir)
    const issues = dockerSmokeGateIssues(job)
    assert.ok(issues.some((i) => /dangerous if:/.test(i)), JSON.stringify(issues))
  })

  it('goes RED when the smoke step is pointed at a tag the build never produced', async () => {
    const dir = freshCopy()
    const find = '        run: bash scripts/docker-image-smoke.sh chroxy:release-smoke'
    mutate(dir, find, '        run: bash scripts/docker-image-smoke.sh chroxy:mismatched-tag-not-built')
    const job = await loadDockerJob(dir)
    const issues = dockerSmokeGateIssues(job)
    assert.ok(issues.some((i) => /does not appear in any step before it/.test(i)), JSON.stringify(issues))
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
    const job = await loadDockerJob(dir)
    assert.equal(job.steps.length, 0, 'expected the mutated docker job to parse with zero steps')
    const issues = dockerSmokeGateIssues(job)
    assert.equal(issues.length, 1)
    assert.match(issues[0], /no steps at all/)
  })
})
