import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
import { readWorkflows, assertReaderSane } from './helpers/workflow-reader.js'

/**
 * `ci.yml`'s `concurrency:` block must let queued `main`-push runs supersede
 * each other, and must never cancel a run that is already IN PROGRESS on
 * `main` (#7905).
 *
 * THE DEFECT, MEASURED
 * ---------------------
 * Before this fix, `ci.yml` set:
 *
 *     concurrency:
 *       group: ci-${{ github.head_ref || github.run_id }}
 *       cancel-in-progress: true
 *
 * `github.head_ref` is populated only for `pull_request`/`pull_request_target`
 * events (GitHub docs, contexts reference) — empty for every `push`. So on a
 * push to `main` the group fell back to `github.run_id`, which GitHub documents
 * as "a unique number for each workflow run within a repository" (same
 * reference) — unique BY DEFINITION, so two pushes to `main` never land in the
 * same group and neither can ever supersede the other. On 2026-09-24 an
 * autonomous wave merged 7 PRs in ~3 hours: 7 independent `main` CI runs queued
 * up behind the three long jobs pinned to the single `chroxy-linux-winbox-01`
 * runner (#7471), one PR's jobs sat QUEUED 4+ hours with every other runner
 * idle, and 6 of the 7 `main` runs had to be cancelled BY HAND.
 *
 * THE FIX, AND WHY IT IS SAFE (GitHub's documented semantics)
 * -------------------------------------------------------------
 * `group: ci-${{ github.head_ref || github.ref }}` — for a `push`, `github.ref`
 * is "the branch or tag ref that was pushed" (`refs/heads/main` here, since
 * `on.push.branches` names only `main`), the SAME value on every push to that
 * branch. `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`
 * scopes the "cancel a running job" behaviour to PR pushes only; on `main` it
 * resolves false. Per GitHub's concurrency docs: with `cancel-in-progress`
 * false, "any existing pending job or workflow in the same concurrency group
 * will be canceled and the new queued job or workflow will take its place",
 * and by default "at most one job or workflow run can be pending" in a group —
 * an in-progress run is left alone. So a burst of `main` pushes settles to at
 * most one RUNNING plus one PENDING run (the newest), not one queued run per
 * push, while PR pushes keep cancelling their own in-progress run exactly as
 * before.
 *
 * WHY A REAL YAML PARSER, NOT A REGEX ON TEXT (docs/false-safety-guards.md #31)
 * -------------------------------------------------------------------------------
 * ci.yml's header comments literally quote the pre-fix expression while
 * explaining the history of this bug (see above) — a regex anchored on the
 * *text* `github.head_ref || github.run_id` would match this docstring's own
 * prose forever, the exact "asserted the config's SPELLING" failure entry 31
 * catalogues. `js-yaml` parses the real document node instead: comments are
 * never part of a parsed value, so only the LIVE `concurrency.group` string can
 * satisfy or fail these assertions.
 *
 * WHY THIS SCANS EVERY WORKFLOW, NOT JUST ci.yml (#7386's lesson, reapplied)
 * -----------------------------------------------------------------------------
 * `head_ref || run_id` in a push-triggered workflow's concurrency group is the
 * defect, not a property of one file. Grepped at #7905 fix time: no other
 * workflow in this repo carries the pattern today (`repo-relay.yml`,
 * `maestro-nightly.yml`, `nightly-k8s-integration.yml` all key on a fixed
 * string, not `head_ref`/`run_id`; `auto-tag-on-release.yml`, `release.yml` and
 * `stale.yml` declare no `concurrency:` block at all). The regression guard
 * below is scoped to the DEFECT so a future push-triggered workflow that copies
 * the old ci.yml pattern is caught without anyone updating a roster here.
 *
 * WHY THE SCAN ALSO READS `jobs.*.concurrency`, NOT JUST THE WORKFLOW-LEVEL
 * BLOCK. GitHub Actions accepts `concurrency:` at the job level too, as either
 * a bare string or the same `{group, cancel-in-progress}` shape, and a job-level
 * group hits the identical #7905 pile-up if it falls back to `run_id` on a
 * push-triggered workflow — the workflow-level block being clean says nothing
 * about a job's own group. A first version of this scan checked only
 * `doc.concurrency` and passed green over a job-level `run_id` fallback
 * (confirmed by adding one to a scratch workflow) — the "guard wired to only
 * some of its callers" shape in docs/false-safety-guards.md. `concurrencyGroup`
 * normalizes both the bare-string and object forms so job- and workflow-level
 * blocks are read the same way.
 */

/** A job's or workflow's `concurrency:` value in either its bare-string or object shape. */
const concurrencyGroup = c => {
  if (typeof c === 'string') return c
  if (c && typeof c === 'object') return String(c.group ?? '')
  return ''
}

describe('ci.yml main-push concurrency supersedes rather than piling up (#7905)', () => {
  let workflows
  /** @type {Map<string, any>} workflow file name -> parsed top-level YAML document */
  let docs
  let parseErrors

  before(async () => {
    workflows = await readWorkflows()
    docs = new Map()
    parseErrors = []
    for (const w of workflows) {
      try {
        docs.set(w.name, yaml.load(w.text))
      } catch (err) {
        parseErrors.push(`${w.name}: ${err.message}`)
      }
    }
  })

  // ---- positive control ---------------------------------------------------
  // Every rule below reads `docs`. A reader that silently produced nothing —
  // js-yaml throwing on every file, or `readWorkflows` finding none — must not
  // let the rules below pass vacuously over an empty set (docs/false-safety-
  // guards.md's "cannot check this treated as nothing to check").

  it('parses every workflow file as valid YAML and finds ci.yml', () => {
    assertReaderSane(workflows)
    assert.deepEqual(parseErrors, [], `js-yaml failed to parse: ${parseErrors.join('; ')}`)
    assert.ok(docs.has('ci.yml'), 'expected ci.yml among the parsed workflow documents')
    const ci = docs.get('ci.yml')
    assert.equal(typeof ci, 'object', 'ci.yml did not parse to an object')
    assert.equal(typeof ci.concurrency, 'object', 'ci.yml has no top-level concurrency: block')
    // A job COUNT threshold is brittle against a legitimate job-count refactor;
    // a stable sentinel job id is not. `runner-target` computes the self-hosted
    // vs. hosted runner routing every other job depends on (see the
    // SELF_HOSTED_OR_HOSTED comment below) and is exactly the kind of job whose
    // disappearance from the parsed document means the reader broke, not that
    // ci.yml was refactored.
    assert.ok(
      Object.keys(ci.jobs ?? {}).length > 0,
      'expected at least one job in ci.yml — the parser may have stopped understanding this file'
    )
    assert.ok(
      Object.prototype.hasOwnProperty.call(ci.jobs ?? {}, 'runner-target'),
      `expected ci.yml's "runner-target" job among the parsed jobs, found: ${Object.keys(ci.jobs ?? {}).join(', ')}`
    )
  })

  // ---- the rules ------------------------------------------------------------

  it("ci.yml's concurrency.group does not fall back to github.run_id on push", () => {
    const group = docs.get('ci.yml').concurrency.group
    assert.equal(typeof group, 'string', `concurrency.group must be a string, got ${typeof group}`)
    assert.ok(
      !/run_id/.test(group),
      "concurrency.group must not reference github.run_id: it is unique per run (GitHub docs), " +
        `so a push-triggered group keyed on it can never supersede another push's run (#7905). Got: ${group}`
    )
    assert.ok(
      /head_ref/.test(group) && /\bgithub\.ref\b/.test(group),
      'concurrency.group must key pull_request runs on github.head_ref and fall back to ' +
        `github.ref (stable per branch across a burst of pushes) for every other event. Got: ${group}`
    )
    // Pins the exact expression the fix landed, on top of the semantic checks
    // above — the two together mean a future edit that satisfies the letter
    // (some ref-based fallback) but not the spirit (this exact, reviewed
    // expression) still gets a legible diff to look at rather than a silent
    // pass.
    assert.equal(
      group,
      'ci-${{ github.head_ref || github.ref }}',
      'ci.yml concurrency.group must be exactly this expression (#7905)'
    )
  })

  it("ci.yml's cancel-in-progress is not unconditionally true", () => {
    const cip = docs.get('ci.yml').concurrency['cancel-in-progress']
    assert.notEqual(
      cip,
      true,
      'cancel-in-progress: true unconditionally cancels an IN-PROGRESS main-push run too, which ' +
        'drops coverage of whatever commit that run was validating (#7905) — it must be scoped to ' +
        `pull_request events only. Got: ${JSON.stringify(cip)}`
    )
    assert.equal(typeof cip, 'string', `expected a gated expression string, got ${typeof cip}`)
    assert.ok(
      /pull_request/.test(cip),
      `cancel-in-progress must gate on github.event_name == 'pull_request'. Got: ${cip}`
    )
    assert.equal(
      cip,
      "${{ github.event_name == 'pull_request' }}",
      'ci.yml cancel-in-progress must be exactly this expression (#7905)'
    )
  })

  it('ci.yml is triggered by exactly push and pull_request — no event type collapses into the same group unexamined', () => {
    // The group expression's safety argument rests on `github.ref` being
    // stable ACROSS THE EVENT TYPES THAT ACTUALLY REACH THIS WORKFLOW. A
    // workflow_dispatch or merge_group trigger added later would also have an
    // empty head_ref and would resolve to the SAME `refs/heads/main` group as
    // an ordinary push — not necessarily wrong, but a case this fix never
    // considered. Pinning the trigger set means that addition fails this test
    // and forces a conscious look, rather than silently sharing a group.
    const triggers = Object.keys(docs.get('ci.yml').on).sort()
    assert.deepEqual(
      triggers,
      ['pull_request', 'push'],
      `ci.yml's trigger types changed to ${JSON.stringify(triggers)} — the #7905 concurrency group ` +
        'expression was only verified safe for {push, pull_request}; revisit the comment above ' +
        "concurrency: in ci.yml before adding another trigger"
    )
  })

  it('no push-triggered workflow anywhere in the repo falls back to github.run_id in its concurrency group, at either workflow or job level', () => {
    // Scoped to the DEFECT (#7386's lesson): any workflow that gains a `push`
    // trigger and a `concurrency.group` keyed on `head_ref || run_id` hits the
    // exact #7905 pile-up, whether or not it is named ci.yml, and whether the
    // block sits at the workflow level or inside one of its jobs.
    const offenders = []
    for (const w of workflows) {
      const doc = docs.get(w.name)
      if (!doc || !doc.on || !Object.prototype.hasOwnProperty.call(doc.on, 'push')) continue

      const workflowGroup = concurrencyGroup(doc.concurrency)
      if (/run_id/.test(workflowGroup)) offenders.push(`${w.name}: ${workflowGroup}`)

      for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
        const jobGroup = concurrencyGroup(job?.concurrency)
        if (/run_id/.test(jobGroup)) offenders.push(`${w.name} job "${jobId}": ${jobGroup}`)
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'a push-triggered workflow keys a concurrency group (workflow- or job-level) on github.run_id, ' +
        `which is unique per run and can never coalesce a burst of pushes (#7905):\n  ${offenders.join('\n  ')}`
    )
  })
})
