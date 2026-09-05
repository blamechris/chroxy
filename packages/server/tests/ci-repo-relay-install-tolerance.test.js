import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseJobs, code, stepInput, stepRun } from './helpers/workflow-reader.js'

/**
 * #7632 — a transient failure in repo-relay's OWN dependency install must not
 * red an unrelated PR, and nothing weaker than that may be traded for it.
 *
 * repo-relay is a COMPOSITE action: Setup Node.js → Install dependencies
 * (`npm ci --omit=dev`) → Validate inputs → Run repo-relay (`node dist/cli.js`).
 * `best_effort` (#6746) is read by that LAST step, so it tolerates transient
 * Discord/network failures at RUNTIME while still failing loudly on definitive
 * config errors — a revoked token, a deleted channel. A failure in `Install
 * dependencies` skips both remaining steps, so `best_effort` never runs and
 * cannot cover it. `better-sqlite3` is native with no committed node_modules,
 * so that install fetches over the network twice on every run and either hop
 * can ECONNRESET (observed on #7630, run 33937387078).
 *
 * The fix runs that install FIRST, in a step this workflow owns and tolerates,
 * and gates the action on its `outcome`. The three things that must stay true:
 *
 *  1. The install is pre-run in a tolerated step, and the action is gated on it
 *     — otherwise the transient failure reds the PR again.
 *  2. The action step itself is NOT continue-on-error and still passes
 *     `best_effort: 'true'`. That blanket switch is exactly what #6746 removed;
 *     re-adding it would silence the definitive config errors too, which is the
 *     regression this issue's acceptance criteria name outright.
 *  3. A step fails LOUDLY when the pre-install could not locate the action's
 *     checkout. That is the dangerous direction: the gate would evaluate false
 *     on every run, skipping the action forever with the job still green —
 *     "a precondition that is false, so the body never runs and the job is
 *     green" in docs/false-safety-guards.md. `continue-on-error` swallows the
 *     step's exit code, so an OUTPUT carries the distinction instead.
 *
 * Assertions are anchored to step bodies via the shared reader, never to a
 * file-wide grep: this workflow's comments quote the very strings the rules
 * match on (`continue-on-error` and `best_effort` both appear in the prose
 * explaining them), and a guard that reads prose as configuration is satisfiable
 * by prose.
 */
describe('repo-relay tolerates its own dependency install failing (#7632)', () => {
  let notify
  let relayStep
  let tolerated

  before(async () => {
    const yml = await readFile(new URL('../../../.github/workflows/repo-relay.yml', import.meta.url), 'utf8')
    notify = parseJobs(yml, 'repo-relay.yml').find(j => j.id === 'notify')
    relayStep = notify?.steps.find(s => code(s).some(l => l.includes('blamechris/repo-relay@')))
    tolerated = notify?.steps.filter(s => stepInput(s, 'continue-on-error') === 'true') ?? []
  })

  // ---- positive control ---------------------------------------------------
  // Every rule below reads through `notify` / `relayStep`. If the reader stops
  // understanding this file they are undefined and the rules either throw or
  // pass over nothing; this makes a broken reader fail here, loudly, first.
  it('reads the notify job and finds the repo-relay action step', () => {
    assert.ok(notify, 'expected a notify job in repo-relay.yml')
    assert.ok(notify.steps.length >= 5, `expected >=5 steps in notify, found ${notify.steps.length}`)
    assert.ok(relayStep, 'expected a step using blamechris/repo-relay@')
    assert.equal(tolerated.length, 1, `expected exactly one continue-on-error step, found ${tolerated.length}`)
  })

  it('pre-runs the install in a tolerated step and gates the action on its outcome', () => {
    const id = stepInput(tolerated[0], 'id')
    assert.ok(id, 'the tolerated pre-install step must have an id for the action to reference')

    const script = stepRun(tolerated[0])
    assert.match(
      script ?? '',
      /npm ci/,
      'the tolerated step must actually run the action\'s dependency install — ' +
        'gating on a step that installs nothing tests nothing'
    )

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

  it('fails loudly when the action checkout cannot be located', () => {
    const id = stepInput(tolerated[0], 'id')
    const guard = notify.steps.find(
      s => s !== tolerated[0] && stepInput(s, 'if')?.includes(`steps.${id}.outputs.layout`)
    )
    assert.ok(
      guard,
      'expected a step gated on the pre-install\'s layout output — without it, a checkout path that ' +
        'stops resolving disables every notification silently while the job stays green'
    )
    assert.match(stepRun(guard) ?? '', /exit 1/, 'the layout guard must fail the job, not just log')
  })

  it('locates the action checkout by glob, never by repeating the pinned SHA', () => {
    const sha = /blamechris\/repo-relay@([0-9a-f]{40})/.exec(code(relayStep).join('\n'))?.[1]
    assert.ok(sha, 'expected the repo-relay action to be pinned to a full SHA')
    const script = stepRun(tolerated[0]) ?? ''
    assert.match(script, /_actions\/blamechris\/repo-relay\/\*\//, 'the pre-install must find the checkout by glob')
    assert.ok(
      !script.includes(sha),
      'the pre-install must not repeat the pinned SHA — a second copy drifts on the next version ' +
        'bump, and a stale path fails the gate on every run, silently disabling notifications'
    )
  })
})
