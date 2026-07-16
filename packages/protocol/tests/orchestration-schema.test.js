import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ServerOrchestrationRunDeltaSchema,
  RUN_STATUS_VALUES,
  RUN_NODE_STATUS_VALUES,
  RUN_GATE_KIND_VALUES,
  COMMITTEE_VERDICT_VALUES,
} from '../src/schemas/server/orchestration.ts'

// #6691 S-1 — the orchestration wire contract. These pin the canonical enum
// value-arrays (the engine imports them, so a drift is a real contract break)
// and the run-delta runId-consistency refine.

describe('orchestration canonical enums', () => {
  it('expose the run/subtask/gate/verdict value arrays the engine imports', () => {
    assert.ok(RUN_STATUS_VALUES.includes('paused'))
    assert.ok(RUN_STATUS_VALUES.includes('budget_paused'))
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
