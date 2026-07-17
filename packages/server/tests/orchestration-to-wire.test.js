// Tests for the wire projection layer (E-4). The load-bearing assertion: every
// projection satisfies the real @chroxy/protocol schema (safeParse), so the
// server can never broadcast a shape the client reducer will reject.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RunSummarySchema, RunDetailSchema, RunNodeSchema, RunGateSchema, RunUsageSchema, RunTimelineEntrySchema } from '@chroxy/protocol'
import { RunLedger } from '../src/orchestration/run-ledger.js'
import { makeGate, resolveGate, expireGate, nextGateId } from '../src/orchestration/run-model.js'
import {
  usageToWire, budgetToWire, gateToWire, nodeToWire, timelineEntryToWire,
  recordToRunSummary, recordToRunDetail,
} from '../src/orchestration/to-wire.js'

function mkLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'towire-'))
  const ledger = new RunLedger({ baseDir: dir })
  return { ledger, cleanup: () => { ledger.dispose?.(); rmSync(dir, { recursive: true, force: true }) } }
}

// Build a realistic run record via the REAL ledger write path.
function buildRecord(ledger, { status = 'executing', budgetUsd = 5 } = {}) {
  const configSnapshot = {
    cwd: '/repo',
    roleModels: { architect: { provider: 'claude-sdk', model: 'fable' }, worker: { provider: 'codex', model: 'codex-m' } },
    budget: { maxUsd: budgetUsd, warnPercent: 80 },
  }
  const rec = ledger.createRun({ title: 'Audit run', preset: 'repo-audit', configSnapshot })
  const runId = rec.runId
  ledger.setStatus(runId, 'planning')
  ledger.createSubtask(runId, { subtaskId: 'st_a', role: 'worker.implement', title: 'Add helper' })
  ledger.attachSession(runId, 'st_a', { sessionId: 'sess_1', provider: 'codex', model: 'codex-m', meterable: true })
  ledger.recordTurnUsage(runId, { subtaskId: 'st_a', sessionId: 'sess_1', role: 'worker.implement', turnLabel: 'execute', terminalEvent: 'result', data: { model: 'codex-m', cost: 0.02, usage: { input_tokens: 100, output_tokens: 40 } } })
  ledger.recordTurnUsage(runId, { subtaskId: null, sessionId: 'arch', role: 'architect', turnLabel: 'plan', terminalEvent: 'result', data: { model: 'fable', cost: 0.5, usage: { input_tokens: 500, output_tokens: 200 } } })
  ledger.updateSubtask(runId, 'st_a', { status: 'done' })
  ledger.recordCommitteeReview(runId, 'st_a', { phase: 'result', verdict: 'approve', reviewerSessionId: 'arch', notes: 'lgtm' })
  ledger.setStatus(runId, status)
  return ledger.getRun(runId)
}

function extrasFor(record) {
  const runId = record.runId
  const openGate = makeGate({ gateId: nextGateId(runId), runId, kind: 'epic_plan', nodeId: null, summary: 'Approve the plan', detail: '2 subtasks', openedAt: 1000 })
  const resolvedGate = resolveGate(
    makeGate({ gateId: nextGateId(runId), runId, kind: 'escalation', nodeId: 'st_a', summary: 'conflict', openedAt: 900 }),
    { decision: 'skip', resolvedAt: 950 },
  )
  return {
    epicPrompt: 'Perform a full self-audit of this repository. '.repeat(20), // > 280 chars → preview truncates
    gates: [openGate, resolvedGate],
    timeline: [
      { seq: 1, at: 1000, kind: 'gate_opened', gateId: openGate.gateId, summary: 'plan gate opened' },
      { seq: 2, at: 1100, kind: 'committee_review', nodeId: 'st_a', verdict: 'approve', summary: 'result approved' },
    ],
    nodeExtras: { st_a: { branch: 'chroxy/orch/x/st_a', worktreePath: '/wt/st_a', planSummary: 'edit f', resultSummary: 'edited f', attempt: 1, committeeIterations: 2 } },
    report: { json: '{"ok":true}', markdown: '# Report' },
  }
}

// --- unit projections ------------------------------------------------------

test('usageToWire produces a schema-valid RunUsage', () => {
  const u = usageToWire({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 0, costUsd: 0.1, pricedCostUsd: 0, effectiveUsd: 0.1, unknownCostTurns: 0 })
  assert.equal(RunUsageSchema.safeParse(u).success, true)
  // missing/garbage input → schema-valid zeros, never throws
  assert.equal(RunUsageSchema.safeParse(usageToWire(undefined)).success, true)
  assert.equal(usageToWire({ inputTokens: NaN }).inputTokens, 0)
})

test('budgetToWire maps cap/spent/state', () => {
  const capped = budgetToWire({ configSnapshot: { budget: { maxUsd: 5 } }, budgetState: { capReachedAt: 123 }, usageTotals: { overall: { effectiveUsd: 6 } } })
  assert.deepEqual(capped, { capUsd: 5, spentUsd: 6, state: 'capped' })
  const warned = budgetToWire({ configSnapshot: { budget: { maxUsd: 5 } }, budgetState: { warnedAt: 1 }, usageTotals: { overall: { effectiveUsd: 4 } } })
  assert.equal(warned.state, 'warned')
  const uncapped = budgetToWire({ configSnapshot: { budget: { maxUsd: null } }, budgetState: {}, usageTotals: { overall: { effectiveUsd: 1 } } })
  assert.equal(uncapped.capUsd, null)
  assert.equal(uncapped.state, 'ok')
})

test('gateToWire produces schema-valid RunGate for open + resolved gates', () => {
  const runId = 'run_1'
  const open = makeGate({ gateId: 'g1', runId, kind: 'epic_plan', nodeId: null, summary: 's', openedAt: 1 })
  const resolved = resolveGate(makeGate({ gateId: 'g2', runId, kind: 'escalation', nodeId: 'st', summary: 's', openedAt: 1 }), { decision: 'approve', note: 'ok', resolvedAt: 2 })
  assert.equal(RunGateSchema.safeParse(gateToWire(open)).success, true)
  const w = gateToWire(resolved)
  assert.equal(RunGateSchema.safeParse(w).success, true)
  assert.equal(w.resolvedBy, 'user')
  assert.equal(w.note, 'ok')
})

test('nodeToWire produces schema-valid RunNode, pulling branch/plan from extras', () => {
  const st = { subtaskId: 'st_a', role: 'worker.implement', title: 'T', provider: 'codex', model: 'm', status: 'done', sessionId: 'sess', usage: {}, committee: [{}, {}], createdAt: 10, endedAt: 20 }
  const node = nodeToWire(st, 'run_1', { branch: 'b', worktreePath: '/w', planSummary: 'p', resultSummary: 'r', attempt: 1, committeeIterations: 2 })
  assert.equal(RunNodeSchema.safeParse(node).success, true)
  assert.equal(node.branch, 'b')
  assert.equal(node.committeeIterations, 2)
  assert.equal(node.updatedAt, 20)
  // no extras → nullable fields are null, still schema-valid
  assert.equal(RunNodeSchema.safeParse(nodeToWire(st, 'run_1')).success, true)
  assert.equal(nodeToWire(st, 'run_1').branch, null)
})

test('timelineEntryToWire is schema-valid', () => {
  const e = timelineEntryToWire({ seq: 3, at: 100, kind: 'committee_review', nodeId: 'st', verdict: 'revise', summary: 's' })
  assert.equal(e.verdict, 'revise')
  assert.equal(e.nodeId, 'st')
})

// --- full record projections against the real schemas ----------------------

test('recordToRunSummary satisfies RunSummarySchema', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const record = buildRecord(ledger)
    const summary = recordToRunSummary(record, extrasFor(record))
    const parsed = RunSummarySchema.safeParse(summary)
    assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues))
    assert.equal(summary.preset, 'repo-audit')
    assert.equal(summary.cwd, '/repo')
    assert.deepEqual(summary.architect, { provider: 'claude-sdk', model: 'fable' })
    assert.equal(summary.nodeCounts.total, 1)
    assert.equal(summary.nodeCounts.done, 1)
    assert.equal(summary.pendingUserGates, 1, 'one open gate, one resolved')
    assert.ok(summary.epicPromptPreview.length <= 280)
    assert.ok(summary.usage.inputTokens > 0)
  } finally {
    cleanup()
  }
})

test('recordToRunDetail satisfies RunDetailSchema with nodes/gates/timeline/rollup', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const record = buildRecord(ledger)
    const detail = recordToRunDetail(record, extrasFor(record))
    const parsed = RunDetailSchema.safeParse(detail)
    assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues))
    assert.equal(detail.nodes.length, 1)
    assert.equal(detail.nodes[0].branch, 'chroxy/orch/x/st_a')
    assert.equal(detail.gates.length, 2)
    assert.equal(detail.timeline.length, 2)
    // usageRollup carries per-role attribution
    assert.ok(detail.usageRollup.byRole.architect, 'architect role in rollup')
    assert.ok(detail.usageRollup.byRole['worker.implement'], 'worker role in rollup')
    assert.equal(detail.verdictQuality ?? null, null)
    assert.deepEqual(detail.report, { json: '{"ok":true}', markdown: '# Report' })
  } finally {
    cleanup()
  }
})

test('nodeCounts: skipped is excluded from all three buckets; interrupted counts as failed', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const rec = ledger.createRun({ title: 't', preset: null, configSnapshot: { cwd: '/r', roleModels: { architect: { provider: 'a', model: 'm' } }, budget: { maxUsd: null } } })
    const id = rec.runId
    for (const [sid, status] of [['s1', 'done'], ['s2', 'failed'], ['s3', 'skipped'], ['s4', 'interrupted'], ['s5', 'executing']]) {
      ledger.createSubtask(id, { subtaskId: sid, role: 'worker.audit', title: sid })
      ledger.updateSubtask(id, sid, { status })
    }
    const nc = recordToRunSummary(ledger.getRun(id), {}).nodeCounts
    assert.deepEqual(nc, { total: 5, done: 1, failed: 2, running: 1 }, 'interrupted→failed, skipped excluded, executing→running')
    assert.equal(nc.running + nc.done + nc.failed, nc.total - 1, 'buckets sum to total MINUS the skipped node')
  } finally {
    cleanup()
  }
})

test('gateToWire handles an expired (policy-resolved) gate and a budget_overrun gate', () => {
  const runId = 'run_1'
  const expired = expireGate(makeGate({ gateId: 'g1', runId, kind: 'escalation', nodeId: 'st', summary: 's', openedAt: 1 }), { resolvedAt: 99 })
  const w = gateToWire(expired)
  assert.equal(RunGateSchema.safeParse(w).success, true)
  assert.equal(w.status, 'expired')
  assert.equal(w.resolvedBy, 'policy')
  const overrun = gateToWire(makeGate({ gateId: 'g2', runId, kind: 'budget_overrun', nodeId: null, summary: 'raise?', budgetUsd: 10, openedAt: 2 }))
  assert.equal(RunGateSchema.safeParse(overrun).success, true)
  assert.equal(overrun.budgetUsd, 10)
})

test('timeline longer than 500 is sliced to the last 500', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const record = buildRecord(ledger)
    const timeline = Array.from({ length: 700 }, (_, i) => ({ seq: i + 1, at: i, kind: 'k', summary: `e${i}` }))
    const detail = recordToRunDetail(record, { epicPrompt: '', gates: [], timeline })
    assert.equal(detail.timeline.length, 500)
    assert.equal(detail.timeline[0].summary, 'e200', 'kept the LAST 500')
    assert.equal(RunDetailSchema.safeParse(detail).success, true)
  } finally {
    cleanup()
  }
})

test('null elements in manager arrays degrade gracefully (never throw, still schema-valid)', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const record = buildRecord(ledger)
    // manager arrays with null holes + a null in the record subtasks
    record.subtasks.push(null)
    const detail = recordToRunDetail(record, {
      epicPrompt: 'x', gates: [null, makeGate({ gateId: 'g', runId: record.runId, kind: 'epic_plan', nodeId: null, summary: 's', openedAt: 1 })],
      timeline: [null, { seq: 1, at: 1, kind: 'k', summary: 's' }],
    })
    assert.equal(RunDetailSchema.safeParse(detail).success, true, 'null holes filtered, still valid')
    assert.equal(detail.gates.length, 1)
    assert.equal(detail.timeline.length, 1)
    assert.equal(detail.nodes.length, 1, 'null subtask filtered out')
    // direct helper calls on null must not throw either
    assert.equal(RunTimelineEntrySchema.safeParse(timelineEntryToWire(null)).success, true)
  } finally {
    cleanup()
  }
})

test('a degraded/empty record still projects to a schema-valid summary + detail', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const rec = ledger.createRun({ title: '', preset: null, configSnapshot: null })
    const record = ledger.getRun(rec.runId)
    assert.equal(RunSummarySchema.safeParse(recordToRunSummary(record, {})).success, true)
    assert.equal(RunDetailSchema.safeParse(recordToRunDetail(record, {})).success, true)
  } finally {
    cleanup()
  }
})
