import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ServerOrchestrationRunDeltaSchema,
  ServerOrchestrationActionAckSchema,
  RUN_STATUS_VALUES,
  RUN_NODE_STATUS_VALUES,
  RUN_GATE_KIND_VALUES,
  COMMITTEE_VERDICT_VALUES,
} from '../src/schemas/server/orchestration.ts'
import { OrchestrationRunActionSchema } from '../src/schemas/client.ts'

// #6691 S-1 — the orchestration wire contract. These pin the canonical enum
// value-arrays (the engine imports them, so a drift is a real contract break)
// and the run-delta runId-consistency refine.

describe('orchestration canonical enums', () => {
  it('expose the run/subtask/gate/verdict value arrays the engine imports', () => {
    assert.ok(RUN_STATUS_VALUES.includes('paused'))
    assert.ok(RUN_STATUS_VALUES.includes('budget_paused'))
    // #6733 — RunSummarySchema.status is a strict z.enum, so a status the engine
    // can journal but the enum omits makes safeParse DROP the whole summary.
    assert.ok(RUN_STATUS_VALUES.includes('resource_paused'))
    assert.ok(RUN_STATUS_VALUES.includes('suspended'))
    assert.ok(RUN_NODE_STATUS_VALUES.includes('escalated'))
    assert.ok(RUN_NODE_STATUS_VALUES.includes('conflict_fixup'))
    assert.deepEqual([...RUN_GATE_KIND_VALUES], ['epic_plan', 'escalation', 'bash_permission', 'budget_overrun'])
    assert.deepEqual([...COMMITTEE_VERDICT_VALUES], ['approve', 'revise', 'redelegate', 'escalate'])
  })
})

describe('ServerOrchestrationRunDeltaSchema runId consistency', () => {
  const base = {
    type: 'orchestration_run_delta',
    runId: 'r1',
    seq: 1,
    generatedAt: '2026-07-16T00:00:00.000Z',
  }
  const node = (runId) => ({
    nodeId: 'n1', runId, title: 't', role: 'worker.audit', provider: null, model: null,
    status: 'pending', attempt: 0, committeeIterations: 0, sessionId: null, worktreePath: null,
    branch: null, planSummary: null, resultSummary: null, createdAt: 1, updatedAt: 1,
  })

  it('accepts a delta with no nested objects', () => {
    assert.equal(ServerOrchestrationRunDeltaSchema.safeParse(base).success, true)
  })

  it('accepts a nested node whose runId matches the delta', () => {
    assert.equal(ServerOrchestrationRunDeltaSchema.safeParse({ ...base, node: node('r1') }).success, true)
  })

  it('rejects a nested node whose runId disagrees with the delta', () => {
    assert.equal(ServerOrchestrationRunDeltaSchema.safeParse({ ...base, node: node('WRONG') }).success, false)
  })
})

// #7140 — the engine has no user-held pause, so the wire must not carry the
// verbs: a client must have no way to send an action the engine cannot serve.
describe('orchestration run actions (#7140)', () => {
  const msg = (action) => ({ type: 'orchestration_run_action', runId: 'r1', action })

  it('accepts cancel (positive control)', () => {
    assert.equal(OrchestrationRunActionSchema.safeParse(msg('cancel')).success, true)
  })

  it('rejects pause and resume', () => {
    assert.equal(OrchestrationRunActionSchema.safeParse(msg('pause')).success, false)
    assert.equal(OrchestrationRunActionSchema.safeParse(msg('resume')).success, false)
  })

  it('the ack never names pause/resume, but still acks cancel', () => {
    const ack = (action) => ServerOrchestrationActionAckSchema.safeParse({ type: 'orchestration_action_ack', action, runId: 'r1' }).success
    assert.equal(ack('cancel'), true)
    assert.equal(ack('pause'), false)
    assert.equal(ack('resume'), false)
  })
})
