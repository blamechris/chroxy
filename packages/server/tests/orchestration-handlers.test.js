import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orchestrationHandlers } from '../src/handlers/orchestration-handlers.js'
import { OrchestrationManager } from '../src/orchestration/orchestration-manager.js'
import { ServerOrchestrationRunSnapshotSchema } from '@chroxy/protocol'
import { makeOrchestrationHarness, waitFor } from './helpers/orchestration-harness.js'

// run_start's validateCwdAllowed requires the cwd to be within $HOME. Use a
// temp "home" (config.homeOverride) with the cwd under it — hermetic, no writes
// under the real home / ~/.chroxy (sandbox-guard safe).
const REAL_HOME = mkdtempSync(join(tmpdir(), 'chroxy-orch-home-'))
const REAL_CWD = join(REAL_HOME, 'repo')
mkdirSync(REAL_CWD, { recursive: true })
process.on('exit', () => { try { rmSync(REAL_HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

// #6691 S-2 — the WS surface. Flag-gated, host-authority + strict-primary,
// driven against a stub OrchestrationManager. No real sessions / ~/.chroxy.

const WS = {} // opaque handle passed to ctx.transport.send

// -- signature conformance (#7138) ------------------------------------------
//
// The stub below is a fake, and a fake accepts whatever it is handed. That is
// exactly how #7138 shipped: the handler called `startRun(optionBag)` for months
// against `startRun: async () => ...`, while the real engine's `startRun(runId)`
// would have thrown `run [object Object] not found` on the very first call — and
// `runAction` did not exist on the engine at all.
//
// So every stubbed call is checked against the REAL OrchestrationManager: the
// method must exist on its prototype, and the first argument must match the
// shape the real method destructures. Violations are RECORDED rather than
// thrown, because a throw inside the handler's own promise chain would be
// swallowed by its `.catch` and reported as a plain action error.

/**
 * What the real method's first parameter demands:
 *   'object'  — destructured (`createRun({ cwd, goal })`): must receive an object
 *   'id'      — an identifier named like an id (`startRun(runId)`): must receive a string
 *   'unknown' — anything else (e.g. an opaque forwarded bag, `createAndStartRun(opts = {})`)
 *   'none'    — no parameters
 * 'unknown' asserts nothing: guessing there would flag correct bag-forwarding,
 * and the real-engine block below covers those call shapes directly.
 */
function firstParamContract(fn) {
  const src = Function.prototype.toString.call(fn)
  const open = src.indexOf('(')
  if (open < 0) return 'none'
  let depth = 0
  let params = ''
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') { depth++; if (depth === 1) continue }
    else if (ch === ')') { depth--; if (depth === 0) break }
    if (depth >= 1) params += ch
  }
  const trimmed = params.trim()
  if (!trimmed) return 'none'
  if (trimmed.startsWith('{')) return 'object'
  const first = trimmed.split(',')[0].split('=')[0].trim()
  return /id$/i.test(first) ? 'id' : 'unknown'
}

function conformingManager(stub, violations) {
  return new Proxy(stub, {
    get(target, name) {
      if (typeof name !== 'string' || name === 'then') return target[name]
      const impl = target[name]
      const real = OrchestrationManager.prototype[name]
      if (typeof real !== 'function') {
        violations.push(`manager.${name}() does not exist on OrchestrationManager`)
        return impl
      }
      if (typeof impl !== 'function') return impl
      return (...args) => {
        const kind = firstParamContract(real)
        const got = args[0]
        const gotObject = got !== null && typeof got === 'object'
        if (kind === 'object' && !gotObject) {
          violations.push(`manager.${name}() takes an option bag; handler passed ${got === null ? 'null' : typeof got}`)
        } else if (kind === 'id' && gotObject) {
          violations.push(`manager.${name}() takes an id; handler passed an object`)
        }
        // Reflect.apply, not impl(...) — the target may be a real manager whose
        // methods need their receiver.
        return Reflect.apply(impl, target, args)
      }
    },
  })
}

// Keys MIRROR the real engine's public surface — a stub method the real class
// does not have is itself a conformance violation.
function mkManager(overrides = {}) {
  return {
    listRuns: async () => [{ runId: 'r1', title: 't', status: 'executing' }],
    getRunSnapshot: async (runId) => (runId === 'r1' ? { seq: 3, run: { runId: 'r1' } } : null),
    createRun: () => ({ runId: 'run_new' }),
    startRun: async () => ({ runId: 'run_new', phase: 'plan_review' }),
    createAndStartRun: async () => ({ runId: 'run_new' }),
    resolveGate: async () => ({ ok: true }),
    cancelRun: async () => ({ ok: true }),
    annotate: async () => ({ ok: true }),
    ...overrides,
  }
}

function mkCtx({ enabled = true, manager = mkManager() } = {}) {
  const sent = []
  const violations = []
  const ctx = {
    transport: { send: (_ws, msg) => sent.push(msg) },
    services: {
      config: {
        features: { orchestration: enabled },
        homeOverride: REAL_HOME, // scopes validateCwdAllowed's "within home" check to the temp home
      },
      orchestrationManager: manager ? conformingManager(manager, violations) : manager,
    },
  }
  return { ctx, sent, violations }
}

const hostClient = { isPrimaryToken: true, boundSessionId: null }
const boundClient = { isPrimaryToken: true, boundSessionId: 's-bound' }
const nonPrimaryClient = { isPrimaryToken: false, boundSessionId: null }

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('orchestration handlers — flag gate', () => {
  it('every handler is a silent no-op when the feature is off', async () => {
    const { ctx, sent } = mkCtx({ enabled: false })
    for (const [type, fn] of Object.entries(orchestrationHandlers)) {
      await fn(WS, hostClient, { type, runId: 'r1', gateId: 'g1', decision: 'approve', action: 'cancel', cwd: '/x' }, ctx)
    }
    await tick()
    assert.equal(sent.length, 0, 'nothing sent when disabled')
  })
})

describe('orchestration handlers — surveys', () => {
  it('runs_request replies with a snapshot from the manager', async () => {
    const { ctx, sent } = mkCtx()
    await orchestrationHandlers.orchestration_runs_request(WS, hostClient, { type: 'orchestration_runs_request', requestId: 'q1' }, ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'orchestration_runs_snapshot')
    assert.equal(sent[0].runs.length, 1)
    assert.equal(sent[0].requestId, 'q1')
  })

  it('run_detail_request replies with seq + run; not_found for a missing run', async () => {
    const { ctx, sent } = mkCtx()
    await orchestrationHandlers.orchestration_run_detail_request(WS, hostClient, { type: 'orchestration_run_detail_request', runId: 'r1' }, ctx)
    assert.equal(sent[0].seq, 3)
    assert.equal(sent[0].run.runId, 'r1')
    await orchestrationHandlers.orchestration_run_detail_request(WS, hostClient, { type: 'orchestration_run_detail_request', runId: 'missing' }, ctx)
    assert.equal(sent[1].run, null)
    assert.equal(sent[1].error.code, 'not_found')
    // the degraded run:null reply must still validate against the wire schema
    assert.equal(ServerOrchestrationRunSnapshotSchema.safeParse(sent[1]).success, true)
  })

  it('a session-bound client is refused (host authority)', async () => {
    const { ctx, sent } = mkCtx()
    await orchestrationHandlers.orchestration_runs_request(WS, boundClient, { type: 'orchestration_runs_request' }, ctx)
    assert.equal(sent[0].error.code, 'host_authority_required')
  })
})

describe('orchestration handlers — actions', () => {
  it('run_start acks with the new runId (host + primary)', async () => {
    const { ctx, sent } = mkCtx()
    orchestrationHandlers.orchestration_run_start(WS, hostClient, { type: 'orchestration_run_start', preset: 'repo-audit', cwd: REAL_CWD }, ctx)
    await tick()
    assert.equal(sent[0].type, 'orchestration_action_ack')
    assert.equal(sent[0].action, 'start')
    assert.equal(sent[0].runId, 'run_new')
  })

  it('run_start requires the primary token', async () => {
    const { ctx, sent } = mkCtx()
    orchestrationHandlers.orchestration_run_start(WS, nonPrimaryClient, { type: 'orchestration_run_start', preset: 'repo-audit', cwd: REAL_CWD }, ctx)
    await tick()
    assert.equal(sent[0].code, 'ORCHESTRATION_ACTION_FAILED')
    assert.equal(sent[0].reason, 'primary_token_required')
  })

  it('gate_response approve requires primary; reject/revise do not', async () => {
    const a = mkCtx()
    orchestrationHandlers.orchestration_gate_response(WS, nonPrimaryClient, { type: 'orchestration_gate_response', runId: 'r1', gateId: 'g1', decision: 'approve' }, a.ctx)
    await tick()
    assert.equal(a.sent[0].reason, 'primary_token_required')
    const b = mkCtx()
    orchestrationHandlers.orchestration_gate_response(WS, nonPrimaryClient, { type: 'orchestration_gate_response', runId: 'r1', gateId: 'g1', decision: 'reject' }, b.ctx)
    await tick()
    assert.equal(b.sent[0].type, 'orchestration_action_ack') // reject allowed for non-primary host client
    assert.equal(b.sent[0].action, 'gate_response')
  })

  it('run_action acks cancel/pause/resume', async () => {
    const { ctx, sent } = mkCtx()
    orchestrationHandlers.orchestration_run_action(WS, hostClient, { type: 'orchestration_run_action', runId: 'r1', action: 'cancel' }, ctx)
    await tick()
    assert.equal(sent[0].action, 'cancel')
    assert.equal(sent[0].runId, 'r1')
  })

  it('surfaces ORCHESTRATION_ACTION_FAILED when the manager throws', async () => {
    const { ctx, sent } = mkCtx({ manager: mkManager({ cancelRun: async () => { throw new Error('boom') } }) })
    orchestrationHandlers.orchestration_run_action(WS, hostClient, { type: 'orchestration_run_action', runId: 'r1', action: 'cancel' }, ctx)
    await tick()
    assert.equal(sent[0].code, 'ORCHESTRATION_ACTION_FAILED')
    assert.equal(sent[0].reason, 'action-failed')
  })

  it('reports "unavailable" when the engine is not wired', async () => {
    const { ctx, sent } = mkCtx({ manager: null })
    orchestrationHandlers.orchestration_run_action(WS, hostClient, { type: 'orchestration_run_action', runId: 'r1', action: 'cancel' }, ctx)
    await tick()
    assert.equal(sent[0].code, 'ORCHESTRATION_ACTION_FAILED')
    assert.equal(sent[0].reason, 'unavailable')
  })
})

// #7138 — the handler↔engine contract. The suite above runs against a fake; these
// two blocks are what make that fake trustworthy.

describe('#7138 orchestration handlers — engine signature conformance', () => {
  it('run_start calls the engine with the shape the engine actually declares', async () => {
    const { ctx, violations } = mkCtx()
    orchestrationHandlers.orchestration_run_start(WS, hostClient, { type: 'orchestration_run_start', preset: 'repo-audit', cwd: REAL_CWD }, ctx)
    await tick()
    assert.deepEqual(violations, [], `run_start diverged from OrchestrationManager: ${violations.join('; ')}`)
  })

  it('run_action calls the engine with the shape the engine actually declares', async () => {
    const { ctx, violations } = mkCtx()
    orchestrationHandlers.orchestration_run_action(WS, hostClient, { type: 'orchestration_run_action', runId: 'r1', action: 'cancel' }, ctx)
    await tick()
    assert.deepEqual(violations, [], `run_action diverged from OrchestrationManager: ${violations.join('; ')}`)
  })

  it('gate_response / annotate / the surveys call the engine with declared shapes', async () => {
    const { ctx, violations } = mkCtx()
    await orchestrationHandlers.orchestration_runs_request(WS, hostClient, { type: 'orchestration_runs_request' }, ctx)
    await orchestrationHandlers.orchestration_run_detail_request(WS, hostClient, { type: 'orchestration_run_detail_request', runId: 'r1' }, ctx)
    orchestrationHandlers.orchestration_gate_response(WS, hostClient, { type: 'orchestration_gate_response', runId: 'r1', gateId: 'g1', decision: 'approve' }, ctx)
    orchestrationHandlers.orchestration_run_annotate(WS, hostClient, { type: 'orchestration_run_annotate', runId: 'r1', verdictQuality: 'good' }, ctx)
    await tick()
    assert.deepEqual(violations, [], `a handler diverged from OrchestrationManager: ${violations.join('; ')}`)
  })

  it('the conformance check itself catches a diverging call (positive control)', async () => {
    // Without this, an assertion that never fires would read as "conforming".
    const violations = []
    const proxied = conformingManager(mkManager(), violations)
    await proxied.startRun({ cwd: '/repo' })          // real signature is startRun(runId)
    assert.equal(violations.length, 1, 'an option bag passed to startRun(runId) must be recorded')
    assert.match(violations[0], /startRun\(\) takes an id/)

    const missing = []
    conformingManager({ nopeNotAMethod: () => {} }, missing).nopeNotAMethod
    assert.match(missing[0] ?? '', /does not exist on OrchestrationManager/)
  })
})

describe('#7138 orchestration handlers — driven against the REAL engine', () => {
  it('run_start mints a real run, acks its runId, and reaches the epic_plan gate', async () => {
    const { mgr, cleanup } = makeOrchestrationHarness()
    try {
      const { ctx, sent } = mkCtx({ manager: mgr })
      const gated = waitFor(mgr, ['gate_opened'])
      orchestrationHandlers.orchestration_run_start(WS, hostClient, {
        type: 'orchestration_run_start', epicPrompt: 'Audit the auth surface', cwd: REAL_CWD, requestId: 'q-start',
      }, ctx)
      await tick()

      assert.equal(sent.length, 1, `expected exactly one reply, got ${JSON.stringify(sent)}`)
      assert.equal(sent[0].type, 'orchestration_action_ack', `expected an ack, got ${JSON.stringify(sent[0])}`)
      assert.equal(sent[0].action, 'start')
      assert.equal(sent[0].requestId, 'q-start')
      assert.match(sent[0].runId, /^run_/, 'the ack carries the newly-minted runId')

      // the ack is not a promise of a *planned* run — the run must actually run
      const { payload } = await gated
      assert.equal(payload.gate.kind, 'epic_plan')
      const runs = await mgr.listRuns()
      assert.equal(runs.length, 1)
      assert.equal(runs[0].runId, sent[0].runId, 'the acked runId is the run the engine is driving')
    } finally {
      cleanup()
    }
  })

  it('the ack does not wait for the planning turn (the dashboard spinner has no timeout)', async () => {
    // A decider that never answers: planning hangs forever. The ack must still land.
    const { mgr, cleanup } = makeOrchestrationHarness({ decide: () => null })
    try {
      const { ctx, sent } = mkCtx({ manager: mgr })
      orchestrationHandlers.orchestration_run_start(WS, hostClient, { type: 'orchestration_run_start', epicPrompt: 'Audit', cwd: REAL_CWD }, ctx)
      await tick()
      assert.equal(sent[0]?.type, 'orchestration_action_ack', `ack must not block on planning, got ${JSON.stringify(sent[0])}`)
    } finally {
      cleanup()
    }
  })

  it('run_action cancel actually cancels the real run', async () => {
    const { mgr, cleanup } = makeOrchestrationHarness()
    try {
      const { ctx, sent } = mkCtx({ manager: mgr })
      const gated = waitFor(mgr, ['gate_opened'])
      orchestrationHandlers.orchestration_run_start(WS, hostClient, { type: 'orchestration_run_start', epicPrompt: 'Audit', cwd: REAL_CWD }, ctx)
      await tick()
      const runId = sent[0].runId
      await gated

      orchestrationHandlers.orchestration_run_action(WS, hostClient, { type: 'orchestration_run_action', runId, action: 'cancel' }, ctx)
      await tick()
      await tick()
      const ack = sent.find((m) => m.type === 'orchestration_action_ack' && m.action === 'cancel')
      assert.ok(ack, `expected a cancel ack, got ${JSON.stringify(sent)}`)
      const snap = mgr.getRunSnapshot(runId)
      assert.equal(snap?.run?.status, 'cancelled', 'the engine really cancelled the run')
    } finally {
      cleanup()
    }
  })

  it('run_start surfaces an engine validation failure instead of a bogus ack', async () => {
    const { mgr, cleanup } = makeOrchestrationHarness()
    try {
      const { ctx, sent } = mkCtx({ manager: mgr })
      // neither preset nor epicPrompt → the engine has no goal to plan from
      orchestrationHandlers.orchestration_run_start(WS, hostClient, { type: 'orchestration_run_start', cwd: REAL_CWD }, ctx)
      await tick()
      assert.equal(sent[0].code, 'ORCHESTRATION_ACTION_FAILED')
      assert.equal(sent[0].reason, 'start-failed')
      assert.equal((await mgr.listRuns()).length, 0, 'a rejected start leaves no run behind')
    } finally {
      cleanup()
    }
  })
})
