import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJobs, code, stepInput, stepRun } from './helpers/workflow-reader.js'

/**
 * Run the locate step's ACTUAL script against a synthetic runner layout.
 *
 * The string-matching version of this guard was proven blind: replacing the
 * parse with a hardcoded `node_version=20 # $(sed ...)` left every assertion
 * green, because `stepRun` returns block scalars with their shell comments
 * intact and the comment still contained the matched words. A guard satisfiable
 * by a comment is satisfiable by prose. So the script is executed, against an
 * action.yml pinning a version NO ONE WOULD HARDCODE (99) — a literal in the
 * workflow cannot produce it.
 *
 * POSIX only: spawns bash, which on the Windows runner is WSL with no distro
 * (see EXEMPT_REASONS['posix-shell-spawn'] in scripts/lib/windows-test-set.mjs).
 * Skipped there per-test rather than exempting the whole file, which is the
 * preferred fix that manifest names — the other rules here run on Windows fine.
 */
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'spawns bash (POSIX-only)' : false }

const scratch = []

function runLocate(script, { dirs = 1, nodeVersion = '99', actionYml = true, lockfile = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-relay-locate-'))
  scratch.push(root)
  const workspace = join(root, 'work', 'chroxy')
  mkdirSync(workspace, { recursive: true })
  for (let i = 0; i < dirs; i++) {
    const d = join(root, 'work', '_actions', 'blamechris', 'repo-relay', `ref${i}`)
    mkdirSync(d, { recursive: true })
    if (lockfile) writeFileSync(join(d, 'package-lock.json'), '{}')
    if (actionYml) {
      writeFileSync(
        join(d, 'action.yml'),
        `runs:\n  using: 'composite'\n  steps:\n    - uses: actions/setup-node@0000\n      with:\n${
          nodeVersion === null ? '' : `        node-version: '${nodeVersion}'\n`
        }`
      )
    }
  }
  const outFile = join(root, 'github_output')
  writeFileSync(outFile, '')
  const scriptFile = join(root, 'locate.sh')
  writeFileSync(scriptFile, script)
  const r = spawnSync('bash', [scriptFile], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_WORKSPACE: workspace, GITHUB_OUTPUT: outFile },
  })
  return { status: r.status, outputs: readFileSync(outFile, 'utf8'), stderr: r.stderr ?? '', stdout: r.stdout ?? '' }
}

/**
 * #7632 — a transient failure in repo-relay's OWN dependency install must not
 * red an unrelated PR, and nothing weaker may be traded for it.
 *
 * repo-relay is a COMPOSITE action: Setup Node.js → Install dependencies
 * (`npm ci --omit=dev`) → Validate inputs → Run repo-relay. `best_effort`
 * (#6746) is read by that LAST step, so it tolerates transient failures at
 * RUNTIME while still failing loudly on definitive config errors — a revoked
 * token, a deleted channel. A failure in `Install dependencies` skips both
 * remaining steps, so best_effort never runs and cannot cover it.
 *
 * The fix pre-runs that install in a step this workflow owns and tolerates,
 * and gates the action on its `outcome`. Four things must stay true.
 *
 * 1. THE PROBE RUNS ON THE ACTION'S OWN NODE VERSION, READ FROM THE ACTION.
 *    This is the invariant the whole design rests on, and the first draft got
 *    it wrong. `better-sqlite3@12.10.0` ships no prebuilt binary for node 20's
 *    ABI (its linux-x64 assets are v127/v137/v141/v147 — node 22 and newer) and
 *    repo-relay pins node 20, so its install falls back to `node-gyp rebuild`
 *    and fetches node headers from nodejs.org every run. That fetch is what
 *    ECONNRESET'd. A probe on any OTHER node takes the prebuild path instead —
 *    measured at 5s versus the action's 67s in the same job — and never touches
 *    the failing hop at all. It would have passed on the day of the outage and
 *    opened the gate, and the action would have failed anyway. A probe that
 *    does not exercise the failure it gates is not a probe, so the version is
 *    read out of the action's own action.yml rather than copied here, where a
 *    copy would silently go stale the moment repo-relay bumps.
 * 2. Exactly ONE step is tolerated, and it is the install. Locating the action
 *    is NOT tolerated: a checkout that stops resolving would skip the action on
 *    every run with the job still green — "a precondition that is false, so the
 *    body never runs and the job is green" in docs/false-safety-guards.md.
 * 3. The action step itself is NOT continue-on-error and still passes
 *    `best_effort: 'true'`. That blanket switch is what #6746 removed; re-adding
 *    it would silence the definitive config errors too.
 * 4. The action is located by GLOB, never by repeating its pinned SHA — a second
 *    copy of the pin drifts on the next bump, and a stale path fails the gate on
 *    every run.
 *
 * Assertions are anchored to step bodies via the shared reader, never to a
 * file-wide grep: this workflow's comments quote the very strings the rules
 * match on (`continue-on-error`, `best_effort` and `node-version` all appear in
 * the prose explaining them), and a guard that reads prose as configuration is
 * satisfiable by prose.
 */
describe('repo-relay tolerates its own dependency install failing (#7632)', () => {
  let notify
  let relayStep
  let tolerated
  let setupNode
  let locateStep

  before(async () => {
    const yml = await readFile(new URL('../../../.github/workflows/repo-relay.yml', import.meta.url), 'utf8')
    notify = parseJobs(yml, 'repo-relay.yml').find(j => j.id === 'notify')
    const steps = notify?.steps ?? []
    relayStep = steps.find(s => code(s).some(l => l.includes('blamechris/repo-relay@')))
    tolerated = steps.filter(s => stepInput(s, 'continue-on-error') === 'true')
    setupNode = steps.find(s => code(s).some(l => l.includes('actions/setup-node@')))
    const ref = /steps\.([A-Za-z0-9_-]+)\.outputs\.node_version/.exec(stepInput(setupNode ?? [], 'node-version') ?? '')
    locateStep = ref ? steps.find(s => stepInput(s, 'id') === ref[1]) : undefined
  })

  // ---- positive control ---------------------------------------------------
  // Every rule below reads through these. If the reader stops understanding
  // this file they are undefined and the rules either throw or pass over
  // nothing; this makes a broken reader fail here, loudly, first.
  it('reads the notify job and finds its steps', () => {
    assert.ok(notify, 'expected a notify job in repo-relay.yml')
    assert.ok(notify.steps.length >= 6, `expected >=6 steps in notify, found ${notify.steps.length}`)
    assert.ok(relayStep, 'expected a step using blamechris/repo-relay@')
    assert.ok(setupNode, 'expected a setup-node step preparing the probe')
    assert.equal(tolerated.length, 1, `expected exactly one continue-on-error step, found ${tolerated.length}`)
  })

  it('runs the probe on the node version READ FROM the action, not a copy of it', () => {
    const version = stepInput(setupNode, 'node-version')
    assert.match(
      version ?? '',
      /^\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.node_version\s*\}\}$/,
      'setup-node must take the version from the locate step\'s output. A literal here goes stale the ' +
        'moment repo-relay bumps its node, and the probe would then exercise a different install than ' +
        `the one it gates — the defect this guard exists for. Got: ${version}`
    )
    assert.ok(locateStep, 'the step whose output feeds setup-node must exist in this job')
  })

  after(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true })
  })

  it('READS the version out of the action, proven by running the script', POSIX_ONLY, () => {
    // 99 is not a node version anyone would hardcode: only a real parse of the
    // synthetic action.yml can produce it. This is what makes the rule immune
    // to being satisfied by a comment, which the string-matching version was.
    const r = runLocate(stepRun(locateStep), { nodeVersion: '99' })
    assert.equal(r.status, 0, `locate script failed: ${r.stderr}`)
    assert.match(
      r.outputs,
      /(^|\n)node_version=99(\n|$)/,
      `the locate step must publish the version it READ from action.yml, not a literal. Outputs were: ${r.outputs}`
    )
    assert.match(r.outputs, /(^|\n)dir=.*repo-relay/, `expected a dir output pointing at the checkout: ${r.outputs}`)
  })

  it('fails loudly on every layout it does not understand', POSIX_ONLY, () => {
    const script = stepRun(locateStep)
    for (const [label, opts] of [
      ['no action checkout', { dirs: 0 }],
      ['two action checkouts', { dirs: 2 }],
      ['action.yml missing', { actionYml: false }],
      ['action.yml declares no node-version', { nodeVersion: null }],
      // A missing lockfile is permanent, not transient: `npm ci` refuses. If it
      // reached the tolerated step it would skip the notification forever, green.
      ['package-lock.json missing', { lockfile: false }],
    ]) {
      const r = runLocate(script, opts)
      assert.notEqual(r.status, 0, `${label}: expected a non-zero exit, got ${r.status}`)
      assert.doesNotMatch(
        r.outputs,
        /node_version=/,
        `${label}: must not publish a version it could not read — setup-node would silently take an empty one`
      )
    }
  })

  it('tolerates ONLY the install, and locating the action is not tolerated', () => {
    assert.match(
      stepRun(tolerated[0]) ?? '',
      // Anchored per-line: a bare /npm ci/ is satisfied by a shell COMMENT
      // containing those words, and `stepRun` deliberately keeps comments in a
      // block scalar. Proven by mutation — commenting the install out left the
      // substring form green while the step became a no-op.
      /^\s*npm ci\b/m,
      'the tolerated step must actually RUN the dependency install — gating on a step that installs nothing tests nothing'
    )
    assert.notEqual(
      stepInput(locateStep, 'id'),
      stepInput(tolerated[0], 'id'),
      'locating the action must NOT be the tolerated step: a checkout that stops resolving would then be ' +
        'swallowed, skipping the action on every run with the job still green'
    )
    assert.equal(
      stepInput(locateStep, 'continue-on-error'),
      undefined,
      'the locate step must fail the job, not be tolerated'
    )
    const id = stepInput(tolerated[0], 'id')
    assert.ok(
      stepInput(relayStep, 'if')?.includes(`steps.${id}.outcome == 'success'`),
      `the repo-relay step must be gated on steps.${id}.outcome == 'success', got: ${stepInput(relayStep, 'if')}`
    )
  })

  it('keeps best_effort and does NOT blanket-tolerate the action step itself', () => {
    assert.equal(
      stepInput(relayStep, 'continue-on-error'),
      undefined,
      'the repo-relay step must not be continue-on-error — that is the blanket switch #6746 replaced, ' +
        'and it would silence the definitive config errors best_effort still raises'
    )
    assert.equal(stepInput(relayStep, 'best_effort'), 'true', 'best_effort must stay enabled (#6746)')
  })

  it('locates the action checkout by glob, never by repeating the pinned SHA', () => {
    const sha = /blamechris\/repo-relay@([0-9a-f]{40})/.exec(code(relayStep).join('\n'))?.[1]
    assert.ok(sha, 'expected the repo-relay action to be pinned to a full SHA')
    const script = stepRun(locateStep) ?? ''
    assert.match(script, /_actions\/blamechris\/repo-relay\/\*\//, 'the locate step must find the checkout by glob')
    assert.ok(
      !script.includes(sha),
      'the locate step must not repeat the pinned SHA — a second copy drifts on the next version bump, ' +
        'and a stale path fails the gate on every run, silently disabling notifications'
    )
  })
})
