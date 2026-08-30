import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { readWorkflows, assertReaderSane, code } from './helpers/workflow-reader.js'

/**
 * #7504 — a test suite that runs in no workflow, and a green CI, are the same
 * observable outcome.
 *
 * `scripts/__tests__/merge-updater-feeds.test.sh` was executable, passing, and
 * referenced by ZERO workflow steps for its whole life. Its subject is
 * release-critical: release.yml folds the per-platform Tauri updater feeds into
 * the one latest.json the auto-updater serves. Nothing would have gone red.
 *
 * The cause is structural, not a one-off oversight: `scripts-tests` names each
 * suite in its own hand-written step, which is a hardcoded list beside a
 * growing directory — the first cause in docs/false-safety-guards.md. Fixing
 * only the orphan leaves the next one exactly as invisible, so this guard
 * quantifies over the DIRECTORY.
 *
 * Registration is checked across ALL workflows, not just ci.yml's
 * `scripts-tests` job: a suite legitimately wired into release.yml or a nightly
 * is registered, and demanding one particular job would be a guard that fails
 * on correct configurations.
 */

const TESTS_DIR = new URL('../../../scripts/__tests__/', import.meta.url)

describe('scripts/__tests__ suites are registered in a workflow (#7504)', () => {
  let suites
  let workflows

  before(async () => {
    const entries = await readdir(TESTS_DIR, { withFileTypes: true })
    suites = entries
      .filter(e => e.isFile() && /\.test\.(sh|mjs|js)$/.test(e.name))
      .map(e => e.name)
      .sort()
    workflows = await readWorkflows()
  })

  // ---- positive controls ----
  // Both rules below quantify over sets the readers produce. An empty
  // inventory, or a workflow reader that has stopped parsing these files, makes
  // every rule pass over nothing and report a clean green.
  it('finds the suite inventory and the workflows', () => {
    assert.ok(
      suites.length >= 10,
      `expected >=10 suites under scripts/__tests__/, found ${suites.length} — the inventory is broken`
    )
    assertReaderSane(workflows)
  })

  it('every suite is named by at least one workflow step', () => {
    // Matched against STEP BODIES with comments stripped. ci.yml's comments
    // discuss these files by name; a guard that reads prose as configuration is
    // satisfiable by prose, and the orphan would still have "passed".
    const stepText = workflows.flatMap(w =>
      w.jobs.flatMap(j => j.steps.map(s => code(s).join('\n')))
    )
    const orphans = suites.filter(
      name => !stepText.some(t => t.includes(`scripts/__tests__/${name}`))
    )
    assert.deepEqual(
      orphans,
      [],
      'suites under scripts/__tests__/ that no workflow step runs — a suite that never runs and a ' +
        `passing suite are the same observable outcome (#7504): ${orphans.join(', ')}`
    )
  })

  it('pins merge-updater-feeds.test.sh by name — the suite that was orphaned', () => {
    assert.ok(
      suites.includes('merge-updater-feeds.test.sh'),
      'merge-updater-feeds.test.sh must still exist; it covers the release updater-feed merge'
    )
  })
})

describe('Scripts Tests parse-checks every tracked shell script (#7504)', () => {
  let step

  before(async () => {
    const ci = workflowsByName(await readWorkflows(), 'ci.yml')
    const job = ci.jobs.find(j => j.id === 'scripts-tests')
    assert.ok(job, "ci.yml should have a 'scripts-tests' job")
    const matches = job.steps.filter(s => code(s).join('\n').includes('bash -n'))
    assert.equal(
      matches.length,
      1,
      `expected exactly one 'bash -n' step in scripts-tests, found ${matches.length}`
    )
    step = code(matches[0]).join('\n')
  })

  it('enumerates the whole tracked set, not a typed subdirectory glob', () => {
    // The pathspec is the property. Narrowing it to `scripts/*.sh` re-creates
    // the exact hole this closes — packages/server/scripts/,
    // packages/desktop/scripts/ and packages/app/.maestro/scripts/ all drop
    // out, and the step stays green while parsing 13 of 30 files.
    assert.ok(
      /git ls-files -z '\*\.sh'/.test(step),
      "the parse-check step must enumerate `git ls-files -z '*.sh'` — a narrower pathspec silently " +
        'skips whole script directories, and a list typed into CI config is reachable by no lint or test (#7270)'
    )
  })

  it('fails CLOSED when the enumeration comes back short', () => {
    // "Found nothing to check" must not read as "nothing wrong" — the second
    // cause in docs/false-safety-guards.md, and the one a `for f in glob` loop
    // gets wrong for free (an unmatched glob iterates zero times, exit 0).
    assert.ok(/-lt 20/.test(step), 'the parse-check step must assert a floor on the file count')
    assert.ok(/exit 2/.test(step), 'a broken enumeration must exit 2 — a distinct, loud outcome from 0')
  })
})

/** ci.yml, or a named assertion failure rather than an undefined deref. */
function workflowsByName(workflows, name) {
  const found = workflows.find(w => w.name === name)
  assert.ok(found, `expected ${name} among the scanned workflows`)
  return found
}
