import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orchestrationHandlers } from '../src/handlers/orchestration-handlers.js'

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

function mkManager(overrides = {}) {
  return {
    listRuns: async () => [{ runId: 'r1', title: 't', status: 'executing' }],
    getRunSnapshot: async (runId) => (runId === 'r1' ? { seq: 3, run: { runId: 'r1' } } : null),
    startRun: async () => ({ runId: 'run_new' }),
    resolveGate: async () => ({ ok: true }),
    runAction: async () => ({ ok: true }),
    annotate: async () => ({ ok: true }),
    ...overrides,
  }
}

function mkCtx({ enabled = true, manager = mkManager(), cwdAllowlist = null } = {}) {
  const sent = []
  const ctx = {
    transport: { send: (_ws, msg) => sent.push(msg) },
    services: {
      config: {
        features: { orchestration: enabled },
        homeOverride: REAL_HOME,
        ...(cwdAllowlist ? { allowedCwds: cwdAllowlist } : {}),
      },
      orchestrationManager: manager,
    },
  }
  return { ctx, sent }
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
    const { ctx, sent } = mkCtx({ manager: mkManager({ runAction: async () => { throw new Error('boom') } }) })
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
