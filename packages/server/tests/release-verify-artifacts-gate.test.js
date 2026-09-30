import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWorkflows, assertReaderSane } from './helpers/workflow-reader.js'

/**
 * release.yml: every publishing job transitively needs verify-artifacts (#8165).
 *
 * THE DEFECT. `verify-artifacts` packs the npm tarballs, installs them into a
 * throwaway prefix, and runs them — the only check that exercises the ARTIFACT
 * rather than the source tree (#7189). Before this fix, `docker` (which PUSHES
 * to GHCR and moves the floating `:{major}.{minor}` tag) and the two desktop
 * builds needed only `test`, so they ran — and `docker` published — in
 * parallel with verify-artifacts. `github-release` already needed
 * verify-artifacts directly, so a broken artifact still skipped the GitHub
 * Release — but by then the Docker image was already public. A tag push then
 * produces a HALF-shipped release: a new image with no matching release, and
 * nothing about that state gets reported anywhere.
 *
 * THE INVARIANT. Every job that performs an externally-visible, effectively
 * irreversible publish action must have `verify-artifacts` somewhere in its
 * `needs:` closure — directly, or via a job it depends on. "Publishing" is
 * matched STRUCTURALLY, by the action a job's steps actually invoke
 * (`docker/build-push-action`, `softprops/action-gh-release`), not by job id
 * or name — a rename must not silently drop a job out of the check the way a
 * hardcoded id list would (docs/false-safety-guards.md's recurring "a
 * hardcoded list beside a growing set" cause).
 *
 * WHY TRANSITIVE, NOT DIRECT. `github-release` reaches verify-artifacts two
 * ways after this fix — directly, and via `docker`/`desktop-macos`/
 * `desktop-windows`, each of which now also needs it — and the rule must
 * accept either path rather than demanding the gate be listed on every job by
 * name.
 */

// ---- the pure rule, over already-parsed job bodies -------------------------

/**
 * A job's `needs:` list, parsed from its raw body lines. GitHub Actions
 * accepts two spellings, and both must resolve the same way — the same
 * discipline `runsOnOf()` in workflow-reader.js applies to `runs-on:` after
 * the block-form gap in #7383 silently exempted every self-hosted job written
 * that way:
 *
 *     needs: test                    # flow, single job id
 *     needs: [test, verify-artifacts] # flow, list
 *     needs:                          # block
 *       - test
 *       - verify-artifacts
 *
 * @param {string[]} jobBody
 * @returns {string[]}
 */
export function jobNeeds(jobBody) {
  const at = jobBody.findIndex((l) => /^\s*needs:/.test(l))
  if (at === -1) return []
  const keyLine = jobBody[at]
  const inline = keyLine.replace(/^\s*needs:\s*/, '').trim()
  if (inline.length > 0) {
    return inline
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const keyIndent = /^(\s*)/.exec(keyLine)[1].length
  const ids = []
  for (let i = at + 1; i < jobBody.length; i++) {
    const line = jobBody[i]
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const indent = /^(\s*)/.exec(line)[1].length
    if (indent <= keyIndent) break
    const m = /^\s*-\s*(\S+)/.exec(line)
    if (m) ids.push(m[1])
  }
  return ids
}

/** Every job id reachable from `id` by following `needs:` edges, `id` included. */
export function transitiveNeeds(jobsById, id, seen = new Set()) {
  if (seen.has(id)) return seen
  seen.add(id)
  const job = jobsById.get(id)
  if (!job) return seen // a dangling reference is not this rule's subject
  for (const dep of jobNeeds(job.body)) transitiveNeeds(jobsById, dep, seen)
  return seen
}

/**
 * Removes YAML comments before matching. A line that is ENTIRELY a comment
 * is dropped outright; a trailing `  # comment` on an otherwise-real line is
 * truncated to the code before it (a leading space is required, so `path:
 * foo#bar` — no space before `#` — is left alone).
 *
 * Why this matters here specifically (#8166 review): this repo's own
 * doctrine comments routinely narrate the very actions this file matches on
 * — `release.yml`'s `docker` job carries a comment reading "this job PUSHES
 * to GHCR (docker/build-push-action, push: true)" — so without stripping
 * comments first, a job whose REAL step was renamed or removed but whose
 * COMMENT still describes the old shape would satisfy `isPublishingJob`
 * anyway. That is the comment-stands-in-for-code failure
 * docs/false-safety-guards.md catalogues (#7290/#7291): the check must read
 * what runs, not what is said about what runs.
 */
function stripYamlComments(bodyLines) {
  return bodyLines.filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#.*$/, ''))
}

// Matched by the ACTION/COMMAND a step invokes, not by job id/name — a job
// renamed away from "docker" is still caught, and a job merely named
// "docker-setup" that pushes nothing is not swept in by coincidence.
// Widened (#8166 review) beyond the two GitHub Actions this repo currently
// uses, to the raw-CLI shapes a future job could plausibly use instead:
// `docker push`, `docker buildx build ... --push`, `gh release
// create/upload/edit`, and `npm`/`pnpm`/`yarn publish`.
const PUBLISH_ACTION_RE = /docker\/build-push-action|softprops\/action-gh-release/
const PUBLISH_RUN_RE = /\bdocker\s+push\b|\bgh\s+release\s+(?:create|upload|edit)\b|\b(?:npm|pnpm|yarn)\s+publish\b/
const PUBLISH_BUILDX_PUSH_RE = /\bdocker\s+buildx\b[\s\S]{0,300}?--push\b/

/** True when `job`'s real (non-comment) step content invokes a publish-shaped action or command. */
export function isPublishingJob(job) {
  const codeText = stripYamlComments(job.body).join('\n')
  return PUBLISH_ACTION_RE.test(codeText) || PUBLISH_RUN_RE.test(codeText) || PUBLISH_BUILDX_PUSH_RE.test(codeText)
}

/** A job's own job-level `if:` expression (4-space indent — a job body's own
 * keys, as opposed to a STEP's `if:`, which sits far deeper under `steps:`),
 * or null when the job has none. */
function jobIf(jobBody) {
  const m = jobBody.find((l) => /^ {4}if:/.test(l))
  return m ? m.replace(/^ {4}if:\s*/, '').trim() : null
}

// GitHub Actions' IMPLICIT gating — a job with `needs: [X]` only runs if
// every dependency succeeded — is silently REPLACED the moment the job
// declares its OWN `if:`. `always()`, `failure()`, and `cancelled()` (which
// also covers the common `!cancelled()` spelling, a substring of it) are the
// three functions that deliberately run a job even after an upstream
// failure — exactly the shape that would let a publishing job push/release
// even though verify-artifacts just failed, `needs:` entry notwithstanding.
// `success()`, or no `if:` at all (the default), are safe.
const DANGEROUS_IF_RE = /\balways\(\)|\bfailure\(\)|\bcancelled\(\)/

/**
 * Every publishing job (or a job on its `needs:` closure) whose job-level
 * `if:` could let it run — and, for the publishing job itself, actually
 * publish — even after an upstream dependency (verify-artifacts included)
 * failed.
 *
 * @param {{id: string, body: string[]}[]} jobs
 * @returns {string[]} human-readable findings, empty when clean
 */
export function publishingJobsWithDangerousIf(jobs) {
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const findings = []
  for (const job of jobs.filter(isPublishingJob)) {
    for (const id of transitiveNeeds(byId, job.id)) {
      const dep = byId.get(id)
      if (!dep) continue
      const ifExpr = jobIf(dep.body)
      if (ifExpr && DANGEROUS_IF_RE.test(ifExpr)) {
        findings.push(`${job.id} (via '${id}'s if: ${ifExpr})`)
        break
      }
    }
  }
  return findings
}

/** Splits a job body into step blocks — a step begins at a `- ` list item
 * under `steps:`, and runs until the next one. Mirrors the shape
 * workflow-reader.js's own `parseSteps` splits on, kept local and minimal
 * (this rule only needs "the lines belonging to one step", not that
 * helper's fuller key/value parsing) so this file's invariant isn't coupled
 * to that helper's internals. */
function stepBodies(jobBody) {
  const stepsAt = jobBody.findIndex((l) => /^\s*steps:/.test(l))
  if (stepsAt === -1) return []
  const steps = []
  let current = null
  for (let i = stepsAt + 1; i < jobBody.length; i++) {
    const line = jobBody[i]
    if (/^\s*- /.test(line)) {
      if (current) steps.push(current)
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) steps.push(current)
  return steps
}

/**
 * Everything that could make `verify-artifacts` NOT actually verify, even
 * though it exists and is wired into every publishing job's `needs:`
 * (#8166 review, item 7): a `continue-on-error: true` that swallows its own
 * failure, a conditional that could skip it, or the job simply not running
 * the verifier script at all (a rename/typo that silently turned it into a
 * no-op).
 *
 * @param {{id: string, body: string[]}} job
 * @returns {string[]} findings, empty when the job is sound
 */
export function verifyArtifactsGateIssues(job) {
  const issues = []
  const code = stripYamlComments(job.body)
  if (code.some((l) => /^\s*continue-on-error:\s*true\s*$/.test(l))) {
    issues.push('continue-on-error: true appears somewhere in this job (job- or step-level) — a real failure would not fail the job')
  }
  const ifExpr = jobIf(job.body)
  if (ifExpr) {
    issues.push(`has a job-level if: (${ifExpr}) — it must run unconditionally on every release trigger (tag push AND workflow_dispatch)`)
  }
  const steps = stepBodies(code)
  const verifierStep = steps.find((s) => s.some((l) => /node\s+scripts\/verify-publish-artifacts\.mjs/.test(l)))
  if (!verifierStep) {
    issues.push('no step actually runs `node scripts/verify-publish-artifacts.mjs`')
  } else if (verifierStep.some((l) => /^\s*if:/.test(l))) {
    issues.push('the verifier step itself has an if: condition that could skip it')
  }
  return issues
}

/**
 * Every publishing job in `jobs` whose `needs:` closure does NOT include
 * `gateId`.
 *
 * @param {{id: string, body: string[]}[]} jobs
 * @param {string} [gateId]
 * @returns {string[]} job ids, empty when the invariant holds
 */
export function publishingJobsMissingGate(jobs, gateId = 'verify-artifacts') {
  const byId = new Map(jobs.map((j) => [j.id, j]))
  return jobs
    .filter(isPublishingJob)
    .filter((j) => !transitiveNeeds(byId, j.id).has(gateId))
    .map((j) => j.id)
}

// ---- the rule, on the real tree --------------------------------------------

describe('release.yml: every publishing job transitively needs verify-artifacts (#8165)', () => {
  let release

  before(async () => {
    const workflows = await readWorkflows()
    // Shared positive control: a broken reader finds nothing, and nothing
    // satisfies every rule below over an empty set.
    assertReaderSane(workflows)
    release = workflows.find((w) => w.name === 'release.yml')
    assert.ok(release, 'expected release.yml among the scanned workflows')
  })

  it('finds a verify-artifacts job to gate against', () => {
    assert.ok(
      release.jobs.some((j) => j.id === 'verify-artifacts'),
      `expected a 'verify-artifacts' job id, found: ${release.jobs.map((j) => j.id).join(', ')}`
    )
  })

  it('CONTROL: isPublishingJob finds the docker and github-release jobs (not the others)', () => {
    const ids = release.jobs.filter(isPublishingJob).map((j) => j.id)
    assert.ok(ids.includes('docker'), `expected 'docker' among publishing jobs, found: ${ids.join(', ')}`)
    assert.ok(ids.includes('github-release'), `expected 'github-release' among publishing jobs, found: ${ids.join(', ')}`)
    assert.ok(!ids.includes('desktop-macos'), "desktop-macos only uploads a CI artifact — it doesn't itself publish")
    assert.ok(!ids.includes('test'), 'test does not publish anything')
  })

  it('every publishing job transitively needs verify-artifacts', () => {
    const missing = publishingJobsMissingGate(release.jobs)
    assert.deepEqual(
      missing,
      [],
      `these jobs publish (docker push / release upload) but do not transitively need ` +
        `verify-artifacts: ${missing.join(', ')} — a release could push/publish before ` +
        `the artifact gate has run (#8165)`
    )
  })

  it('no publishing job (or a job on its needs path) has an if: that could bypass the gate', () => {
    // #8166 review: needs: alone is not enough — GitHub Actions' implicit
    // "only run if every dependency succeeded" gating is silently replaced
    // the moment a job declares its own if:. always()/failure()/cancelled()
    // are the shapes that would let a publishing job push/release even after
    // verify-artifacts failed.
    const findings = publishingJobsWithDangerousIf(release.jobs)
    assert.deepEqual(findings, [], `dangerous if: found on the publish path: ${findings.join('; ')}`)
  })

  it('verify-artifacts itself is sound: it really runs the verifier, unconditionally, and cannot silently swallow a failure', () => {
    const verifyArtifacts = release.jobs.find((j) => j.id === 'verify-artifacts')
    const issues = verifyArtifactsGateIssues(verifyArtifacts)
    assert.deepEqual(issues, [], `verify-artifacts is not sound: ${issues.join('; ')}`)
  })
})

/**
 * Each branch of the pure rule proven to REPORT — on the real tree every
 * publishing job is gated, so without these a deleted or broken rule is
 * invisible (docs/false-safety-guards.md: a rule that returns empty because
 * it is broken looks identical to one that returns empty because the tree is
 * clean).
 */
describe('publishingJobsMissingGate reports each shape it exists to find (#8165)', () => {
  it('CONTROL: reports nothing when every publishing job needs the gate directly', () => {
    const jobs = [
      { id: 'test', body: ['    runs-on: ubuntu-24.04'] },
      { id: 'verify-artifacts', body: ['    needs: test'] },
      {
        id: 'docker',
        body: [
          '    needs: [test, verify-artifacts]',
          '      - uses: docker/build-push-action@x',
          '        with:',
          '          push: true',
        ],
      },
    ]
    assert.deepEqual(publishingJobsMissingGate(jobs), [])
  })

  it('reports a publishing job with no path to the gate at all', () => {
    const jobs = [
      { id: 'test', body: [] },
      { id: 'verify-artifacts', body: ['    needs: test'] },
      { id: 'docker', body: ['    needs: test', '      - uses: docker/build-push-action@x'] },
    ]
    assert.deepEqual(publishingJobsMissingGate(jobs), ['docker'])
  })

  it('accepts a TRANSITIVE path through another job (github-release\'s real shape)', () => {
    const jobs = [
      { id: 'test', body: [] },
      { id: 'verify-artifacts', body: ['    needs: test'] },
      { id: 'docker', body: ['    needs: [test, verify-artifacts]'] },
      {
        id: 'github-release',
        body: [
          '    needs: [validate, docker, verify-artifacts]',
          '      - uses: softprops/action-gh-release@x',
        ],
      },
    ]
    assert.deepEqual(publishingJobsMissingGate(jobs), [])
  })

  it('a non-publishing job with no needs at all is never flagged', () => {
    assert.deepEqual(publishingJobsMissingGate([{ id: 'lint', body: ['    runs-on: ubuntu-24.04'] }]), [])
  })

  it('a dangling needs: reference does not throw and still reports the gap', () => {
    const jobs = [{ id: 'docker', body: ['    needs: some-deleted-job', '      - uses: docker/build-push-action@x'] }]
    assert.deepEqual(publishingJobsMissingGate(jobs), ['docker'])
  })
})

/**
 * isPublishingJob's detection surface (#8166 review): comment-exclusion, and
 * every widened form beyond the two GitHub Actions this repo currently uses.
 */
describe('isPublishingJob detects real step content, never comments (#8166)', () => {
  it('a job whose ONLY mention of a publish action is a COMMENT is not publishing', () => {
    // This is the concrete regression the review found: release.yml's real
    // `docker` job carries a comment narrating "docker/build-push-action,
    // push: true" right above its `needs:` line. Without comment-stripping,
    // a job whose real step was removed/renamed but whose comment still
    // says this would satisfy the detector anyway.
    const job = {
      id: 'docker-setup',
      body: [
        '    # this job pushes to GHCR (docker/build-push-action, push: true)',
        '    needs: test',
        '      - run: echo "just a placeholder, nothing here actually publishes"',
      ],
    }
    assert.equal(isPublishingJob(job), false)
  })

  it('an inline trailing comment repeating the phrase does not count either', () => {
    const job = {
      id: 'noop',
      body: ['      - run: echo hello  # not docker/build-push-action, just talking about it'],
    }
    assert.equal(isPublishingJob(job), false)
  })

  for (const [label, runLine] of [
    ['raw `docker push`', '      - run: docker push ghcr.io/blamechris/chroxy:0.11.2'],
    ['`docker buildx ... --push`', '      - run: docker buildx build --platform linux/amd64,linux/arm64 --tag ghcr.io/x:1 --push .'],
    ['`gh release create`', '      - run: gh release create v0.11.2 --notes "..."'],
    ['`gh release upload`', '      - run: gh release upload v0.11.2 dist/chroxy.dmg'],
    ['`gh release edit`', '      - run: gh release edit v0.11.2 --draft=false'],
    ['`npm publish`', '      - run: npm publish --access public'],
    ['`pnpm publish`', '      - run: pnpm publish'],
    ['`yarn publish`', '      - run: yarn publish'],
  ]) {
    it(`detects a raw-CLI publish job (${label}) and reports it when ungated`, () => {
      const jobs = [
        { id: 'test', body: [] },
        { id: 'verify-artifacts', body: ['    needs: test'] },
        { id: 'raw-publisher', body: ['    needs: test', runLine] },
      ]
      assert.equal(isPublishingJob(jobs[2]), true, `expected ${label} to be detected as publishing`)
      assert.deepEqual(publishingJobsMissingGate(jobs), ['raw-publisher'])
    })
  }
})

/**
 * publishingJobsWithDangerousIf (#8166 review, item 6): needs: alone is not
 * enough — a job-level if: silently replaces GitHub Actions' implicit
 * "only run if every dependency succeeded" gating.
 */
describe('publishingJobsWithDangerousIf reports a bypassable gate (#8166)', () => {
  const base = () => [
    { id: 'test', body: [] },
    { id: 'verify-artifacts', body: ['    needs: test'] },
  ]

  it('CONTROL: reports nothing when the publishing job has no if: at all', () => {
    const jobs = [...base(), { id: 'docker', body: ['    needs: [test, verify-artifacts]', '      - uses: docker/build-push-action@x'] }]
    assert.deepEqual(publishingJobsWithDangerousIf(jobs), [])
  })

  it('CONTROL: a benign if: (e.g. a tag-ref guard) is not flagged', () => {
    const jobs = [
      ...base(),
      {
        id: 'github-release',
        body: ["    needs: [verify-artifacts]", "    if: startsWith(github.ref, 'refs/tags/v')", '      - uses: softprops/action-gh-release@x'],
      },
    ]
    assert.deepEqual(publishingJobsWithDangerousIf(jobs), [])
  })

  for (const dangerous of ['always()', 'failure()', 'cancelled()', '${{ !cancelled() }}']) {
    it(`reports a publishing job whose OWN if: contains ${dangerous}`, () => {
      const jobs = [
        ...base(),
        { id: 'docker', body: ['    needs: [test, verify-artifacts]', `    if: ${dangerous}`, '      - uses: docker/build-push-action@x'] },
      ]
      const findings = publishingJobsWithDangerousIf(jobs)
      assert.equal(findings.length, 1, `expected exactly 1 finding for ${dangerous}, got: ${JSON.stringify(findings)}`)
      assert.match(findings[0], /docker/)
    })
  }

  it('reports it even when the dangerous if: sits on an UPSTREAM job in the needs path, not the publisher itself', () => {
    const jobs = [
      { id: 'test', body: [] },
      { id: 'verify-artifacts', body: ['    needs: test', '    if: always()'] },
      { id: 'docker', body: ['    needs: [test, verify-artifacts]', '      - uses: docker/build-push-action@x'] },
    ]
    const findings = publishingJobsWithDangerousIf(jobs)
    assert.equal(findings.length, 1)
    assert.match(findings[0], /verify-artifacts/)
  })
})

/**
 * verifyArtifactsGateIssues (#8166 review, item 7): the gate must actually
 * gate — no swallowed failure, no conditional skip, and it must actually
 * invoke the verifier script.
 */
describe('verifyArtifactsGateIssues catches a hollowed-out gate (#8166)', () => {
  const soundJob = () => ({
    id: 'verify-artifacts',
    body: [
      '    needs: test',
      '    runs-on: ubuntu-24.04',
      '    steps:',
      '      - uses: actions/checkout@x',
      '      - name: Pack, install into a clean prefix, and run',
      '        run: node scripts/verify-publish-artifacts.mjs',
    ],
  })

  it('CONTROL: a sound job reports nothing', () => {
    assert.deepEqual(verifyArtifactsGateIssues(soundJob()), [])
  })

  it('reports continue-on-error: true on the step', () => {
    const job = soundJob()
    job.body.splice(job.body.length - 1, 0, '        continue-on-error: true')
    const issues = verifyArtifactsGateIssues(job)
    assert.ok(issues.some((i) => /continue-on-error/.test(i)), JSON.stringify(issues))
  })

  it('reports continue-on-error: true at job level', () => {
    const job = soundJob()
    job.body.splice(1, 0, '    continue-on-error: true')
    const issues = verifyArtifactsGateIssues(job)
    assert.ok(issues.some((i) => /continue-on-error/.test(i)), JSON.stringify(issues))
  })

  it('reports a job-level if: that could skip it', () => {
    const job = soundJob()
    job.body.splice(1, 0, '    if: github.event_name == \'workflow_dispatch\'')
    const issues = verifyArtifactsGateIssues(job)
    assert.ok(issues.some((i) => /job-level if:/.test(i)), JSON.stringify(issues))
  })

  it('reports a step-level if: on the verifier step itself', () => {
    const job = soundJob()
    const idx = job.body.findIndex((l) => /verify-publish-artifacts\.mjs/.test(l))
    job.body.splice(idx, 0, "        if: runner.os == 'Linux'")
    const issues = verifyArtifactsGateIssues(job)
    assert.ok(issues.some((i) => /verifier step itself/.test(i)), JSON.stringify(issues))
  })

  it('reports when NO step actually runs the verifier script (renamed/typo\'d away)', () => {
    const job = soundJob()
    job.body = job.body.map((l) => l.replace('verify-publish-artifacts.mjs', 'verify-publish-artifacts-OLD.mjs'))
    const issues = verifyArtifactsGateIssues(job)
    assert.ok(issues.some((i) => /no step actually runs/.test(i)), JSON.stringify(issues))
  })

  it('a comment mentioning the verifier script does not count as actually running it', () => {
    const job = {
      id: 'verify-artifacts',
      body: [
        '    needs: test',
        '    # this job runs node scripts/verify-publish-artifacts.mjs',
        '    steps:',
        '      - run: echo "oops, the real step got deleted"',
      ],
    }
    const issues = verifyArtifactsGateIssues(job)
    assert.ok(issues.some((i) => /no step actually runs/.test(i)), JSON.stringify(issues))
  })
})

describe('jobNeeds parses every needs: spelling GitHub Actions accepts (#8165)', () => {
  it('flow list', () => {
    assert.deepEqual(jobNeeds(['    needs: [test, verify-artifacts]']), ['test', 'verify-artifacts'])
  })
  it('flow single value', () => {
    assert.deepEqual(jobNeeds(['    needs: test']), ['test'])
  })
  it('block sequence', () => {
    assert.deepEqual(
      jobNeeds(['    needs:', '      - test', '      - verify-artifacts']),
      ['test', 'verify-artifacts']
    )
  })
  it('no needs: key at all', () => {
    assert.deepEqual(jobNeeds(['    runs-on: ubuntu-24.04']), [])
  })
  it('a comment between the key and the block items is skipped, not treated as the end', () => {
    assert.deepEqual(
      jobNeeds(['    needs:', '      # kept in dependency order', '      - test', '      - verify-artifacts']),
      ['test', 'verify-artifacts']
    )
  })
})

/**
 * The WIRING, proven against a mutated COPY of the real workflow tree — never
 * the real file. Synthetic cases above prove the rule reports; this proves it
 * is fed the real file and actually goes red on the real regression this
 * issue describes (removing verify-artifacts from docker's needs).
 */
describe('the rule reads the real release.yml (mutation proof, #8165)', () => {
  const dirs = []
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  const REAL = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url))

  it('CONTROL: an unmutated copy is clean', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-release-gate-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const workflows = await readWorkflows(pathToFileURL(`${dir}/`))
    const release = workflows.find((w) => w.name === 'release.yml')
    assert.deepEqual(publishingJobsMissingGate(release.jobs), [])
  })

  it('goes RED if verify-artifacts is removed from docker\'s needs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-release-gate-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const target = join(dir, 'release.yml')
    const text = readFileSync(target, 'utf8')
    const find = '    needs: [test, verify-artifacts]\n    runs-on: ubuntu-24.04'
    const occurrences = text.split(find).length - 1
    assert.equal(
      occurrences, 1,
      `expected exactly 1 occurrence of docker's needs+runs-on line, found ${occurrences} — ` +
        "release.yml has drifted from what this case edits and would pass for the wrong reason"
    )
    writeFileSync(target, text.replace(find, '    needs: test\n    runs-on: ubuntu-24.04'))
    const workflows = await readWorkflows(pathToFileURL(`${dir}/`))
    const release = workflows.find((w) => w.name === 'release.yml')
    assert.deepEqual(publishingJobsMissingGate(release.jobs), ['docker'])
  })

  it('goes RED on a full reversion to the pre-#8165 graph (both docker and github-release orphaned)', async () => {
    // github-release reaches verify-artifacts two ways after this fix —
    // directly, and transitively via docker/desktop-macos/desktop-windows —
    // so removing just ONE of those edges is not a regression this rule
    // should flag (that redundancy is the point of "transitively"). The real
    // regression this issue describes is the WHOLE pre-fix graph: nobody
    // gated on verify-artifacts except github-release's own direct edge, and
    // docker/desktop-* raced it. Reproduce exactly that shape.
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-release-gate-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const target = join(dir, 'release.yml')
    let text = readFileSync(target, 'utf8')
    const edits = [
      ['    needs: [test, verify-artifacts]\n    runs-on: ubuntu-24.04', '    needs: test\n    runs-on: ubuntu-24.04'],
      ['    needs: [test, verify-artifacts]\n    runs-on: macos-latest', '    needs: test\n    runs-on: macos-latest'],
      ['    needs: [test, verify-artifacts]\n    runs-on: windows-latest', '    needs: test\n    runs-on: windows-latest'],
      ['    needs: [validate, docker, desktop-macos, desktop-windows, verify-artifacts]', '    needs: [validate, docker, desktop-macos, desktop-windows]'],
    ]
    for (const [find, replace] of edits) {
      const occurrences = text.split(find).length - 1
      assert.equal(occurrences, 1, `expected exactly 1 occurrence of ${JSON.stringify(find.slice(0, 60))}, found ${occurrences} — release.yml has drifted from what this case edits`)
      text = text.replace(find, replace)
    }
    writeFileSync(target, text)
    const workflows = await readWorkflows(pathToFileURL(`${dir}/`))
    const release = workflows.find((w) => w.name === 'release.yml')
    assert.deepEqual(publishingJobsMissingGate(release.jobs).sort(), ['docker', 'github-release'])
  })

  it('goes RED if docker gains an if: always() (#8166 review, item 6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-release-gate-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const target = join(dir, 'release.yml')
    const text = readFileSync(target, 'utf8')
    const find = '    needs: [test, verify-artifacts]\n    runs-on: ubuntu-24.04'
    const occurrences = text.split(find).length - 1
    assert.equal(occurrences, 1, `expected exactly 1 occurrence, found ${occurrences} — release.yml has drifted from what this case edits`)
    writeFileSync(target, text.replace(find, '    needs: [test, verify-artifacts]\n    if: always()\n    runs-on: ubuntu-24.04'))
    const workflows = await readWorkflows(pathToFileURL(`${dir}/`))
    const release = workflows.find((w) => w.name === 'release.yml')
    const findings = publishingJobsWithDangerousIf(release.jobs)
    // Both docker (its OWN if:) and github-release (which needs docker, so
    // docker's now-unsound gate is on ITS needs path too — "any job on its
    // needs path" per the review) are correctly flagged.
    assert.equal(findings.length, 2, JSON.stringify(findings))
    assert.ok(findings.some((f) => /^docker /.test(f)), JSON.stringify(findings))
    assert.ok(findings.some((f) => /^github-release /.test(f)), JSON.stringify(findings))
  })

  it('goes RED if verify-artifacts stops actually running the verifier script (#8166 review, item 7)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-release-gate-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const target = join(dir, 'release.yml')
    const text = readFileSync(target, 'utf8')
    const find = 'run: node scripts/verify-publish-artifacts.mjs'
    const occurrences = text.split(find).length - 1
    assert.equal(occurrences, 1, `expected exactly 1 occurrence, found ${occurrences} — release.yml has drifted from what this case edits`)
    writeFileSync(target, text.replace(find, 'run: echo "oops, silently turned into a no-op"'))
    const workflows = await readWorkflows(pathToFileURL(`${dir}/`))
    const release = workflows.find((w) => w.name === 'release.yml')
    const verifyArtifacts = release.jobs.find((j) => j.id === 'verify-artifacts')
    const issues = verifyArtifactsGateIssues(verifyArtifacts)
    assert.ok(issues.some((i) => /no step actually runs/.test(i)), JSON.stringify(issues))
  })
})
