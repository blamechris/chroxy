import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseJobs, code, ROUTED_RUNNER_OUTPUTS } from './helpers/workflow-reader.js'

/**
 * #7471 — the three long Linux jobs are pinned to the X64 pool member.
 *
 * The two ARM64 Docker pool members service-cancel long jobs right around
 * their healthy completion mark (~10 min); every carcass re-ran green once it
 * landed on the winbox VM. Until the root cause (broker-side cancels on the
 * ARM64 containers) is fixed, Server Tests / Dashboard Tests / Scripts Tests
 * route through `runner-target.outputs.longrunner`, which narrows the same
 * pool by the `X64` label. Full rationale: the LONG-JOB PINNING note in
 * ci.yml's header. When #7471 closes, this file is deleted together with the
 * pin (the header note says so too).
 */

const PINNED_JOBS = ['server-tests', 'dashboard-tests', 'scripts-tests']
const LONGRUNNER_EXPR = 'fromJSON(needs.runner-target.outputs.longrunner)'

describe('CI long-job runner pinning (#7471)', () => {
  let jobs

  before(async () => {
    const ciYml = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    jobs = parseJobs(ciYml)
  })

  // ---- positive control ---------------------------------------------------
  // Every assertion below quantifies over what the reader found; a broken
  // reader must fail HERE, not pass the rules over an empty set.

  it('parses ci.yml and finds runner-target plus all three pinned jobs', () => {
    for (const id of ['runner-target', ...PINNED_JOBS]) {
      assert.ok(
        jobs.some(j => j.id === id),
        `expected job '${id}' among: ${jobs.map(j => j.id).join(', ')}`
      )
    }
  })

  it('runner-target exposes a longrunner output', () => {
    const job = jobs.find(j => j.id === 'runner-target')
    assert.ok(
      code(job.body).some(l =>
        /^\s*longrunner:\s*\$\{\{\s*steps\.resolve\.outputs\.longrunner\s*\}\}\s*$/.test(l)
      ),
      "runner-target must expose 'longrunner: ${{ steps.resolve.outputs.longrunner }}' in its outputs"
    )
  })

  it('resolves longrunner to the X64 pool for self-hosted and ubuntu-24.04 for forks, per branch', () => {
    // Same branch-scoped discipline as the npmcache guard: assert each value
    // INSIDE its own branch of the resolve script, so a swap fails — both
    // strings merely appearing somewhere would pass a swapped pair.
    const job = jobs.find(j => j.id === 'runner-target')
    const resolveStep = job.steps.find(s => s.some(l => /^\s*(- )?id: resolve\s*$/.test(l)))
    assert.ok(resolveStep, "expected a step with 'id: resolve' in runner-target")
    const text = code(resolveStep).join('\n')

    const ifAt = text.indexOf('echo \'runner=["self-hosted"')
    const elseAt = text.indexOf('echo \'runner="ubuntu-24.04"\'')
    assert.ok(ifAt !== -1 && elseAt !== -1 && ifAt < elseAt, 'expected the two runner= branches, self-hosted first')

    const selfHostedBranch = text.slice(ifAt, elseAt)
    const hostedBranch = text.slice(elseAt)

    assert.ok(
      selfHostedBranch.includes('echo \'longrunner=["self-hosted", "Linux", "chroxy-linux", "X64"]\''),
      'the self-hosted branch must narrow longrunner by the X64 label — that is the whole #7471 pin'
    )
    assert.ok(
      hostedBranch.includes('echo \'longrunner="ubuntu-24.04"\''),
      'the fork branch must keep longrunner GitHub-hosted — untrusted code never runs self-hosted'
    )
  })

  it('each long job takes runs-on from longrunner', () => {
    for (const id of PINNED_JOBS) {
      const job = jobs.find(j => j.id === id)
      assert.ok(
        job.runsOn.includes(LONGRUNNER_EXPR),
        `${id} must run on \${{ ${LONGRUNNER_EXPR} }} (#7471 pin) — got: ${job.runsOn}`
      )
    }
  })

  it('no other job uses longrunner', () => {
    // Keeps the pin roster exact in both directions: unpinning a job (or a new
    // job quietly adopting the narrowed pool) must show up as a deliberate
    // edit to PINNED_JOBS, which forces reading the #7471 header note.
    const offenders = jobs
      .filter(j => !PINNED_JOBS.includes(j.id) && j.runsOn.includes('outputs.longrunner'))
      .map(j => j.id)
    assert.deepEqual(offenders, [], `only ${PINNED_JOBS.join('/')} may use longrunner: ${offenders.join(', ')}`)
  })

  it('longrunner is registered in ROUTED_RUNNER_OUTPUTS', () => {
    // Without this row the three pinned jobs silently drop out of every guard
    // that quantifies over "routed" jobs — most importantly the #7383
    // npm-cache rules — while both suites stay green. Guard-wired-to-some-
    // of-its-callers, in the meta direction.
    assert.ok(
      ROUTED_RUNNER_OUTPUTS.includes('needs.runner-target.outputs.longrunner'),
      "workflow-reader's ROUTED_RUNNER_OUTPUTS must include the longrunner path"
    )
  })
})
