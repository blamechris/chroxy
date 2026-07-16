import { describe, it, expect } from 'vitest'
import { upsertRunSummary, applyRunDelta, RUN_TIMELINE_MAX } from './orchestration'
import type { HeldRunDetail } from './orchestration'
import type {
  RunSummary,
  RunDetail,
  RunNode,
  RunGate,
  RunTimelineEntry,
  ServerOrchestrationRunDelta,
} from '@chroxy/protocol'

// #6691 S-1 — the shared runs-list + seq-gapped delta merge. The strict
// `seq === held.seq + 1` contract is the reconnect/late-join safety net: any
// gap forces a snapshot re-request rather than silently applying stale state.

const usageZero = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUsd: 0, pricedCostUsd: 0, effectiveUsd: 0, unknownCostTurns: 0,
}

function summary(runId: string, over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId, title: `run ${runId}`, preset: 'repo-audit', status: 'executing', cwd: '/repo',
    epicPromptPreview: 'audit', architect: { provider: 'claude-sdk', model: 'opus' },
    budget: { capUsd: null, spentUsd: 0, state: 'ok' }, usage: { ...usageZero },
    nodeCounts: { total: 1, running: 1, done: 0, failed: 0 },
    pendingUserGates: 0, createdAt: 1, updatedAt: 1, ...over,
  }
}

function detail(runId: string, seqNodes: RunNode[] = [], over: Partial<RunDetail> = {}): RunDetail {
  return {
    ...summary(runId), epicPrompt: 'full audit', nodes: seqNodes, gates: [], timeline: [],
    usageRollup: { total: { ...usageZero }, byRole: {}, byModel: {} }, meteringGaps: [], ...over,
  }
}

function node(nodeId: string, over: Partial<RunNode> = {}): RunNode {
  return {
    nodeId, runId: 'r1', title: nodeId, role: 'worker.audit', provider: 'claude-sdk', model: 'sonnet',
    status: 'pending', attempt: 0, committeeIterations: 0, sessionId: null, worktreePath: null,
    branch: null, planSummary: null, resultSummary: null, createdAt: 1, updatedAt: 1, ...over,
  }
}

function gate(gateId: string, over: Partial<RunGate> = {}): RunGate {
  return {
    gateId, runId: 'r1', nodeId: null, kind: 'epic_plan', status: 'pending', summary: 'approve plan',
    openedAt: 1, resolvedAt: null, resolvedBy: null, ...over,
  }
}

function tl(seq: number): RunTimelineEntry {
  return { seq, at: seq, kind: 'node_status', summary: `entry ${seq}` }
}

function delta(over: Partial<ServerOrchestrationRunDelta> & { seq: number }): ServerOrchestrationRunDelta {
  return { type: 'orchestration_run_delta', runId: 'r1', generatedAt: '2026-07-16T00:00:00.000Z', ...over }
}

describe('upsertRunSummary', () => {
  it('prepends a new run and replaces an existing one by runId', () => {
    const a = summary('a'), b = summary('b')
    const list = upsertRunSummary([a], b)
    expect(list.map((r) => r.runId)).toEqual(['b', 'a'])
    const updated = upsertRunSummary(list, summary('a', { status: 'completed' }))
    expect(updated.find((r) => r.runId === 'a')!.status).toBe('completed')
    expect(updated).toHaveLength(2)
  })
})

describe('applyRunDelta', () => {
  const held: HeldRunDetail = { detail: detail('r1', [node('n1')]), seq: 5 }

  it('ignores a delta for a run that is not held', () => {
    const r = applyRunDelta({ detail: detail('other'), seq: 5 }, delta({ seq: 6 }))
    expect(r.resync).toBe(false)
    expect(r.held!.detail.runId).toBe('other')
  })

  it('ignores a stale or duplicate seq without resync', () => {
    expect(applyRunDelta(held, delta({ seq: 5 })).resync).toBe(false)
    expect(applyRunDelta(held, delta({ seq: 3 })).resync).toBe(false)
    expect(applyRunDelta(held, delta({ seq: 5 })).held!.seq).toBe(5)
  })

  it('requests resync on a seq gap and leaves held unchanged', () => {
    const r = applyRunDelta(held, delta({ seq: 7 }))
    expect(r.resync).toBe(true)
    expect(r.held).toBe(held)
  })

  it('applies an in-order delta: header, node upsert, gate upsert, timeline append, seq bump', () => {
    const r = applyRunDelta(held, delta({
      seq: 6,
      run: summary('r1', { status: 'completed', pendingUserGates: 2 }),
      node: node('n1', { status: 'done' }),
      gate: gate('g1'),
      timeline: tl(6),
    }))
    expect(r.resync).toBe(false)
    expect(r.held!.seq).toBe(6)
    expect(r.held!.detail.status).toBe('completed')
    expect(r.held!.detail.pendingUserGates).toBe(2)
    expect(r.held!.detail.nodes).toHaveLength(1)
    expect(r.held!.detail.nodes[0].status).toBe('done') // upsert, not append
    expect(r.held!.detail.gates.map((g) => g.gateId)).toEqual(['g1'])
    expect(r.held!.detail.timeline.map((t) => t.seq)).toEqual([6])
    // header spread must not clobber detail-only keys
    expect(r.held!.detail.epicPrompt).toBe('full audit')
  })

  it('appends a new node rather than replacing when nodeId differs', () => {
    const r = applyRunDelta(held, delta({ seq: 6, node: node('n2') }))
    expect(r.held!.detail.nodes.map((n) => n.nodeId)).toEqual(['n1', 'n2'])
  })

  it('bounds the timeline to RUN_TIMELINE_MAX', () => {
    const full = detail('r1', [], { timeline: Array.from({ length: RUN_TIMELINE_MAX }, (_, i) => tl(i)) })
    const r = applyRunDelta({ detail: full, seq: 5 }, delta({ seq: 6, timeline: tl(9999) }))
    expect(r.held!.detail.timeline).toHaveLength(RUN_TIMELINE_MAX)
    expect(r.held!.detail.timeline[RUN_TIMELINE_MAX - 1].seq).toBe(9999)
    expect(r.held!.detail.timeline[0].seq).toBe(1) // oldest (seq 0) evicted
  })

  it('treats a null held as ignore (nothing to merge into)', () => {
    const r = applyRunDelta(null, delta({ seq: 1 }))
    expect(r).toEqual({ held: null, resync: false })
  })
})
