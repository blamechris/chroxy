import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  readWorkflows,
  assertReaderSane,
  stepInput,
  SETUP_NODE,
  LOCKFILE_GLOB,
} from './helpers/workflow-reader.js'

/**
 * setup-node's npm cache KEY must cover all three lockfiles — in every workflow.
 *
 * This repo is an npm-workspaces monorepo with three `package-lock.json` files.
 * `actions/setup-node`'s default `cache-dependency-path` is the ROOT lockfile
 * alone, so a job that omits the input, or sets it to the bare
 * `package-lock.json`, hashes only the root file: a dependency change under
 * `packages/` does not bust the key and the job restores a stale `~/.npm`.
 *
 * WHY THIS SCANS EVERY WORKFLOW (#7386)
 * -------------------------------------
 * It used to read `ci.yml` and nothing else, which made it blind to the exact
 * defect it exists to catch. Two instances lived one file over the whole time
 * it was green:
 *
 *   - `maestro-nightly.yml` carried `cache-dependency-path: package-lock.json`
 *     (found while fixing #7383, not by this guard);
 *   - `release.yml` carried it FOUR times — so a release build could be cut from
 *     a stale cache, which is the worst place in the repo for this to happen.
 *
 * That is the first recurring cause in docs/false-safety-guards.md — "a
 * hardcoded list next to a set that grows" — and a file-scoped guard is a
 * hardcoded list of one. The rule is now scoped to the DEFECT: any setup-node
 * step, in any workflow file, including files that do not exist yet. Discovery
 * is `readdir`, never a roster held here.
 *
 * The reader is shared with `ci-npm-cache-routing.test.js`
 * (`helpers/workflow-reader.js`) rather than transcribed, so the two guards
 * cannot drift apart in what they can see.
 */
describe('setup-node npm cache key covers every lockfile (#7386)', () => {
  let workflows
  let steps

  before(async () => {
    workflows = await readWorkflows()
    steps = workflows.flatMap(w =>
      w.jobs.flatMap(job =>
        job.steps
          .filter(s => s.some(l => l.includes(SETUP_NODE)))
          .map(step => ({ where: `${w.name}:${job.line} ${job.id}`, step }))
      )
    )
  })

  // ---- positive control ---------------------------------------------------
  // Both rules below quantify over `steps`. A reader that finds nothing passes
  // them vacuously and reports a clean green — the failure mode that let
  // release.yml's four offenders sit under a green guard for as long as they did.

  it('reads every workflow and finds the setup-node steps', () => {
    assertReaderSane(workflows)
    assert.ok(
      steps.length >= 15,
      `expected >=15 setup-node steps across all workflows, found ${steps.length}`
    )
    // The specific file this guard was blind to, named so a readdir/parse
    // regression that drops it is a failure rather than a smaller scan.
    assert.ok(
      steps.some(s => s.where.startsWith('release.yml:')),
      `expected setup-node steps in release.yml among: ${[...new Set(steps.map(s => s.where.split(':')[0]))].join(', ')}`
    )
  })

  // ---- the rules ----------------------------------------------------------

  it('every declared cache-dependency-path is the lockfile glob', () => {
    const offenders = steps
      .map(({ where, step }) => ({ where, value: stepInput(step, 'cache-dependency-path') }))
      .filter(({ value }) => value !== undefined && value !== LOCKFILE_GLOB)
      .map(({ where, value }) => `${where} -> ${value}`)

    assert.deepEqual(
      offenders,
      [],
      `cache-dependency-path must be '${LOCKFILE_GLOB}'. The bare 'package-lock.json' hashes only ` +
        'the ROOT lockfile, so a dependency change under packages/ leaves the key intact and the ' +
        `job restores a stale cache (#7386):\n  ${offenders.join('\n  ')}`
    )
  })

  it('every setup-node step that caches at all declares a cache-dependency-path', () => {
    // The omission half, and the one a value-only rule cannot see: leaving the
    // input off entirely is not "no cache key", it is the DEFAULT key — the root
    // lockfile alone, i.e. exactly the bug the rule above forbids spelling out.
    // "Cannot see a value" must not read as "nothing to check".
    //
    // A step with no `cache:` at all (scripts-tests, release-pr-subject,
    // dashboard-smoke, maestro) uses setup-node for the Node runtime alone and
    // is correctly exempt — cache-dependency-path is inert without `cache:`.
    //
    // The exemption is on the LITERAL text, which is the only thing a static
    // reader has. #7383's routed steps carry `cache: ${{ ... .npmcache }}`, a
    // non-empty string here even though it resolves to empty on the self-hosted
    // branch at runtime — so they are REQUIRED to declare the path, and do. That
    // is the right answer for the reason that matters: the same expression
    // resolves to `npm` on the hosted fork-PR branch, which is exactly the case
    // the key has to be correct for. A literal `cache: ''` would be exempt by
    // falsiness; no workflow writes one today.
    const offenders = steps
      .filter(({ step }) => {
        const cache = stepInput(step, 'cache')
        return !!cache && stepInput(step, 'cache-dependency-path') === undefined
      })
      .map(({ where }) => where)

    assert.deepEqual(
      offenders,
      [],
      "a setup-node step with a non-empty 'cache:' must declare " +
        `'cache-dependency-path: ${LOCKFILE_GLOB}' — omitting it silently keys the cache on the ` +
        `root lockfile alone:\n  ${offenders.join('\n  ')}`
    )
  })
})
