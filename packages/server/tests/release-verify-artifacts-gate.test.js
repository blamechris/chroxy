import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWorkflows, assertReaderSane } from './helpers/workflow-reader.js'
import { DAEMON_ENTRY_MODULES } from '../../../scripts/lib/daemon-entry-modules.mjs'

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
 * Removes YAML comments before matching, QUOTE-AWARE: a `#` inside a
 * single- or double-quoted string is not a comment marker (`run: echo "a #
 * not a comment"` must keep its `#`), and — like real YAML — a `#` only
 * starts a comment when it is at the start of the line or preceded by
 * whitespace (`path: foo#bar` is left alone). A line that is ENTIRELY a
 * comment is truncated to (at most) its leading whitespace; a trailing
 * `  # comment` on an otherwise-real line is truncated to the code before
 * it. This is a small scanner, not a YAML parser — it tracks quote state
 * char-by-char for exactly this one decision, nothing more.
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
  return bodyLines.map((line) => {
    let inSingle = false
    let inDouble = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (inSingle) {
        if (c === "'") inSingle = false
        continue
      }
      if (inDouble) {
        if (c === '\\') { i++; continue } // skip the escaped character
        if (c === '"') inDouble = false
        continue
      }
      if (c === "'") { inSingle = true; continue }
      if (c === '"') { inDouble = true; continue }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
    }
    return line
  })
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

// A job whose OWN `permissions:` grant something that ONLY a publish-shaped
// action would need is publishing even if its exact command isn't one of the
// ones matched above (#8166 second review) — a future job could plausibly
// use an action neither list anticipates, and least-privilege workflows
// don't request `packages: write` for anything else. `write-all` subsumes
// all of these. `contents: write` is broader than "publish" in general (it
// also covers e.g. pushing a commit), but on a RELEASE workflow specifically
// it is exactly github-release's own grant, and matches nothing else on the
// real tree (verified: `test`/`verify-artifacts`/`desktop-macos`/
// `desktop-windows` all declare `contents: read` only).
const DANGEROUS_PERMISSION_RE = /^\s*(?:packages|contents|id-token):\s*write\s*$/

/** True when `jobBody` (already comment-stripped) declares one of the
 * publish-shaped permissions above, at the job's own `permissions:` block
 * (4-space indent — not a step's, which doesn't exist as a concept here). */
function hasPublishingPermissions(jobBody) {
  const at = jobBody.findIndex((l) => /^ {4}permissions:/.test(l))
  if (at === -1) return false
  if (/write-all/.test(jobBody[at])) return true
  for (let i = at + 1; i < jobBody.length; i++) {
    const line = jobBody[i]
    if (/^\s*$/.test(line)) continue
    const indent = /^(\s*)/.exec(line)[1].length
    if (indent <= 4) break
    if (DANGEROUS_PERMISSION_RE.test(line)) return true
  }
  return false
}

/** True when `job`'s real (non-comment) step content invokes a publish-shaped
 * action or command, OR its own permissions grant is publish-shaped. */
export function isPublishingJob(job) {
  const code = stripYamlComments(job.body)
  const codeText = code.join('\n')
  return PUBLISH_ACTION_RE.test(codeText) || PUBLISH_RUN_RE.test(codeText) || PUBLISH_BUILDX_PUSH_RE.test(codeText)
    || hasPublishingPermissions(code)
}

/**
 * A job's own job-level `if:` expression (4-space indent — a job body's own
 * keys, as opposed to a STEP's `if:`, which sits far deeper under `steps:`),
 * or null when the job has none.
 *
 * COLLECTS THE WHOLE VALUE, not just the key line (#8166 second review): a
 * job-level `if:` can be a YAML block scalar (`if: |` / `if: >`) or a plain
 * scalar that wraps onto continuation lines indented deeper than the key —
 * both valid, and a reader that only looked at the key line would miss a
 * dangerous function sitting on line 2. Collection stops at the first line
 * back at or above the key's own indent (the next job-level key, `steps:`
 * included) — real workflow YAML always has one of those following `if:`,
 * which is what makes this unambiguous.
 */
function jobIf(jobBody) {
  const at = jobBody.findIndex((l) => /^ {4}if:/.test(l))
  if (at === -1) return null
  const parts = [jobBody[at].replace(/^ {4}if:\s*/, '')]
  for (let i = at + 1; i < jobBody.length; i++) {
    const line = jobBody[i]
    if (/^\s*$/.test(line)) continue // a blank line inside a block scalar doesn't end it
    const indent = /^(\s*)/.exec(line)[1].length
    if (indent <= 4) break
    parts.push(line.trim())
  }
  const combined = parts.join(' ').trim()
  return combined.length > 0 ? combined : null
}

// GitHub Actions' IMPLICIT gating — a job with `needs: [X]` only runs if
// every dependency succeeded — is silently REPLACED the moment the job
// declares its OWN `if:`. `always()`, `failure()`, and `cancelled()` (which
// also covers the common `!cancelled()` spelling, a substring of it) are
// functions that deliberately run a job even after an upstream failure —
// exactly the shape that would let a publishing job push/release even
// though verify-artifacts just failed, `needs:` entry notwithstanding.
// `success() || <anything>` is the same hole by another route: `success()`
// alone is the safe default, but OR-ing it with another condition widens the
// gate right back open. Case-insensitive: GitHub Actions expressions are not
// case-sensitive (`Always()`/`ALWAYS()` work exactly like `always()`), so a
// case-sensitive check would miss a functionally identical spelling.
// `success()` alone, or no `if:` at all (the default), are safe.
const DANGEROUS_IF_RE = /\balways\(\)|\bfailure\(\)|\bcancelled\(\)|\bsuccess\(\)\s*\|\|/i

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
// Any value other than the literal `false` can suppress a real failure —
// `continue-on-error: ${{ true }}`, `continue-on-error: ${{ some.expr }}`, or
// simply a typo'd non-boolean are all still truthy to GitHub Actions. Only
// the exact literal `false` is the safe, inert spelling (#8166 second
// review) — the previous check matched only the literal `true` and missed
// every other truthy spelling.
const CONTINUE_ON_ERROR_RE = /^\s*continue-on-error:\s*(.+?)\s*$/

// The verifier step must RUN the script DIRECTLY — `run: node
// scripts/verify-publish-artifacts.mjs`, optionally with flags (`--keep`,
// etc.), and nothing else on that line. A wrapper (`... || true`, `if …;
// then … fi`, a piped/redirected invocation, or merely an `echo` mentioning
// the path) must not satisfy this: exactly that shape is how a "gate" stops
// gating while every other check here still finds a step that "runs" it.
const VERIFIER_RUN_RE = /^\s*(?:-\s+)?run:\s*node\s+scripts\/verify-publish-artifacts\.mjs(?:\s+--?[\w-]+)*\s*$/
const VERIFIER_MENTION_RE = /verify-publish-artifacts\.mjs/

export function verifyArtifactsGateIssues(job) {
  const issues = []
  const code = stripYamlComments(job.body)
  if (code.some((l) => {
    const m = CONTINUE_ON_ERROR_RE.exec(l)
    return m && m[1] !== 'false'
  })) {
    issues.push('continue-on-error is set to something other than the literal false somewhere in this job (job- or step-level) — a real failure might not fail the job')
  }
  const ifExpr = jobIf(job.body)
  if (ifExpr) {
    issues.push(`has a job-level if: (${ifExpr}) — it must run unconditionally on every release trigger (tag push AND workflow_dispatch)`)
  }
  const steps = stepBodies(code)
  const exactStep = steps.find((s) => s.some((l) => VERIFIER_RUN_RE.test(l)))
  if (!exactStep) {
    const mentioningStep = steps.find((s) => s.some((l) => VERIFIER_MENTION_RE.test(l)))
    if (mentioningStep) {
      issues.push('a step mentions verify-publish-artifacts.mjs but does not run it directly (wrapped in `... || true`, a conditional, a pipe, or similar) — a real failure could be silently swallowed')
    } else {
      issues.push('no step actually runs `node scripts/verify-publish-artifacts.mjs`')
    }
  } else if (exactStep.some((l) => /^\s*if:/.test(l))) {
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

  it('CONTROL: isPublishingJob finds EXACTLY the real publishing-job set: docker, github-release', () => {
    // #8166 second review: an assert.ok(includes(...)) list only ever
    // catches a job DROPPING out of the set — it says nothing about an
    // EXTRA job wrongly joining it (the permissions-based OR condition
    // added in this round is exactly the kind of change that could do
    // that). deepEqual against the exact expected set catches both
    // directions. Verified by hand against the real tree: `test`,
    // `verify-artifacts`, `desktop-macos`, and `desktop-windows` each
    // declare only `contents: read`, so widening the detector to also
    // match on `permissions:` does not add any of them.
    const ids = release.jobs.filter(isPublishingJob).map((j) => j.id)
    assert.deepEqual([...ids].sort(), ['docker', 'github-release'])
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

  // #8166 second review, nit: comment-stripping must be quote-aware. A `#`
  // inside a quoted string is real content, not a comment marker — a naive
  // `\s#.*$` truncation would find THAT `#` first and chop off everything
  // after it, including a REAL publish command later on the same line. That
  // is a false NEGATIVE (a job that does publish reads as if it doesn't),
  // the opposite direction from — but just as wrong as — the comment-stands-
  // in-for-code failure the outer stripping exists to catch.
  it('a `#` inside a quoted string does not truncate away a REAL command later on the line', () => {
    const job = {
      id: 'publisher',
      body: ['      - run: echo "value #looks like a comment but is just quoted text" && docker push ghcr.io/x:1'],
    }
    assert.equal(isPublishingJob(job), true, 'a naive (non-quote-aware) stripper would truncate at the quoted #, hiding the real docker push that follows')
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

  // #8166 second review: jobIf() used to read only the if: KEY LINE, missing
  // a multi-line value entirely — a YAML block scalar, or a plain scalar
  // wrapped onto continuation lines indented deeper than the key, both of
  // which are valid and neither of which fit on line 1.
  it('reports a multi-line if: (block scalar) with always() on line 2, not line 1', () => {
    const jobs = [
      ...base(),
      {
        id: 'docker',
        body: [
          '    needs: [test, verify-artifacts]',
          '    if: |',
          "      github.event_name == 'workflow_dispatch' ||",
          '      always()',
          '    runs-on: ubuntu-24.04',
          '      - uses: docker/build-push-action@x',
        ],
      },
    ]
    const findings = publishingJobsWithDangerousIf(jobs)
    assert.equal(findings.length, 1, JSON.stringify(findings))
    assert.match(findings[0], /docker/)
  })

  // Case-insensitivity: GitHub Actions expressions aren't case-sensitive, so
  // `Always()` bypasses gating exactly like `always()` does.
  for (const spelling of ['Always()', 'ALWAYS()', 'Failure()']) {
    it(`reports a differently-cased spelling: ${spelling}`, () => {
      const jobs = [
        ...base(),
        { id: 'docker', body: ['    needs: [test, verify-artifacts]', `    if: ${spelling}`, '      - uses: docker/build-push-action@x'] },
      ]
      assert.equal(publishingJobsWithDangerousIf(jobs).length, 1)
    })
  }

  // `success() || X` widens the gate right back open — success() ALONE is
  // the safe default, but OR-ing another condition onto it reintroduces a
  // bypass.
  it('reports success() || failure() (an OR widens the gate back open)', () => {
    const jobs = [
      ...base(),
      { id: 'docker', body: ['    needs: [test, verify-artifacts]', '    if: success() || failure()', '      - uses: docker/build-push-action@x'] },
    ]
    assert.equal(publishingJobsWithDangerousIf(jobs).length, 1)
  })

  it('CONTROL: success() alone (no OR) is still safe', () => {
    const jobs = [
      ...base(),
      { id: 'docker', body: ['    needs: [test, verify-artifacts]', '    if: success()', '      - uses: docker/build-push-action@x'] },
    ]
    assert.deepEqual(publishingJobsWithDangerousIf(jobs), [])
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

  // #8166 second review: only the literal `true` used to be flagged — an
  // expression like `${{ true }}` (or any other non-`false` spelling) is
  // just as truthy to GitHub Actions and was previously invisible here.
  it('reports continue-on-error: ${{ true }} (an expression, not the bare literal)', () => {
    const job = soundJob()
    job.body.splice(job.body.length - 1, 0, '        continue-on-error: ${{ true }}')
    const issues = verifyArtifactsGateIssues(job)
    assert.ok(issues.some((i) => /continue-on-error/.test(i)), JSON.stringify(issues))
  })

  it('CONTROL: continue-on-error: false is still safe', () => {
    const job = soundJob()
    job.body.splice(job.body.length - 1, 0, '        continue-on-error: false')
    assert.deepEqual(verifyArtifactsGateIssues(job), [])
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

  // #8166 second review: the step must run the command DIRECTLY. A wrapper
  // — `... || true` swallows a nonzero exit right there, defeating the gate
  // even though a step visibly "runs" the script — must be distinguished
  // from "no step mentions it at all" (the case above), since the fix is
  // different (unwrap it, vs. add the step back).
  it('reports a wrapped invocation (`... || true`) distinctly from "missing entirely"', () => {
    const job = soundJob()
    job.body = job.body.map((l) => l.replace(
      'run: node scripts/verify-publish-artifacts.mjs',
      'run: node scripts/verify-publish-artifacts.mjs || true'
    ))
    const issues = verifyArtifactsGateIssues(job)
    assert.ok(issues.some((i) => /does not run it directly/.test(i)), JSON.stringify(issues))
    assert.ok(!issues.some((i) => /no step actually runs/.test(i)), JSON.stringify(issues))
  })

  it('CONTROL: a trailing flag (--keep) is still a direct invocation', () => {
    const job = soundJob()
    job.body = job.body.map((l) => l.replace(
      'run: node scripts/verify-publish-artifacts.mjs',
      'run: node scripts/verify-publish-artifacts.mjs --keep'
    ))
    assert.deepEqual(verifyArtifactsGateIssues(job), [])
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

/**
 * DAEMON_ENTRY_MODULES stays tied to server-cmd.js's real dynamic imports
 * (#8166 second review, item 9). scripts/verify-publish-artifacts.mjs
 * import()s this list out of the installed package to prove `chroxy
 * start`'s daemon module graph links; that list is only worth anything if
 * it actually matches what server-cmd.js dynamically imports. Exported from
 * one shared module (scripts/lib/daemon-entry-modules.mjs) rather than
 * duplicated as a literal array in both files, and cross-checked here
 * against server-cmd.js's OWN source so a third daemon entry point added
 * there without updating the shared list is caught — the "hardcoded list
 * beside a growing set" cause docs/false-safety-guards.md catalogues.
 */
describe('DAEMON_ENTRY_MODULES matches server-cmd.js\'s real dynamic imports (#8166)', () => {
  it('every relative import(\'../X.js\') in server-cmd.js, minus logger.js, equals DAEMON_ENTRY_MODULES', () => {
    const serverCmdPath = fileURLToPath(new URL('../src/cli/server-cmd.js', import.meta.url))
    const src = readFileSync(serverCmdPath, 'utf8')
    const found = new Set()
    for (const m of src.matchAll(/await import\('\.\.\/([\w.-]+)'\)/g)) found.add(m[1])
    assert.ok(found.size > 0, 'expected to find at least one relative dynamic import in server-cmd.js — the parser is probably broken')
    // logger.js is a plain logging utility server-cmd.js reaches for
    // mid-startup, not a daemon "entry point" the way server-cli.js /
    // supervisor.js are: chroxy start never completes without eventually
    // importing one of THOSE two, whereas logger.js is incidental to the
    // actual daemon graph verify-publish-artifacts.mjs is trying to prove
    // links.
    found.delete('logger.js')
    const expected = new Set(DAEMON_ENTRY_MODULES.map((p) => p.replace(/^src\//, '')))
    assert.deepEqual([...found].sort(), [...expected].sort())
  })
})
